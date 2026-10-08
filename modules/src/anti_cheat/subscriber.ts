// Phase 8 Chunk 4 — Anti-cheat RaceCompleted subscriber.
//
// Subscribed to the in-process EventBus after missions (P6), ranked
// (P4), and club_week (P7). For each HUMAN finisher in the closed
// race:
//
//   a. If `shouldExcludeFromLeaderboards` returns true, skip silently
//      (the user is already hidden — we still want the analytics
//      counter to skip them too, and Phase 4/7 subscribers do that).
//   b. Read `race_partials/{raceId}` — if present, run
//      `validatePartials` against the track's `minSectionTimeMs`. If
//      absent, skip the partial check (the race route hasn't
//      populated the row yet — separate concern).
//   c. Read `abrupt_history/{userId}` — run `detectAbruptImprovement`
//      against the result's `totalMs`.
//   d. If the race's overall confidence is 'client' (derived from
//      `flags.needsReview`), append a `quorum_disagreement` event to
//      the rolling 7d window. Run `detectQuorumDisagreement`; when it
//      trips, append a `quorum_disagreement` mark.
//   e. Increment `anti_cheat_stats/{utcDate}` per mark appended.
//
// BEST-EFFORT: every storage call is wrapped in try/catch. A failure
// in any step is logged and dropped — the subscriber MUST NEVER
// throw (matching the Phase 4 / 6 / 7 pattern).

import type { ILogger, INakama } from '../nkruntime';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import type { EventBus } from '../core/event_bus';
import { getTrack } from '../core/catalog';
import { serverNowMs, utcDate } from '../core/time';
import { readRacePartials, validatePartials } from './partials';
import { readAbruptHistory, detectAbruptImprovement } from './abrupt_improvement';
import { readRecentQuorumMarks, detectQuorumDisagreement, appendQuorumMark } from './quorum_disagreement';
import {
  appendMark,
  severityForMarkCount,
  type AntiCheatMark,
} from './marks';
import { incrementStats } from './stats';
import { shouldExcludeFromLeaderboards } from './leaderboard_filter';

export interface AntiCheatSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface AntiCheatSubscriberOutcome {
  /** `false` when the race was skipped (no humans, all excluded, etc). */
  processed: boolean;
  /** Per-human side-effect summary. */
  humans: Array<{
    userId: string;
    excluded: boolean;
    partialMark: boolean;
    abruptMark: boolean;
    quorumMark: boolean;
  }>;
  /** Diagnostic reason when `processed=false`. */
  reason: string;
}

const SKIP: AntiCheatSubscriberOutcome = {
  processed: false,
  humans: [],
  reason: 'unknown',
};

/**
 * Bus subscriber entry point. Wrapped in try/catch so a thrown error
 * never propagates out to other subscribers on the same event.
 */
