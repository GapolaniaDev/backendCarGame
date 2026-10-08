// Phase 8 Chunk 6 — Tournament state machine + close-on-tick.
//
// A setInterval-driven scanner (default 60s) walks every tournament
// instance and advances the lifecycle:
//
//   open ──(now+1h >= endsAt)──► closing
//   closing ──(now >= endsAt)──► closed
//   closed ──(now >= endsAt + 24h)──► deleted
//
// On the open→closing and closing→closed transitions we CAS-update
// the instance row. On the closing→closed transition we additionally
// call `closeTournament`, which:
//   1. Reads the leaderboard.
//   2. Distributes prizes via `distributePrizes` (pure).
//   3. For each prize: idempotent wallet grant + inbox send.
//   4. Sets `closedAt` and `rewardsDistributed: true` on the row.
//
// The scanner is best-effort: every storage call is wrapped in
// try/catch. A failure on one tournament does not stop the loop —
// the next tick will retry.

import type { ILogger, INakama } from '../nkruntime';
import { serverNowMs } from '../core/time';
import { emit } from '../core/admin/analytics';
import { grant } from '../economy/wallet';
import { sendReward } from '../liveops/inbox';
import { TOURNAMENT_INSTANCES_COLLECTION, TOURNAMENT_INSTANCES_SYSTEM_USER } from './repo';
import {
  distributePrizes,
  type PrizeDistributionRow,
} from './prizes';
import {
  readTournamentLeaderboard,
  deleteLeaderboard,
} from './leaderboard';
import { readTournamentInstance, writeTournamentInstance } from './repo';
import { ensureTournamentsForWindow } from './catalog';
import { rememberTournamentScannerHandle } from './_reset_for_tests';
import type { Tournament } from './types';

/** Default interval — 60s. Lifted to a constant for tests. */
export const TOURNAMENT_SCANNER_INTERVAL_MS = 60_000;

/** Retention window after close before GC deletes the row. */
export const TOURNAMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TournamentScannerHandle {
  stop(): void;
}

export interface TournamentScannerDeps {
  logger: ILogger;
  nk: INakama;
  intervalMs?: number;
}

interface ScannerState {
  intervalId: ReturnType<typeof setInterval> | null;
  running: boolean;
}

let SCANNER_STATE: ScannerState = { intervalId: null, running: false };

/**
 * Start the scanner. Idempotent: a second call while one is running
 * is a no-op. Returns a handle whose `.stop()` clears the interval.
 */
