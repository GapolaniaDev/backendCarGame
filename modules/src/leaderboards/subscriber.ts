// RaceCompleted → leaderboard writes (Phase 2.2 in the spec).
//
// Subscribed to the in-process EventBus. For each RaceCompleted event:
//   - For every HUMAN finisher in the session, compute totalMs +
//     bestLapMs + classId + bodyId (re-reading the closed session for
//     loadouts). Bots are filter+ bot (their totalMs is host-attested
//     only, never trusted for time boards).
//   - Compute the confidence outcome: 0 humans → 'server', every human
//     reported → 'quorum', otherwise → 'client' (incomplete_reports).
//   - Apply the confidence rule for time tables:
//       * 'quorum' and 'server' always enter the time tables
//       * 'client' only enters if the mode is 'time_trial' (validated
//         solo runs are accepted even with incomplete reports — flagged
//         in metadata for later review)
//   - Write to:
//       * tt_{track}_{class}_all     (best asc, no reset) — totalMs
//       * tt_{track}_{class}_week    (best asc, Monday reset) — totalMs
//       * lap_{track}_{class}_all    (best asc, no reset) — bestLapMs
//       * wins_week                  (incr desc, Monday reset) — +1
//         for rank-1 finisher, only in quick + ranked modes
//   - Every write is stamped with the server token + a metadata bag
//     carrying car/platform/control/clientVersion/sessionId and the
//     confidence flag.
//
// The subscore is the wall-clock timestamp — used as the secondary
// tiebreaker so that an earlier-set time wins over a later-equal one.

import type { ILogger, INakama } from '../nkruntime';
import type { CarClassId, RaceCompletedEvent } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import { readSession } from '../race/session_repo';
import { computeQuorum } from '../race/ordering';
import type { LeaderboardTableEntry } from './catalog';
import {
  getLapAllTables,
  getLeaderboardTable,
  getTtAllTables,
  getTtWeekTables,
  getWinsWeekTable,
} from './catalog';
import { stampServerToken } from './hooks';

/** Filter a track-wide table list down to a single class. */
export function byClass(tables: LeaderboardTableEntry[], cls: CarClassId): LeaderboardTableEntry[] {
  return tables.filter((t) => t.id.includes(`_${cls}_`));
}

/** Per-write metadata stamped on the leaderboard record. */
export interface LeaderboardWriteMeta {
  car: string;
  platform: string;
  control: string;
  clientVersion: string;
  sessionId: string;
  mode: string;
  confidence: 'quorum' | 'client' | 'server';
  isBot: boolean;
}

const RANKED_MODES = new Set(['ranked']);
const QUICK_MODES = new Set(['quick']);

