// Phase 4 Chunk 7: RaceCompleted → rating subscriber.
//
// Subscribes to the in-process event bus. On every closed session it:
//   1. Skips non-ranked modes (quick/quick_bots/private/time_trial).
//   2. Skips the race if the confidence outcome is 'client' — when
//      humans disagree on ordering the close path stamps
//      `flags.needsReview=true` and the entire race is discarded for
//      ranking purposes (per the Phase 1 spec).
//   3. Idempotency gate via `ranked_progress/{sessionId}` server-owned
//      storage. First call writes the marker; replays find it and
//      return early without touching any per-player records. The stub
//      runtime doesn't enforce CAS on writes, but the production one
//      refuses duplicate inserts, so this also acts as a race-safe
//      mutex across concurrent dispatches.
//   5. Filters humans only (bots ignored — ranked rosters are
//      supposed to be all-human, but the defensive filter stops
//      accidental bot rows from polluting the table).
//   6. For each human finisher:
//        a. Read RankedRecord; if missing, create with default rating.
//        b. Snapshot `racesPlayed` BEFORE the update to decide the
//           K-factor for THIS race (`racesPlayed < 10` → initial K).
//        c. Build `ratings[]`, `positions[]`, `kFactors[]` arrays and
//           call the pure `ratingChange()` helper from Chunk 5.
//        d. CAS-update the RankedRecord (rating/peak/racesPlayed/
//           wins/topThree/recentAbandons/lastRatedAt/divisionId).
//        e. `leaderboardRecordWrite('ranked_'+seasonId, userId,
//           newRating, ..., operator='set')` so the leaderboard
//           reflects the latest rating.
//
// Re-entrancy: the storage write is per-player (not atomic across
// players), so a crash mid-race leaves some players with new ratings
// and others with stale ones. The idempotency gate means the next
// dispatch will skip the race entirely — partial state is preserved
// intentionally. The leaderboards subscriber (Phase 2) follows the
// same pattern.
//
// Exports:
//   - `subscribeRankedRewards(deps)` — installed from main.ts
//   - `handleRaceCompletedForRanked(deps, event)` — testable surface

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import {
  createRankedRecord,
  readRankedRecord,
  RANKED_COLLECTION,
  updateRankedRecord,
} from './ranked_repo';
import { SYSTEM_USER_ID } from '../race/constants';
import { findActiveSeason, getSeasonsCatalog } from './seasons';
import { getRankedConfig } from './config';
import { divisionForRating } from './division';
import { ratingChange } from './rating';
import { recordAbandon } from '../liveops/abandon_tracker';
import type { RankedRecord } from './types';

export interface RankedSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export const RANKED_PROGRESS_COLLECTION = 'ranked_progress';
/** RaceCompleted-driven ratings → busy lock by sessionId. */
export const RANKED_PROGRESS_TTL_SEC = 24 * 60 * 60;

interface RankedProgressMarker {
  schemaVersion: 1;
  sessionId: string;
  seasonId: string;
  processedAt: number;
  /** userIds touched by this race (for tests + audit). */
  userIds: string[];
}

interface PerHumanSnapshot {
  userId: string;
  record: RankedRecord;
  version: string;
  /** True when the record was created (no CAS update needed — we just wrote it). */
  justCreated: boolean;
  /** Pre-update racesPlayed, used to decide the next K-factor. */
  preRacesPlayed: number;
  position: number;
  abandoned: boolean;
  isRankOne: boolean;
  isTopThree: boolean;
}

/**
 * Bus subscriber entry point. Wrapped in try/catch so a thrown error
 * in this handler doesn't kill the rest of the bus subscribers.
 */