export function startTournamentScanner(deps: TournamentScannerDeps): TournamentScannerHandle {
  if (SCANNER_STATE.running) {
    deps.logger.info('tournament scanner already running — skipping duplicate start');
    return makeHandle();
  }
  const intervalMs = deps.intervalMs ?? TOURNAMENT_SCANNER_INTERVAL_MS;
  // Run one tick immediately so a freshly-booted server catches up
  // on any tournaments that should have closed during downtime.
  try {
    runScannerTick(deps);
  } catch (e) {
    deps.logger.error(
      'tournament scanner initial tick failed: %s',
      e instanceof Error ? e.message : String(e),
    );
  }
  // Nakama 3.27's JS runtime does not expose `setInterval` (the
  // global is `undefined` in the goja VM). We skip the periodic tick
  // when the global is missing — the initial tick above still
  // catches up on downtime, and downstream RPCs can call
  // `runScannerTick` directly for on-demand updates.
  if (typeof setInterval !== 'function') {
    deps.logger.warn(
      'tournament scanner: setInterval not available in this runtime (Nakama 3.27 JS gap); running once at boot only.',
    );
    SCANNER_STATE = { intervalId: null, running: true };
    return makeHandle();
  }
  const intervalId = setInterval(() => {
    try {
      runScannerTick(deps);
    } catch (e) {
      deps.logger.error(
        'tournament scanner tick failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  }, intervalMs);
  SCANNER_STATE = { intervalId, running: true };
  deps.logger.info('tournament scanner started intervalMs=%d', intervalMs);
  const handle = makeHandle();
  rememberTournamentScannerHandle(handle);
  return handle;
}

function makeHandle(): TournamentScannerHandle {
  return {
    stop(): void {
      if (SCANNER_STATE.intervalId !== null) {
        clearInterval(SCANNER_STATE.intervalId);
      }
      SCANNER_STATE = { intervalId: null, running: false };
    },
  };
}

/**
 * One pass: ensure window is materialised, then walk every instance
 * and apply the lifecycle rules. Exposed for unit tests.
 */
export function runScannerTick(deps: TournamentScannerDeps): {
  scanned: number;
  closed: number;
  transitions: number;
  deleted: number;
} {
  const { logger, nk } = deps;
  const nowUtc = serverNowMs();
  // Ensure templates within the 7d window are present so newly
  // materialised instances can transition.
  ensureTournamentsForWindow(nk, nowUtc);

  const instances = listAllInstances(nk);
  let closedCount = 0;
  let transitionCount = 0;
  let deletedCount = 0;

  for (const t of instances) {
    if (isExpiredBeyondRetention(t, nowUtc)) {
      safeDeleteInstance(nk, t.id, logger);
      deletedCount += 1;
      continue;
    }
    if (t.endsAt <= nowUtc) {
      if (closeTournament(nk, logger, t, nowUtc)) {
        closedCount += 1;
        transitionCount += 1;
      }
    } else if (t.endsAt - nowUtc <= 60 * 60 * 1000) {
      if (transitionToClosing(nk, logger, t, nowUtc)) {
        transitionCount += 1;
      }
    }
  }

  if (instances.length > 0) {
    logger.info(
      'tournament scanner tick scanned=%d transitions=%d closed=%d deleted=%d',
      instances.length, transitionCount, closedCount, deletedCount,
    );
  }
  return { scanned: instances.length, closed: closedCount, transitions: transitionCount, deleted: deletedCount };
}

function isExpiredBeyondRetention(t: Tournament, nowUtc: number): boolean {
  if (t.endsAt > nowUtc) return false;
  return nowUtc - t.endsAt >= TOURNAMENT_RETENTION_MS;
}

function transitionToClosing(
  nk: INakama,
  logger: ILogger,
  t: Tournament,
  nowUtc: number,
): boolean {
  // Phase 8 Chunk 7 — persist the state so list/get/join reflect the
  // live transition (not just the time-based inference).
  try {
    if (t.state !== 'closing') {
      const next: Tournament = { ...t, state: 'closing' };
      writeTournamentInstance(nk, next);
    }
  } catch (e) {
    logger.error(
      'tournament transitionToClosing write failed tid=%s: %s',
      t.id, e instanceof Error ? e.message : String(e),
    );
  }
  logger.debug('tournament transitioning to closing tid=%s endsAt=%d', t.id, t.endsAt);
  emit(nk, logger, 'tournament_closing', { tournamentId: t.id, endsAt: t.endsAt, nowUtc });
  return true;
}

function closeTournament(
  nk: INakama,
  logger: ILogger,
  t: Tournament,
  nowUtc: number,
): boolean {
  // Distribute prizes (best-effort). Prizes are idempotent on the
  // `(tournamentId, userId, rank)` triple via the wallet grant's
  // localcache key.
  const lb = readTournamentLeaderboard(nk, t.id);
  const entries = lb === null ? [] : lb.entries;
  const distributions = distributePrizes(t, entries, nowUtc);

  let granted = 0;
  for (const row of distributions) {
    granted += grantPrizeRow(nk, logger, t.id, row, nowUtc) ? 1 : 0;
  }

  // Persist the closed state on the row so re-ticks are idempotent and
  // list/get reflect the transition.
  try {
    if (t.state !== 'closed' || t.closedAt !== nowUtc) {
      const next: Tournament = { ...t, state: 'closed', closedAt: nowUtc };
      writeTournamentInstance(nk, next);
    }
  } catch (e) {
    logger.error(
      'tournament close write failed tid=%s: %s',
      t.id, e instanceof Error ? e.message : String(e),
    );
  }

  logger.info(
    'tournament closed tid=%s entrants=%d prizes=%d granted=%d',
    t.id, entries.length, distributions.length, granted,
  );
  emit(nk, logger, 'tournament_closed', {
    tournamentId: t.id,
    entrants: entries.length,
    prizes: distributions.length,
    granted,
    closedAt: nowUtc,
  });
  return true;
}

function grantPrizeRow(
  nk: INakama,
  logger: ILogger,
  tournamentId: string,
  row: PrizeDistributionRow,
  nowUtc: number,
): boolean {
  // Idempotency key is stable across re-ticks.
  const idempKey = `tournament_prize:${tournamentId}:${row.userId}:${row.rank}`;
  // Cosmetic grants are inbox-only (no wallet grant needed).
  if (row.rewards.coins !== undefined || row.rewards.gems !== undefined) {
    const changeset = {
      ...(row.rewards.coins !== undefined ? { coins: row.rewards.coins } : {}),
      ...(row.rewards.gems !== undefined ? { gems: row.rewards.gems } : {}),
    };
    try {
      grant(
        nk, row.userId, changeset,
        { reason: 'pass', sourceId: `tournament:${tournamentId}` },
        idempKey,
      );
    } catch (e) {
      logger.error(
        'tournament prize grant failed tid=%s uid=%s rank=%d: %s',
        tournamentId, row.userId, row.rank,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }
  // Inbox notification — always sent (even for cosmetic-only tiers
  // so the client knows to refresh its loadout).
  const cosmetics = row.rewards.cosmeticId !== undefined ? [row.rewards.cosmeticId] : [];
  try {
    sendReward(
      nk, row.userId, 'tournament_prize',
      {
        ...(row.rewards.coins !== undefined ? { coins: row.rewards.coins } : {}),
        ...(row.rewards.gems !== undefined ? { coins: 0 } : {}),
        ...(cosmetics.length > 0 ? { cosmetics } : {}),
        note: `Tournament prize: rank ${row.rank}`,
      },
      `tournament:${tournamentId}:prize:${row.userId}:${row.rank}`,
      nowUtc,
    );
  } catch (e) {
    logger.error(
      'tournament prize inbox send failed tid=%s uid=%s rank=%d: %s',
      tournamentId, row.userId, row.rank,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
  return true;
}

/**
 * Public wrapper: re-export the same `grantPrizeRow` so the admin
 * `admin_tournament_release_prizes` path can reuse the idempotent
 * grant + inbox send (idempotency key `tournament_prize:{tid}:{uid}:{rank}`).
 * Returns true when both the wallet grant and inbox send succeeded.
 */
export function grantTournamentPrize(
  nk: INakama,
  logger: ILogger,
  tournamentId: string,
  row: PrizeDistributionRow,
  nowUtc: number,
): boolean {
  return grantPrizeRow(nk, logger, tournamentId, row, nowUtc);
}

function safeDeleteInstance(nk: INakama, templateId: string, logger: ILogger): void {
  try {
    nk.storageDelete([
      {
        collection: TOURNAMENT_INSTANCES_COLLECTION,
        key: templateId,
        userId: TOURNAMENT_INSTANCES_SYSTEM_USER,
      },
    ]);
    deleteLeaderboard(nk, templateId);
    logger.info('tournament deleted (post-retention) tid=%s', templateId);
  } catch (e) {
    logger.error(
      'tournament delete failed tid=%s: %s',
      templateId, e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Read every instance row. Uses `nk.storageList` 1-arg.
 */
export function listAllInstances(nk: INakama): Tournament[] {
  const objs = nk.storageList({
    collection: TOURNAMENT_INSTANCES_COLLECTION,
    limit: 5000,
  });
  const out: Tournament[] = [];
  for (const o of objs.objects) {
    const v = o.value as Partial<Tournament>;
    if (
      v &&
      typeof v === 'object' &&
      v.schemaVersion === 1 &&
      typeof v.id === 'string'
    ) {
      out.push(v as Tournament);
    }
  }
  return out;
}
