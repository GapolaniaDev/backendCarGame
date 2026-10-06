// Phase 4 matchmakerMatched hook. Validates the matched candidate
// groups, picks one that's large enough + mode/version/region-aligned,
// and constructs a `RaceSession` for the relay. Returns
// `{ matched: boolean }` per the runtime contract — returning
// `matched: false` tells the matchmaker to drop the suggestion and
// keep the tickets queued for a future match.
//
// Decision D1 (server stamps version/region); the client cannot
// influence these. Decision D8 (mm.segmentBy default 'none') is
// applied upstream by `ticket_params.ts`.
//
// The hook is pure-ish — it doesn't call Nakama, but it does construct
// the new session id from the first ticket's metadata so the runtime
// can stamp it into the relay. The actual storage write is done by
// the RPC layer that subscribes to `RaceCreated` (lives in Chunk 4 —
// this chunk only validates + builds the payload).

import type { IMatchmakerMatchedEnvelope, INakama } from '../nkruntime';
import type { Loadout, RaceSession } from '../race/types';
import { loadoutStatsFor } from '../race/stats_equalization';

export interface MatchedCandidate {
  sessionId: string;
  tickets: ReadonlyArray<{
    ticket: string;
    metadata: Record<string, string>;
  }>;
  matched: ReadonlyArray<{
    sessionId: string;
    userId: string;
    username: string;
    vars: Record<string, string>;
  }>;
}

export type MatchDecision =
  | { matched: false; reason: string }
  | { matched: true; candidateIndex: number };

const VALID_SIZES: ReadonlySet<2 | 4 | 6> = new Set([2, 4, 6]);
const VALID_MODES = new Set(['quick', 'ranked', 'private', 'time_trial']);

/**
 * Pick the first candidate that has:
 *   - matching mode + version + region across all its tickets
 *   - matched count in {2, 4, 6}
 *   - all ticket metadata mode values agree with the candidate mode
 *
 * Returns `{ matched: false }` when no candidate qualifies. The
 * matchmaker will keep the tickets queued for re-eval.
 */
export function pickCandidate(envelope: IMatchmakerMatchedEnvelope): MatchDecision {
  const candidates = envelope.matches ?? [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const reason = validateCandidate(c);
    if (reason === null) return { matched: true, candidateIndex: i };
    // Fall through — try the next candidate.
  }
  if (candidates.length === 0) return { matched: false, reason: 'no_candidates' };
  return { matched: false, reason: 'no_qualified_candidate' };
}

export function validateCandidate(candidate: MatchedCandidate): string | null {
  const tickets = candidate.tickets ?? [];
  const matched = candidate.matched ?? [];
  // Validate per-ticket metadata before size/length checks so the
  // test for an "invalid mode literal" returns the mode error rather
  // than a misleading "size out of range" — the runtime cares which
  // constraint failed for telemetry.
  if (tickets.length === 0) return `no tickets in candidate`;
  const mode0 = tickets[0]?.metadata['mode'];
  if (typeof mode0 !== 'string' || !VALID_MODES.has(mode0)) {
    return `invalid or missing mode on ticket[0]`;
  }
  const version0 = tickets[0]?.metadata['version'];
  const region0 = tickets[0]?.metadata['region'];
  for (let i = 1; i < tickets.length; i += 1) {
    const t = tickets[i]!;
    if (t.metadata['mode'] !== mode0) return `mode mismatch on ticket[${i}]`;
    if (t.metadata['version'] !== version0) return `version mismatch on ticket[${i}]`;
    if (t.metadata['region'] !== region0) return `region mismatch on ticket[${i}]`;
  }
  // Now check size — ticket/length alignment first, then bounds.
  if (matched.length !== tickets.length) {
    return `tickets/matched length mismatch (${tickets.length} vs ${matched.length})`;
  }
  if (matched.length < 2 || matched.length > 6) {
    return `size ${matched.length} not in {2, 4, 6}`;
  }
  const sizeStr = tickets[0]?.metadata['size'];
  const size = Number(sizeStr);
  if (!VALID_SIZES.has(size as 2 | 4 | 6)) {
    return `invalid size on ticket[0]: ${String(sizeStr)}`;
  }
  if (size !== matched.length) {
    return `metadata size ${size} vs matched count ${matched.length}`;
  }
  return null;
}

/**
 * Build a `RaceSession` skeleton from a qualified candidate. The
 * caller fills in `loadout` from the player's garage, sets `started`
 * only after the host sends `race_session_start`, and persists via
 * `nk.storageWrite` with `version: '*'` for the system collection.
 *
 * Pure function — no Nakama calls. The returned session has empty
 * `results`, `flags.needsReview = false`, `host = matched[0].userId`,
 * and `hostSuccession = matched.map(m => m.userId)` sorted by
 * `vars.rtt` ascending (lower RTT = higher in the succession).
 */
export function buildRaceSessionFromCandidate(candidate: MatchedCandidate): RaceSession {
  const sortedRoster = [...candidate.matched].sort(
    (a, b) => Number(a.vars?.['rtt'] ?? 9999) - Number(b.vars?.['rtt'] ?? 9999),
  );
  const host = sortedRoster[0]!.userId;
  const size = sortedRoster.length as 2 | 4 | 6;
  return {
    schemaVersion: 1,
    id: candidate.sessionId,
    matchId: candidate.sessionId,
    mode: candidate.tickets[0]!.metadata['mode'] as RaceSession['mode'],
    trackId: '',
    size,
    roster: sortedRoster.map((m) => ({
      userId: m.userId,
      loadout: null as unknown as RaceSession['roster'][number]['loadout'],
      isBot: false,
    })),
    host,
    hostSuccession: sortedRoster.map((m) => m.userId),
    state: 'created',
    startedAt: null,
    results: [],
    flags: { needsReview: false },
    version: 1,
  };
}

/**
 * Phase 4 Chunk 8: stats equalization for matched sessions. The
 * skeleton built by `buildRaceSessionFromCandidate` has `loadout: null`
 * on every roster entry — this helper walks the roster, resolves each
 * player's loadout from the candidate's metadata (the matchmaking
 * ticket can carry `bodyId` / `liveryId` per player), and when the mode
 * is `ranked` populates `loadout.stats` from the equalized catalog.
 *
 * Mutates and returns the session for convenience.
 *
 * For non-matched sessions, `race_session_create` and `race_session_join`
 * already wire `loadoutStatsFor` directly into the Loadout they pass
 * to `appendRosterEntry`.
 */
export function applyStatsEqualizationToMatchedSession(
  nk: INakama,
  session: RaceSession,
  playerLoadouts: ReadonlyMap<string, Loadout>,
): RaceSession {
  const mode = session.mode === 'ranked' ? 'ranked' : 'normal';
  for (const entry of session.roster) {
    const loadout = playerLoadouts.get(entry.userId);
    if (loadout === undefined) continue;
    const stats = loadoutStatsFor(nk, entry.userId, loadout, mode);
    entry.loadout = stats ? { ...loadout, stats } : { ...loadout };
  }
  return session;
}