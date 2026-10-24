// Phase 4 matchmakerMatched hook helpers. Validates a matched group
// (mode/version/region aligned, size, party intact) and builds the
// `RaceSession` for it. Since plan T-09 (audit 06 f3) the hook in
// `rpcs.ts` converts the 3.27 entries with `candidateFromMatches` and
// persists the session with `createMatchedRaceSession`; Nakama 3.27 gives
// the hook no way to reject a group, so a group that does not qualify
// simply gets no race session.
//
// Decision D1 (server stamps version/region); the client cannot
// influence these. Decision D8 (mm.segmentBy default 'none') is
// applied upstream by `ticket_params.ts`.

import type { ILogger, IMatchmakerMatchedEnvelope, IMatchmakerResult, INakama } from '../nkruntime';
import type { Loadout, RaceSession } from '../race/types';
import { loadoutStatsFor } from '../race/stats_equalization';
import { resolveServerLoadout } from '../race/loadout';
import { activeIndexWrite, createSession } from '../race/session_repo';
import { RACE_SESSIONS_COLLECTION, SYSTEM_USER_ID } from '../race/constants';
import { getTrack, getTracks } from '../core/catalog';
import {
  CLAIM_ATTEMPTS,
  listFreeServers,
  readServer,
  serverClaimWrite,
  type ServerEntry,
} from '../race_servers/registry_repo';
import { pickTrack } from './track_picker';
import { DEDICATED_MAX_COUNT, DEDICATED_MIN_COUNT } from './types';

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
const HOSTING_DEDICATED = 'dedicated';

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

/** `true` when the group asked for a dedicated race server (D-03). */
export function isDedicatedCandidate(candidate: MatchedCandidate): boolean {
  return candidate.tickets?.[0]?.metadata['hosting'] === HOSTING_DEDICATED;
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
    if (t.metadata['hosting'] !== tickets[0]?.metadata['hosting']) return `hosting mismatch on ticket[${i}]`;
  }
  // Now check size — ticket/length alignment first, then bounds.
  if (matched.length !== tickets.length) {
    return `tickets/matched length mismatch (${tickets.length} vs ${matched.length})`;
  }
  // D-03: dedicated-server groups are `quick` only and hold 2..4 players;
  // the other modes keep the 2/4/6 rule below.
  const hosting0 = tickets[0]?.metadata['hosting'];
  if (hosting0 !== undefined) {
    if (hosting0 !== HOSTING_DEDICATED) return `invalid hosting on ticket[0]: ${hosting0}`;
    if (mode0 !== 'quick') return `hosting dedicated requires mode quick (got ${mode0})`;
    if (matched.length < DEDICATED_MIN_COUNT || matched.length > DEDICATED_MAX_COUNT) {
      return `dedicated size ${matched.length} not in [${DEDICATED_MIN_COUNT}, ${DEDICATED_MAX_COUNT}]`;
    }
    return validatePartyGrouping(candidate);
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
  // Phase 7 Chunk 8: party grouping — if any matched entry carries a
  // partyId in vars, every matched entry must share it AND the party
  // size must equal the matched count.
  const partyReason = validatePartyGrouping(candidate);
  if (partyReason !== null) return partyReason;
  return null;
}

/**
 * Phase 7 Chunk 8: when ANY matched entry has a `vars.partyId` field
 * (because the leader queued with a party), require that every matched
 * entry shares the same partyId and that the matched count equals the
 * party's declared size. This is the "keep the party together" rule —
 * without it the matchmaker might split a 4-person party across two
 * sessions of size 2.
 *
 * Returns `null` when no party is involved OR the party is intact.
 */
export function validatePartyGrouping(candidate: MatchedCandidate): string | null {
  const matched = candidate.matched ?? [];
  if (matched.length === 0) return null;
  const firstPartyId = matched[0]?.vars?.['partyId'];
  if (firstPartyId === undefined || firstPartyId === '') return null;
  // Verify every entry shares the same partyId.
  for (let i = 1; i < matched.length; i += 1) {
    const pid = matched[i]?.vars?.['partyId'];
    if (pid !== firstPartyId) {
      return `party split: matched[${i}] has partyId=${String(pid)} vs expected ${firstPartyId}`;
    }
  }
  // Verify the party size matches the matched count.
  const partySizeStr = matched[0]?.vars?.['partySize'];
  if (partySizeStr !== undefined) {
    const expected = Number(partySizeStr);
    if (Number.isFinite(expected) && expected !== matched.length) {
      return `party partial: expected size=${expected} got ${matched.length}`;
    }
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
  // Dedicated groups hold 2..4 players: a group of 3 is stored as size 4 so
  // `size` stays one of the values the rewards tables know.
  const size = (isDedicatedCandidate(candidate)
    ? (sortedRoster.length === 2 ? 2 : 4)
    : sortedRoster.length) as 2 | 4 | 6;
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
 * Plan T-09: turn the 3.27 hook entries (one per matched presence, with
 * the ticket properties) into the candidate shape the validator speaks.
 * Every property is stringified (numeric ticket properties such as `size`
 * arrive as numbers).
 */
export function candidateFromMatches(
  sessionId: string,
  matches: ReadonlyArray<IMatchmakerResult>,
): MatchedCandidate {
  const props = (m: IMatchmakerResult): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.properties ?? {})) out[k] = String(v);
    if (typeof m.partyId === 'string' && m.partyId.length > 0 && out['partyId'] === undefined) {
      out['partyId'] = m.partyId;
    }
    return out;
  };
  return {
    sessionId,
    tickets: matches.map((m) => ({ ticket: '', metadata: props(m) })),
    matched: matches.map((m) => ({
      sessionId: m.presence?.sessionId ?? '',
      userId: m.presence?.userId ?? '',
      username: m.presence?.username ?? '',
      vars: props(m),
    })),
  };
}