export function subscribeAntiCheat(deps: AntiCheatSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEvent;
      handleRaceCompletedForAntiCheat(deps, event);
    } catch (e) {
      deps.logger.error(
        'anti_cheat subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Pure-ish entry point: applies the 3 anti-cheat checks to every human
 * finisher in a closed race. Public for unit-test driving.
 *
 * Returns an outcome summary so tests can assert per-human effects
 * without introspecting storage directly.
 */
export function handleRaceCompletedForAntiCheat(
  deps: AntiCheatSubscriberDeps,
  raceEvent: RaceCompletedEvent,
): AntiCheatSubscriberOutcome {
  const { logger, nk } = deps;
  const nowUtc = serverNowMs();
  const todayUtc = utcDate(nowUtc);
  const track = safeGetTrack(nk, raceEvent.trackId);
  const partials = safeReadPartials(nk, raceEvent.sessionId);
  const lowConfidenceRace = raceEvent.flags.needsReview;

  const humans = raceEvent.results.filter((r) => !r.isBot);
  if (humans.length === 0) {
    return { ...SKIP, reason: 'no_humans' };
  }

  const outcomes: AntiCheatSubscriberOutcome['humans'] = [];

  for (const r of humans) {
    const userId = r.userId;
    if (userId.length === 0) continue;

    // (a) Hidden user → skip. Their visibility state is unchanged
    //     regardless of this race's outcome.
    if (shouldExcludeFromLeaderboards(nk, userId, nowUtc)) {
      outcomes.push({
        userId, excluded: true, partialMark: false, abruptMark: false, quorumMark: false,
      });
      continue;
    }

    let partialMark = false;
    let abruptMark = false;
    let quorumMark = false;

    // (b) partial_impossible — sector time below floor.
    if (track !== undefined && partials.length >= 2) {
      const v = safeValidatePartials(partials, track.minSectionTimeMs);
      if (v && !v.ok) {
        const mark = buildMark({
          nk,
          userId,
          raceId: raceEvent.sessionId,
          kind: 'partial_impossible',
          detectedAt: nowUtc,
        });
        if (safeAppendMark(nk, userId, mark)) {
          partialMark = true;
          safeIncrementStats(nk, todayUtc, mark);
        }
      }
    }

    // (c) abrupt_improvement — >30% better than median of last 5.
    {
      const history = safeReadAbruptHistory(nk, userId);
      const v = safeDetectAbruptImprovement(history, r.totalMs);
      if (v && !v.ok) {
        const mark = buildMark({
          nk,
          userId,
          raceId: raceEvent.sessionId,
          kind: 'abrupt_improvement',
          detectedAt: nowUtc,
        });
        if (safeAppendMark(nk, userId, mark)) {
          abruptMark = true;
          safeIncrementStats(nk, todayUtc, mark);
        }
      }
    }

    // (d) quorum_disagreement — when the race was low-confidence AND
    //     this human finished in a position with a large gap to the
    //     next participant (heuristic for "submitted time disagrees
    //     with the others"). Each disagreeing race appends ONE mark
    //     to the rolling window; `detectQuorumDisagreement` then
    //     checks if the player has crossed 5 marks in 7d.
    if (lowConfidenceRace && hasLargePositionGap(r, raceEvent.results)) {
      const event: { ts: number; kind: 'quorum_disagreement' } = {
        ts: nowUtc,
        kind: 'quorum_disagreement',
      };
      safeAppendQuorumMark(nk, userId, event);
      const marks = safeReadRecentQuorumMarks(nk, userId);
      const v = safeDetectQuorumDisagreement(marks, nowUtc);
      if (v && !v.ok) {
        const mark = buildMark({
          nk,
          userId,
          raceId: raceEvent.sessionId,
          kind: 'quorum_disagreement',
          detectedAt: nowUtc,
        });
        if (safeAppendMark(nk, userId, mark)) {
          quorumMark = true;
          safeIncrementStats(nk, todayUtc, mark);
        }
      }
    }

    outcomes.push({
      userId, excluded: false, partialMark, abruptMark, quorumMark,
    });
  }

  if (outcomes.length === 0) {
    return { ...SKIP, reason: 'no_valid_humans' };
  }

  const partialHits = outcomes.filter((o) => o.partialMark).length;
  const abruptHits = outcomes.filter((o) => o.abruptMark).length;
  const quorumHits = outcomes.filter((o) => o.quorumMark).length;
  logger.info(
    'anti_cheat sid=%s humans=%d partials=%d abrupt=%d quorum=%d',
    raceEvent.sessionId, outcomes.length, partialHits, abruptHits, quorumHits,
  );

  return { processed: true, reason: 'ok', humans: outcomes };
}

// ─── Helpers (each best-effort — log + skip on failure) ─────────────────────

function safeGetTrack(nk: INakama, trackId: string) {
  try {
    return getTrack(trackId, nk);
  } catch {
    return undefined;
  }
}

function safeReadPartials(nk: INakama, raceId: string) {
  try {
    return readRacePartials(nk, raceId);
  } catch {
    return [];
  }
}

function safeValidatePartials(
  checkpoints: ReadonlyArray<{ index: number; timeMs: number }>,
  minSectionTimeMs: number,
) {
  try {
    return validatePartials(checkpoints, minSectionTimeMs);
  } catch {
    return null;
  }
}

function safeDetectAbruptImprovement(
  history: ReadonlyArray<{ raceId: string; bestTimeMs: number; ts: number }>,
  newTimeMs: number,
) {
  try {
    return detectAbruptImprovement(history, newTimeMs);
  } catch {
    return { ok: true } as ReturnType<typeof detectAbruptImprovement>;
  }
}

function safeReadAbruptHistory(nk: INakama, userId: string) {
  try {
    return readAbruptHistory(nk, userId);
  } catch {
    return [];
  }
}

function safeDetectQuorumDisagreement(
  marks: ReadonlyArray<{ ts: number; kind: 'quorum_disagreement' }>,
  nowUtc: number,
) {
  try {
    return detectQuorumDisagreement(marks, nowUtc);
  } catch {
    return { ok: true } as ReturnType<typeof detectQuorumDisagreement>;
  }
}

function safeReadRecentQuorumMarks(nk: INakama, userId: string) {
  try {
    return readRecentQuorumMarks(nk, userId);
  } catch {
    return [];
  }
}

function safeAppendQuorumMark(
  nk: INakama,
  userId: string,
  event: { ts: number; kind: 'quorum_disagreement' },
): boolean {
  try {
    appendQuorumMark(nk, userId, event);
    return true;
  } catch {
    return false;
  }
}

function safeAppendMark(nk: INakama, userId: string, mark: AntiCheatMark): boolean {
  try {
    appendMark(nk, userId, mark);
    return true;
  } catch {
    return false;
  }
}

function safeIncrementStats(
  nk: INakama,
  utcDateStr: string,
  mark: AntiCheatMark,
): void {
  try {
    incrementStats(nk, utcDateStr, mark);
  } catch {
    /* best-effort */
  }
}

function buildMark(args: {
  nk: INakama;
  userId: string;
  raceId: string;
  kind: AntiCheatMark['kind'];
  detectedAt: number;
}): AntiCheatMark {
  return {
    id: args.nk.uuidv4(),
    userId: args.userId,
    raceId: args.raceId,
    kind: args.kind,
    severity: severityForMarkCount(1), // each detected mark is at least 'low'
    detectedAt: args.detectedAt,
    confirmed: false,
    dismissed: false,
  };
}

/**
 * Returns true when `r`'s rank is at least 3 positions away from the
 * next-closest participant. Heuristic for "submitted time disagrees
 * with the others" — a large position gap implies a time gap large
 * enough to be worth marking. The detector (`detectQuorumDisagreement`)
 * aggregates these events over a 7d rolling window.
 */
function hasLargePositionGap(r: RaceResult, all: ReadonlyArray<RaceResult>): boolean {
  if (r.abandoned) return false;
  // Find the nearest other human finisher (by rank).
  let nearest: RaceResult | null = null;
  for (const other of all) {
    if (other.userId === r.userId) continue;
    if (other.isBot) continue;
    if (other.abandoned) continue;
    if (nearest === null || Math.abs(other.rank - r.rank) < Math.abs(nearest.rank - r.rank)) {
      nearest = other;
    }
  }
  if (nearest === null) return false;
  return Math.abs(nearest.rank - r.rank) >= 3;
}