/** Subscribe the leaderboard writer to the in-process bus. */
export function subscribeLeaderboardWriter(
  logger: ILogger,
  bus: { subscribe: (event: string, handler: (p: unknown) => void | Promise<void>) => void },
  nk: INakama,
): void {
  bus.subscribe(RACE_EVENT_RACE_COMPLETED, async (payload) => {
    try {
      await applyRaceCompletedToLeaderboards(logger, nk, payload as RaceCompletedEvent);
    } catch (e) {
      logger.error(
        'leaderboard writer failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Compute the confidence outcome from the event payload, mirroring the
 * logic in `race/ordering.computeQuorum`. We re-derive here because
 * the RaceCompletedEvent doesn't carry the outcome; the bus subscriber
 * shouldn't have to know about ordering internals to recover the rule.
 */
function deriveConfidence(event: RaceCompletedEvent): 'quorum' | 'client' | 'server' {
  const humanResults = event.results.filter((r) => !r.isBot);
  // 0 humans → 'server'; humansInRoster isn't on the event so we
  // approximate "all reported" by checking needsReview: if the close
  // path set needsReview=false, every roster human reported → 'quorum'.
  // Otherwise fall back to 'client'.
  if (humanResults.length === 0) return 'server';
  if (!event.flags.needsReview) return 'quorum';
  return 'client';
}

export async function applyRaceCompletedToLeaderboards(
  logger: ILogger,
  nk: INakama,
  event: RaceCompletedEvent,
): Promise<void> {
  const confidence = deriveConfidence(event);

  const cur = readSession(nk, event.sessionId);
  if (!cur) {
    logger.warn('leaderboard writer: session %s vanished', event.sessionId);
    return;
  }
  const session = cur.session;

  // For each human finisher, write to the time + lap tables.
  const humanFinishers = session.roster.filter(
    (e) =>
      !e.isBot &&
      e.totalMs !== undefined &&
      e.laps !== undefined &&
      event.results.some((r) => r.userId === e.userId && !r.abandoned),
  );

  if (humanFinishers.length === 0 && event.results.every((r) => r.isBot || r.abandoned)) {
    // Pure bot-only race → no time-table writes (per "Solo bots" semantics;
    // we still emit a wins_week increment if a bot won and the mode
    // permits it — see below).
    logger.debug(
      'leaderboard writer: pure bot race sid=%s — skipping time tables',
      event.sessionId,
    );
  }

  // Confidence gate. 'client' (incomplete_reports) is allowed ONLY
  // when the mode is time_trial.
  const allowTimeTableWrite =
    confidence !== 'client' || event.mode === 'time_trial';

  // Per-finisher writes.
  for (const entry of humanFinishers) {
    if (!entry.totalMs || !entry.laps) continue;
    const totalMs = entry.totalMs;
    const bestLap = entry.laps.reduce((a, b) => (a < b ? a : b), entry.laps[0]!);

    const baseMeta: LeaderboardWriteMeta = {
      car: entry.loadout.bodyId,
      platform: 'unknown',
      control: 'unknown',
      clientVersion: 'unknown',
      sessionId: event.sessionId,
      mode: event.mode,
      confidence,
      isBot: false,
    };

    if (allowTimeTableWrite) {
      // Best time tables (all + week), narrowed to the player's class.
      for (const t of [
        ...byClass(getTtAllTables(event.trackId), entry.loadout.classId),
        ...byClass(getTtWeekTables(event.trackId), entry.loadout.classId),
      ]) {
        if (!getLeaderboardTable(t.id)) continue;
        writeBest(nk, t.id, entry.userId, totalMs, baseMeta);
      }
    }

    // Best lap table (always — the lap itself is best-effort; review
    // metadata captures the confidence flag for audit).
    for (const t of byClass(getLapAllTables(event.trackId), entry.loadout.classId)) {
      if (!getLeaderboardTable(t.id)) continue;
      writeBest(nk, t.id, entry.userId, bestLap, baseMeta);
    }
  }

  // wins_week: increment by 1 for the rank-1 finisher, but only in
  // quick/ranked (per spec). Bots do NOT increment wins_week.
  const winner = event.results.find((r) => r.rank === 1 && !r.abandoned && !r.isBot);
  if (winner && (QUICK_MODES.has(event.mode) || RANKED_MODES.has(event.mode))) {
    const winsTable = getWinsWeekTable();
    if (winsTable) {
      writeIncr(
        nk,
        winsTable.id,
        winner.userId,
        1,
        {
          car: 'unknown',
          platform: 'unknown',
          control: 'unknown',
          clientVersion: 'unknown',
          sessionId: event.sessionId,
          mode: event.mode,
          confidence,
          isBot: false,
        },
        logger,
      );
    }
  }

  logger.info(
    'leaderboards written: sid=%s mode=%s confidence=%s humanFinishers=%d',
    event.sessionId,
    event.mode,
    confidence,
    humanFinishers.length,
  );
}

// ─── Low-level write helpers ────────────────────────────────────────────────

function writeBest(
  nk: INakama,
  tableId: string,
  ownerId: string,
  score: number,
  meta: LeaderboardWriteMeta,
): void {
  nk.leaderboardRecordWrite(
    tableId,
    ownerId,
    /* username */ '',
    score,
    /* subscore */ Date.now(),
    stampServerToken({ ...meta }),
    /* operatorOverride */ undefined,
  );
}

function writeIncr(
  nk: INakama,
  tableId: string,
  ownerId: string,
  delta: number,
  meta: LeaderboardWriteMeta,
  logger: ILogger,
): void {
  try {
    nk.leaderboardRecordWrite(
      tableId,
      ownerId,
      /* username */ '',
      delta,
      /* subscore */ Date.now(),
      stampServerToken({ ...meta }),
      /* operatorOverride */ undefined,
    );
  } catch (e) {
    logger.warn(
      'wins_week write failed for %s: %s',
      ownerId,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// `computeQuorum` is re-exported here for unit tests that want the
// exact semantic the writer relies on, without re-importing from
// race/ordering.
export { computeQuorum };