/**
 * Plan T-09 (audit 06 f3): create and persist the race session of a
 * validated candidate. The roster is the matched players (host = lowest
 * `rtt`), the track is picked for the mode, each loadout comes from the
 * player's garage (T-10), and every player's active-session index points
 * at the new session (T-08) so each client finds the same race with
 * `race_session_get` without an id. The session waits in `created` for
 * the host's `race_session_start`.
 */
export function createMatchedRaceSession(
  nk: INakama,
  logger: ILogger,
  candidate: MatchedCandidate,
  nowMs: number,
): RaceSession {
  const session = buildRaceSessionFromCandidate(candidate);
  const allowed = getTracks(nk)
    .filter((t) => {
      const laps = (t as { modes?: Record<string, number | undefined> }).modes?.[session.mode];
      return typeof laps === 'number' && laps > 0;
    })
    .map((t) => (t as { id: string }).id);
  session.trackId = pickTrack(allowed, [], session.id);
  if (session.trackId === '') throw new Error(`no track allows mode ${session.mode}`);
  const statsMode = session.mode === 'ranked' ? 'ranked' : 'normal';
  for (const entry of session.roster) {
    entry.loadout = resolveServerLoadout(nk, logger, entry.userId, null, statsMode, 'matchmakerMatched');
  }
  session.createdAt = nowMs;
  const activeFor = session.roster.map((e) => e.userId);
  if (!isDedicatedCandidate(candidate)) {
    createSession(nk, session, activeFor, nowMs);
    return session;
  }
  createDedicatedSession(nk, session, activeFor, nowMs);
  return session;
}

/** No live, free race server could be reserved for a dedicated group (D-06). */
export class NoRaceServerError extends Error {
  constructor(sessionId: string) {
    super(`no free race server for session ${sessionId}`);
    this.name = 'NoRaceServerError';
  }
}

/**
 * D-04: give the session a live, free race server, its `laps` and one join
 * ticket per player, and persist it. The reservation of the server (CAS on
 * its registry row) is committed in the same atomic update as the session
 * and the players' active-session indexes, so a reserved server always has
 * its session and a session never points at a server somebody else holds.
 * When the CAS loses a race the free servers are listed again and the best
 * one is tried, up to `CLAIM_ATTEMPTS` times. Without a free server nothing is written (D-06): the
 * throw is a `NoRaceServerError`. Any other failure is rethrown.
 */
function createDedicatedSession(
  nk: INakama,
  session: RaceSession,
  activeFor: readonly string[],
  nowMs: number,
): void {
  const laps = getTrack(session.trackId, nk)?.modes[session.mode];
  if (typeof laps !== 'number' || laps <= 0) {
    throw new Error(`track ${session.trackId} has no laps for mode ${session.mode}`);
  }
  session.serverHosted = true;
  session.laps = laps;
  for (const entry of session.roster) entry.joinTicket = newJoinTicket(nk);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    // Re-listed on every attempt: a server claimed (or retired) meanwhile is gone, one that
    // only sent a heartbeat is still there with its new version.
    const candidate = listFreeServers(nk, nowMs)[0];
    if (candidate === undefined) break;
    session.server = { serverId: candidate.serverId, host: candidate.record.host, port: candidate.record.port };
    try {
      nk.multiUpdate(
        undefined,
        [
          {
            collection: RACE_SESSIONS_COLLECTION,
            key: session.id,
            userId: SYSTEM_USER_ID,
            value: session as unknown as Record<string, unknown>,
            permissionRead: 0,
            permissionWrite: 0,
          },
          ...activeFor.map((u) => activeIndexWrite(u, session.id, nowMs)),
          serverClaimWrite(candidate, session.id, nowMs),
        ],
        undefined,
        undefined,
        undefined,
      );
      return;
    } catch (e) {
      if (!lostServerRace(nk, candidate)) throw e;
    }
  }
  throw new NoRaceServerError(session.id);
}

/** `true` when the registry row changed since `entry` was read (someone else claimed it or it beat us). */
function lostServerRace(nk: INakama, entry: ServerEntry): boolean {
  const now = readServer(nk, entry.serverId);
  return now === null || now.version !== entry.version;
}

/** 32 hex characters (a uuid without dashes), single use per player. */
function newJoinTicket(nk: INakama): string {
  return nk.uuidv4().replace(/-/g, '');
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