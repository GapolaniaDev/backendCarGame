// Leaderboard ensure: idempotent table creation at boot.
//
// Iterates the expanded catalog and calls `nk.leaderboardCreate` for
// each table. The create call is INSERT-IF-NOT-EXISTS — if the table
// already exists with the same id, Nakama returns `(created=false)` and
// keeps the existing row. To change config you must delete-then-create,
// which we don't do here because the schema is stable.
//
// Also deletes the deprecated `race_score` table (Phase-2 spec: the
// old client-writable table must not linger).

import type { ILogger, INakama } from '../nkruntime';
import {
  getLeaderboardTables,
  type LeaderboardTableEntry,
} from './catalog';

export interface EnsureSummary {
  created: number;
  existing: number;
  deleted: string[];
  total: number;
}

/**
 * Ensure every table in the leaderboards catalog exists, then delete
 * the deprecated `race_score` table if present. Returns a summary
 * suitable for a single boot log line.
 */
export function ensureLeaderboards(logger: ILogger, nk: INakama): EnsureSummary {
  const tables = getLeaderboardTables();
  const summary: EnsureSummary = {
    created: 0,
    existing: 0,
    deleted: [],
    total: tables.length,
  };

  for (const t of tables) {
    ensureOne(nk, t, summary);
  }

  // Drop the legacy client-writable table. Idempotent — ignore not-found.
  try {
    nk.leaderboardDelete('race_score');
    summary.deleted.push('race_score');
    logger.info('deleted deprecated leaderboard table race_score');
  } catch (e) {
    // The Go runtime throws an exception when the table doesn't exist;
    // swallow that case so a fresh boot is identical to a re-boot.
    logger.debug(
      'race_score delete skipped: %s',
      e instanceof Error ? e.message : String(e),
    );
  }

  logger.info(
    'leaderboards ensured: total=%d created=%d existing=%d deleted=%s',
    summary.total,
    summary.created,
    summary.existing,
    summary.deleted.join(',') || '(none)',
  );
  return summary;
}

function ensureOne(
  nk: INakama,
  t: LeaderboardTableEntry,
  summary: EnsureSummary,
): void {
  const result = nk.leaderboardCreate(
    t.id,
    /* authoritative */ true,
    t.sortOrder,
    t.operator,
    t.resetSchedule,
    { description: t.description, source: t.source },
    /* enableRanks */ true,
  );
  if (result.created) summary.created += 1;
  else summary.existing += 1;
}