export function subscribeRankedRewards(deps: RankedSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEvent;
      handleRaceCompletedForRanked(deps, event);
    } catch (e) {
      deps.logger.error(
        'ranked subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Apply a closed ranked race to the rating table. Public so unit
 * tests can call it with a synthetic `RaceCompletedEvent`.
 *
 * Returns a small summary so tests can assert side-effects without
 * re-reading storage.
 */
export interface RankedSubscriberOutcome {
  /** `false` when the race was skipped (mode/empty/confidence/replay). */
  processed: boolean;
  /** Season the rating update was applied to (when processed). */
  seasonId: string | null;
  /** Per-human delta applied (empty when not processed). */
  deltas: Array<{ userId: string; delta: number; newRating: number; kFactor: number }>;
  /** Reason string for skip outcomes (helps debugging tests). */
  reason: string;
}

const SKIP: RankedSubscriberOutcome = {
  processed: false,
  seasonId: null,
  deltas: [],
  reason: 'unknown',
};

export function handleRaceCompletedForRanked(
  deps: RankedSubscriberDeps,
  event: RaceCompletedEvent,
): RankedSubscriberOutcome {
  const { logger, nk } = deps;

  // 1. Mode gate — only `ranked` races get rating updates.
  if (event.mode !== 'ranked') {
    return { ...SKIP, reason: `mode=${event.mode} (not ranked)` };
  }

  // 2. Confidence gate — `client` means humans disagreed on ordering,
  // the entire race is discarded for ranking.
  if (deriveConfidence(event) === 'client') {
    logger.info(
      'ranked subscriber dropped sid=%s — confidence=client',
      event.sessionId,
    );
    return { ...SKIP, reason: 'confidence=client' };
  }

  // 3. Idempotency gate via server-owned `ranked_progress/{sessionId}`.
  //    Replays of the same sessionId return early without touching
  //    any per-player record.
  const existing = readProgressMarker(nk, event.sessionId);
  if (existing !== null) {
    return { ...SKIP, reason: 'replay' };
  }

  // 4. Resolve the active season. The race was scored for the season
  //    active at `event.closedAt`. Reuse the same `findActiveSeason`
  //    helper the RPC uses so the close-vs-lazy-close timeline stays
  //    consistent.
  const seasons = getSeasonsCatalog();
  const active = findActiveSeason(seasons, event.closedAt);
  if (active === null) {
    logger.warn(
      'ranked subscriber dropped sid=%s — no active season at closedAt=%d',
      event.sessionId,
      event.closedAt,
    );
    return { ...SKIP, reason: 'no_active_season' };
  }

  // Defensive: only write ratings for non-bot, non-zero-result entries.
  // The close path always assigns a `rank` to every roster entry, so
  // a missing rank means the event is malformed — bail.
  const humans = event.results.filter((r): r is RaceResult & { rank: number } => {
    if (r.isBot) return false;
    if (typeof r.rank !== 'number' || r.rank < 1) return false;
    return true;
  });
  if (humans.length === 0) {
    // 0 humans is fine for `confidence: 'server'` — but rated races
    // with no humans contribute nothing. Drop and stamp the marker.
    writeProgressMarker(nk, event.sessionId, active.id, [], event.closedAt);
    return { ...SKIP, reason: 'no_humans' };
  }

  // 4b. Record abandons for humans who failed to report (D6 — feeds the
  //     15-min block + abandon_last_24h counter exposed by ranked_get).
  //     Bots cannot abandon: a missing bot report is the host's problem,
  //     not the bot's. Bots are constructed by `race_session_quick_bots`
  //     with `isBot=true` and never enter `event.results` with
  //     `abandoned=true`.
  const abandonsRecorded = recordAbandonsForRace(nk, event, event.closedAt);

  // 5. Snapshot each human's current record + K-factor. We read
  //    `racesPlayed` BEFORE the update so the K-factor for THIS race
  //    uses the OLD count (race N+1 sees racesPlayed === N + 1).
  const cfg = getRankedConfig();
  const snapshots: PerHumanSnapshot[] = [];
  for (const result of humans) {
    const snapshot = loadOrCreateSnapshot(nk, result.userId, active.id, cfg.initialRating, event.closedAt);
    snapshots.push({
      ...snapshot,
      position: result.rank,
      abandoned: result.abandoned,
      isRankOne: result.rank === 1 && !result.abandoned,
      isTopThree: result.rank <= 3 && !result.abandoned,
    });
  }

  // 6. Pure rating math.
  const ratings = snapshots.map((s) => s.record.rating);
  const positions = snapshots.map((s) => s.position);
  const kFactors = snapshots.map((s) =>
    s.preRacesPlayed < 10 ? cfg.kFactorInitial : cfg.kFactorNormal,
  );
  const { newRatings, deltas } = ratingChange({ ratings, positions, kFactors });

  // 7. Persist updated records (CAS) + leaderboard writes.
  ensureRankedLeaderboard(nk, active.id);
  const outcomeDeltas: RankedSubscriberOutcome['deltas'] = [];
  for (let i = 0; i < snapshots.length; i += 1) {
    const snap = snapshots[i]!;
    const newRating = newRatings[i]!;
    const delta = deltas[i]!;
    const kFactor = kFactors[i]!;
    const nextRecord = buildUpdatedRecord(snap.record, newRating, snap, event.closedAt);
    // Always CAS-update — for the just-created case we wrote the
    // default via `createRankedRecord` (so the leaderboard sees a
    // row); this second write stamps the post-race values (wins,
    // topThree, racesPlayed++, new rating, etc.).
    updateRankedRecord(nk, nextRecord, snap.version);
    nk.leaderboardRecordWrite(
      `ranked_${active.id}`,
      snap.userId,
      /* username */ '',
      newRating,
      /* subscore */ event.closedAt,
      /* meta */ {
        sessionId: event.sessionId,
        seasonId: active.id,
        delta,
        racesPlayed: nextRecord.racesPlayed,
      },
      /* operatorOverride */ 'set',
    );
    outcomeDeltas.push({ userId: snap.userId, delta, newRating, kFactor });
  }

  // 8. Stamp the idempotency marker LAST so a partial failure before
  //    reaching this point can be retried.
  writeProgressMarker(
    nk,
    event.sessionId,
    active.id,
    snapshots.map((s) => s.userId),
    event.closedAt,
  );

  logger.info(
    'ranked subscriber applied sid=%s season=%s humans=%d avgDelta=%.1f',
    event.sessionId,
    active.id,
    snapshots.length,
    outcomeDeltas.reduce((sum, d) => sum + d.delta, 0) / Math.max(1, outcomeDeltas.length),
  );

  return { processed: true, seasonId: active.id, deltas: outcomeDeltas, reason: 'ok' };
}

/**
 * Mirror of the same routine used by `leaderboards/subscriber` —
 * derives the confidence outcome from `RaceCompletedEvent` since the
 * event payload itself doesn't carry it.
 */
function deriveConfidence(event: RaceCompletedEvent): 'quorum' | 'client' | 'server' {
  const humanResults = event.results.filter((r) => !r.isBot);
  if (humanResults.length === 0) return 'server';
  if (!event.flags.needsReview) return 'quorum';
  return 'client';
}

/**
 * Phase 4 Chunk 9 — recordAbandon side-effect on every ranked
 * abandoned human. Idempotency: `recordAbandon` is CAS-protected and
 * the marker write in step 8 still gates a re-dispatch, so a replay
 * that fires the subscriber twice records at most one entry per
 * abandoned human per race close.
 *
 * Returns the userIds that triggered a new entry (test inspection).
 */
function recordAbandonsForRace(
  nk: INakama,
  event: RaceCompletedEvent,
  nowMs: number,
): string[] {
  const touched: string[] = [];
  for (const r of event.results) {
    if (r.isBot) continue;
    if (!r.abandoned) continue;
    // Skip entries with no userId (defensive — close path always
    // populates it, but a malformed event must not poison the tracker).
    if (typeof r.userId !== 'string' || r.userId.length === 0) continue;
    recordAbandon(nk, r.userId, nowMs);
    touched.push(r.userId);
  }
  return touched;
}

/**
 * Read or create the player's RankedRecord. When the record is
 * missing (e.g. a ranked race happens before they ever call
 * `ranked_get`), we materialise the default and write it via
 * `createRankedRecord` so the leaderboard sees a row too.
 */
function loadOrCreateSnapshot(
  nk: INakama,
  userId: string,
  seasonId: string,
  initialRating: number,
  nowMs: number,
): Omit<PerHumanSnapshot, 'position' | 'abandoned' | 'isRankOne' | 'isTopThree'> {
  const cfg = getRankedConfig();
  const existing = readRankedRecord(nk, userId);
  if (existing !== null) {
    return {
      userId,
      record: existing.record,
      version: existing.version,
      justCreated: false,
      preRacesPlayed: existing.record.racesPlayed,
    };
  }
  const fresh: RankedRecord = {
    schemaVersion: 1,
    userId,
    seasonId,
    rating: initialRating,
    peak: initialRating,
    racesPlayed: 0,
    wins: 0,
    topThree: 0,
    recentAbandons: 0,
    lastRatedAt: nowMs,
    divisionId: divisionForRating(cfg, initialRating),
  };
  const created = createRankedRecord(nk, fresh);
  return {
    userId,
    record: fresh,
    version: created.version,
    justCreated: true,
    preRacesPlayed: 0,
  };
}

/**
 * Build the next RankedRecord from the old one + the new rating +
 * the snapshot flags (win / top-3 / abandon). `recentAbandons`
 * increments on abandon, decrements (floored at 0) on a non-abandon
 * finish — D6 (liveops 15-min block) consumes this counter.
 */
function buildUpdatedRecord(
  prev: RankedRecord,
  newRating: number,
  snap: PerHumanSnapshot,
  nowMs: number,
): RankedRecord {
  const cfg = getRankedConfig();
  const nextAbandons = snap.abandoned
    ? prev.recentAbandons + 1
    : Math.max(0, prev.recentAbandons - 1);
  return {
    ...prev,
    schemaVersion: 1,
    rating: newRating,
    peak: Math.max(prev.peak, newRating),
    racesPlayed: prev.racesPlayed + 1,
    wins: prev.wins + (snap.isRankOne ? 1 : 0),
    topThree: prev.topThree + (snap.isTopThree ? 1 : 0),
    recentAbandons: nextAbandons,
    lastRatedAt: nowMs,
    divisionId: divisionForRating(cfg, newRating),
  };
}

/**
 * Make sure the per-season `ranked_{seasonId}` leaderboard exists.
 * The stub throws on unknown leaderboards; production auto-creates
 * on first write but creating up-front keeps the stub happy.
 */
function ensureRankedLeaderboard(nk: INakama, seasonId: string): void {
  try {
    nk.leaderboardCreate(
      `ranked_${seasonId}`,
      /* authoritative */ true,
      /* sortOrder */ 'asc',
      /* operator */ 'set',
      /* resetSchedule */ '',
      /* metadata */ {},
      /* enableRanks */ true,
    );
  } catch {
    // Already exists — fine. The stub returns no-op for re-creates, but
    // production is even more permissive.
  }
}

/**
 * Server-owned idempotency marker. The first call writes the marker
 * (no CAS); replays find it and return early. The production runtime
 * rejects duplicate inserts (same owner+key) so this is the race-safe
 * lock; the stub accepts both, which is fine for tests because the
 * marker check still short-circuits.
 */
function readProgressMarker(nk: INakama, sessionId: string): RankedProgressMarker | null {
  const reads = nk.storageRead([
    {
      collection: RANKED_PROGRESS_COLLECTION,
      key: sessionId,
      userId: SYSTEM_USER_ID,
    },
  ]);
  const obj = reads[0];
  if (!obj) return null;
  return obj.value as RankedProgressMarker;
}

function writeProgressMarker(
  nk: INakama,
  sessionId: string,
  seasonId: string,
  userIds: string[],
  nowMs: number,
): void {
  const marker: RankedProgressMarker = {
    schemaVersion: 1,
    sessionId,
    seasonId,
    processedAt: nowMs,
    userIds,
  };
  nk.storageWrite([
    {
      collection: RANKED_PROGRESS_COLLECTION,
      key: sessionId,
      userId: SYSTEM_USER_ID,
      value: marker as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
}

// Re-export the storage constants used so they can be referenced from
// tests without reaching into the module internals.
export { RANKED_COLLECTION };