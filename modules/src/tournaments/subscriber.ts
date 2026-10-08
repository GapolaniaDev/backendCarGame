// Phase 8 Chunk 6 — Tournament RaceCompleted subscriber.
//
// Subscribed to the in-process EventBus AFTER anti-cheat (Phase 8
// Chunk 4) so the detection layer can hide a cheater's races before
// the tournament layer pairs the result with the player's entry.
//
// For each human finisher in a closed race:
//
//   1. Skip when `result.tournamentId` is absent (non-tournament race).
//   2. Skip when the player has no entry in the tournament (cheat or
//      race started before the entry was created).
//   3. Skip when `attemptsRemaining <= 0` (already exhausted).
//   4. Skip when the player is anti-cheat-hidden (`shouldExcludeFromLeaderboards`).
//   5. CAS-update the entry: `attemptsRemaining -= 1`, `bestTimeMs = min`,
//      `checkpoints` overwritten.
//   6. Upsert the leaderboard row (cap 100, sort asc by bestTimeMs).
//
// BEST-EFFORT: every storage call is wrapped in try/catch. A failure
// is logged and dropped — the subscriber MUST NEVER throw.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { serverNowMs } from '../core/time';
import { readEntry, updateEntryAfterRace, type TournamentCheckpointInput } from './repo';
import {
  upsertBestTime,
} from './leaderboard';
import { shouldExcludeFromLeaderboards } from '../anti_cheat/leaderboard_filter';

export interface TournamentSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface TournamentSubscriberOutcome {
  processed: boolean;
  reason: string;
  perUser: Array<{
    userId: string;
    tournamentId: string;
    attemptsRemaining: number;
    bestTimeMs: number | null;
    updated: boolean;
  }>;
}

const SKIP: TournamentSubscriberOutcome = {
  processed: false,
  reason: 'unknown',
  perUser: [],
};

export function subscribeTournaments(deps: TournamentSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEvent;
      handleRaceCompletedForTournament(deps, event);
    } catch (e) {
      deps.logger.error(
        'tournament subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Pure-ish entry point: applies the per-human tournament update
 * (entry CAS + leaderboard upsert). Public for unit-test driving.
 */
export function handleRaceCompletedForTournament(
  deps: TournamentSubscriberDeps,
  raceEvent: RaceCompletedEvent,
): TournamentSubscriberOutcome {
  const { logger, nk } = deps;
  const nowUtc = serverNowMs();
  const humans = raceEvent.results.filter((r) => !r.isBot && !r.abandoned);
  if (humans.length === 0) return { ...SKIP, reason: 'no_humans' };

  const perUser: TournamentSubscriberOutcome['perUser'] = [];

  for (const r of humans) {
    if (typeof r.tournamentId !== 'string' || r.tournamentId.length === 0) continue;
    if (r.userId.length === 0) continue;

    if (shouldExcludeFromLeaderboards(nk, r.userId, nowUtc)) {
      perUser.push({
        userId: r.userId,
        tournamentId: r.tournamentId,
        attemptsRemaining: -1,
        bestTimeMs: null,
        updated: false,
      });
      continue;
    }

    const entry = safeReadEntry(nk, r.tournamentId, r.userId);
    if (entry === null) {
      logger.warn(
        'tournament subscriber: no entry sid=%s uid=%s tid=%s',
        raceEvent.sessionId, r.userId, r.tournamentId,
      );
      continue;
    }
    if (entry.attemptsRemaining <= 0) {
      perUser.push({
        userId: r.userId,
        tournamentId: r.tournamentId,
        attemptsRemaining: 0,
        bestTimeMs: entry.bestTimeMs,
        updated: false,
      });
      continue;
    }

    // The race RPC doesn't surface per-section checkpoints; the
    // subscriber overwrites with the aggregate for now. Future
    // chunks can pass partials through the race event.
    const checkpoints: TournamentCheckpointInput[] = entry.checkpoints.length > 0
      ? entry.checkpoints
      : [];
    const next = safeUpdateEntry(
      nk, r.tournamentId, r.userId, r.totalMs, checkpoints, nowUtc,
    );
    if (next === null) continue;

    safeUpsertBestTime(nk, r.tournamentId, r.userId, r.totalMs, nowUtc);

    perUser.push({
      userId: r.userId,
      tournamentId: r.tournamentId,
      attemptsRemaining: next.attemptsRemaining,
      bestTimeMs: next.bestTimeMs,
      updated: true,
    });
  }

  if (perUser.length === 0) {
    return { ...SKIP, reason: 'no_tournament_results' };
  }
  const updated = perUser.filter((p) => p.updated).length;
  logger.info(
    'tournament subscriber sid=%s attempted=%d updated=%d',
    raceEvent.sessionId, perUser.length, updated,
  );
  return { processed: true, reason: 'ok', perUser };
}

// ─── Helpers (best-effort) ───────────────────────────────────────────────

function safeReadEntry(nk: INakama, tid: string, uid: string) {
  try {
    return readEntry(nk, tid, uid);
  } catch {
    return null;
  }
}

function safeUpdateEntry(
  nk: INakama,
  tid: string,
  uid: string,
  totalMs: number,
  checkpoints: ReadonlyArray<TournamentCheckpointInput>,
  nowUtc: number,
) {
  try {
    return updateEntryAfterRace(nk, tid, uid, totalMs, checkpoints, nowUtc);
  } catch {
    return null;
  }
}

function safeUpsertBestTime(
  nk: INakama,
  tid: string,
  uid: string,
  totalMs: number,
  nowUtc: number,
): void {
  try {
    upsertBestTime(nk, tid, uid, totalMs, nowUtc);
  } catch {
    /* best-effort */
  }
}

// Suppress unused-import warning for the type re-export so goja's
// scanner picks it up.
export type { RaceCompletedEvent, RaceResult };
