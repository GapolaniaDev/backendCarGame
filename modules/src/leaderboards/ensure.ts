// Leaderboard ensure: idempotent table creation at boot.
//
// Iterates the expanded catalog and makes every table exist with the
// sort order and operator the catalog declares. `nk.leaderboardCreate`
// is INSERT-IF-NOT-EXISTS: it never changes an existing table, so a
// table created with another order (the ranked table used to be `asc`,
// audit 06 f4) keeps it forever. At boot such a table is deleted and
// created again, which drops its records (plan R-02: accepted, there
// are no real players yet); every recreation is logged at warn level.
//
// Also deletes the deprecated `race_score` table (Phase-2 spec: the
// old client-writable table must not linger).

import type { ILeaderboardInfo, ILogger, INakama } from '../nkruntime';
import {
  getLeaderboardTables,
  type LeaderboardOperator,
  type LeaderboardTableEntry,
} from './catalog';

export interface EnsureSummary {
  created: number;
  existing: number;
  /** Tables deleted and created again because their order or operator differed. */
  recreated: string[];
  deleted: string[];
  total: number;
}

/** 3.27 `leaderboardsGetId` reports the sort order as a number. */
const SORT_ORDER_NUMBER = { asc: 0, desc: 1 } as const;
/** 3.27 `leaderboardsGetId` reports the operator by its proto name, lower-cased. */
const OPERATOR_NAME: Record<LeaderboardOperator, string> = {
  best: 'best',
  set: 'set',
  incr: 'increment',
  decr: 'decrement',
};

export interface EnsureTableOptions {
  /** Delete and create again a table whose order or operator differs (boot only). */
  recreateOnMismatch: boolean;
}

export type EnsureTableOutcome = 'created' | 'existing' | 'recreated' | 'mismatch';

/**
 * Ensure every table in the leaderboards catalog (plus `extra`, e.g.
 * the active season's ranked table) exists with the catalog's order
 * and operator, then delete the deprecated `race_score` table if
 * present. Returns a summary suitable for a single boot log line.
 */
export function ensureLeaderboards(
  logger: ILogger,
  nk: INakama,
  extra: ReadonlyArray<LeaderboardTableEntry> = [],
): EnsureSummary {
  const tables = [...getLeaderboardTables(), ...extra];
  const summary: EnsureSummary = {
    created: 0,
    existing: 0,
    recreated: [],
    deleted: [],
    total: tables.length,
  };

  const current = readDefinitions(nk, tables.map((t) => t.id));
  for (const t of tables) {
    const outcome = ensureWith(logger, nk, t, current.get(t.id), { recreateOnMismatch: true });
    if (outcome === 'created') summary.created += 1;
    else if (outcome === 'recreated') summary.recreated.push(t.id);
    else summary.existing += 1;
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
    'leaderboards ensured: total=%d created=%d existing=%d recreated=%s deleted=%s',
    summary.total,
    summary.created,
    summary.existing,
    summary.recreated.join(',') || '(none)',
    summary.deleted.join(',') || '(none)',
  );
  return summary;
}

/**
 * Ensure one table. Outside boot (`recreateOnMismatch: false`) a table
 * with another order is left as it is and reported as `mismatch`, so a
 * running server never drops records in the middle of play.
 */
export function ensureLeaderboardTable(
  logger: ILogger,
  nk: INakama,
  t: LeaderboardTableEntry,
  opts: EnsureTableOptions,
): EnsureTableOutcome {
  return ensureWith(logger, nk, t, readDefinitions(nk, [t.id]).get(t.id), opts);
}

function ensureWith(
  logger: ILogger,
  nk: INakama,
  t: LeaderboardTableEntry,
  current: ILeaderboardInfo | undefined,
  opts: EnsureTableOptions,
): EnsureTableOutcome {
  if (current === undefined) {
    create(nk, t);
    return 'created';
  }
  const wantOrder = SORT_ORDER_NUMBER[t.sortOrder];
  const wantOperator = OPERATOR_NAME[t.operator];
  if (current.sortOrder === wantOrder && current.operator === wantOperator) {
    return 'existing';
  }
  const found = `sortOrder=${String(current.sortOrder)} operator=${String(current.operator)}`;
  if (!opts.recreateOnMismatch) {
    logger.warn(
      'leaderboard %s differs from the catalog (%s, want %s/%s); left as is until the next boot',
      t.id,
      found,
      t.sortOrder,
      t.operator,
    );
    return 'mismatch';
  }
  logger.warn(
    'leaderboard %s recreated: found %s, catalog wants %s/%s; its records are dropped (plan R-02)',
    t.id,
    found,
    t.sortOrder,
    t.operator,
  );
  nk.leaderboardDelete(t.id);
  create(nk, t);
  return 'recreated';
}

function create(nk: INakama, t: LeaderboardTableEntry): void {
  nk.leaderboardCreate(
    t.id,
    /* authoritative */ true,
    t.sortOrder,
    t.operator,
    t.resetSchedule,
    { description: t.description, source: t.source },
    /* enableRanks */ true,
  );
}

function readDefinitions(nk: INakama, ids: string[]): Map<string, ILeaderboardInfo> {
  const out = new Map<string, ILeaderboardInfo>();
  for (const info of nk.leaderboardsGetId(ids) ?? []) out.set(info.id, info);
  return out;
}
