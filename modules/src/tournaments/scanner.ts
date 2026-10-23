// Phase 8 Chunk 6 — Tournament state machine + close-on-tick.
//
// `runScannerTick` walks every tournament instance and advances the
// lifecycle. The service ticker (scheduler/service_ticker.ts) calls it
// every 60 s — Nakama 3.27 has no setInterval (audit PC-09):
//
//   open ──(now+1h >= endsAt)──► closing
//   closing ──(now >= endsAt)──► closed
//   closed ──(now >= endsAt + 24h)──► deleted
//
// On the open→closing and closing→closed transitions we CAS-update
// the instance row. On the closing→closed transition we additionally
// call `closeTournament`, which runs ONCE per tournament (plan T-23):
//   1. Claims the close with a CAS write: `state: 'closed'` and
//      `closedAt` (kept when already set; it was rewritten every tick).
//   2. Reads the leaderboard and distributes prizes (`distributePrizes`).
//   3. Sends each prize as a CLAIMABLE reward to the single inbox
//      (`sendReward`, id `tournament:{tid}:prize:{uid}:{rank}`): the
//      player collects it with `inbox_claim` (one transaction). A
//      cancelled or voided tournament pays nothing.
//   4. Sets `rewardsDistributed: true`. A crash between 1 and 4 only
//      repeats steps 2-4 on the next tick (the ids make that a no-op).
//
// The scanner is best-effort: every storage call is wrapped in
// try/catch. A failure on one tournament does not stop the loop —
// the next tick will retry.

import type { ILogger, INakama } from '../nkruntime';
import { serverNowMs } from '../core/time';
import { emit } from '../core/admin/analytics';
import { sendReward } from '../liveops/inbox';
import {
  TOURNAMENT_INSTANCES_COLLECTION,
  TOURNAMENT_INSTANCES_SYSTEM_USER,
  readTournamentInstanceRow,
  writeTournamentInstanceCas,
} from './repo';
import {
  distributePrizes,
  type PrizeDistributionRow,
} from './prizes';
import {
  readTournamentLeaderboard,
  deleteLeaderboard,
} from './leaderboard';
import { writeTournamentInstance } from './repo';
import { ensureTournamentsForWindow } from './catalog';
import type { Tournament } from './types';
import { listStorage } from '../core/storage';

/** Retention window after close before GC deletes the row. */
export const TOURNAMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TournamentScannerDeps {
  logger: ILogger;
  nk: INakama;
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
      // Closed and paid: nothing left to do until the retention GC.
      if (t.state === 'closed' && t.rewardsDistributed === true) continue;
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

/**
 * Close `t` once: claim (CAS), prizes to the inbox, mark paid. Returns
 * true when this call did the work, false when another close got there.
 */
function closeTournament(
  nk: INakama,
  logger: ILogger,
  t: Tournament,
  nowUtc: number,
): boolean {
  // 1. Claim the close (or resume one that stopped before paying).
  let claimed: Tournament | null = null;
  for (let attempt = 0; attempt < 3 && claimed === null; attempt++) {
    const row = readTournamentInstanceRow(nk, t.id);
    if (row === null) return false;
    const cur = row.record;
    if (cur.state === 'closed' && cur.rewardsDistributed === true) return false;
    const next: Tournament = { ...cur, state: 'closed', closedAt: cur.closedAt ?? nowUtc };
    try {
      writeTournamentInstanceCas(nk, next, row.version);
      claimed = next;
    } catch (e) {
      logger.debug('tournament close claim retry tid=%s: %s', t.id, e instanceof Error ? e.message : String(e));
    }
  }
  if (claimed === null) {
    logger.warn('tournament close claim lost tid=%s (next tick retries)', t.id);
    return false;
  }

  // 2-3. Prizes (none for a cancelled or voided tournament).
  const lb = readTournamentLeaderboard(nk, t.id);
  const entries = lb === null ? [] : lb.entries;
  const pays = claimed.cancelled !== true && claimed.voided !== true;
  const distributions = pays ? distributePrizes(claimed, entries, nowUtc) : [];
  let granted = 0;
  for (const row of distributions) {
    granted += grantPrizeRow(nk, logger, t.id, row, nowUtc) ? 1 : 0;
  }

  // 4. Mark paid once every prize is in an inbox; otherwise the next tick
  //    resends (idempotent) and keeps `closedAt`.
  if (granted === distributions.length) {
    const row = readTournamentInstanceRow(nk, t.id);
    if (row !== null) {
      try {
        writeTournamentInstanceCas(nk, { ...row.record, rewardsDistributed: true }, row.version);
      } catch (e) {
        logger.warn('tournament paid flag write failed tid=%s: %s', t.id, e instanceof Error ? e.message : String(e));
      }
    }
  }

  logger.info(
    'tournament closed tid=%s entrants=%d prizes=%d granted=%d closedAt=%d',
    t.id, entries.length, distributions.length, granted, claimed.closedAt ?? nowUtc,
  );
  emit(nk, logger, 'tournament_closed', {
    tournamentId: t.id,
    entrants: entries.length,
    prizes: distributions.length,
    granted,
    closedAt: claimed.closedAt ?? nowUtc,
  });
  return true;
}

/** One prize as a claimable inbox reward (idempotent by id). */
function grantPrizeRow(
  nk: INakama,
  logger: ILogger,
  tournamentId: string,
  row: PrizeDistributionRow,
  nowUtc: number,
): boolean {
  const cosmetics = row.rewards.cosmeticId !== undefined ? [row.rewards.cosmeticId] : [];
  try {
    sendReward(
      nk, row.userId, 'tournament_prize',
      {
        ...(row.rewards.coins !== undefined ? { coins: row.rewards.coins } : {}),
        ...(row.rewards.gems !== undefined ? { gems: row.rewards.gems } : {}),
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
 * `admin_tournament_release_prizes` path sends the same claimable reward
 * (id `tournament:{tid}:prize:{uid}:{rank}`, so re-running is a no-op).
 * Returns true when the reward is in the player's inbox.
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
 * Read every instance row. Uses `listStorage` (core/storage.ts).
 */
export function listAllInstances(nk: INakama): Tournament[] {
  const objs = listStorage(nk, {
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
