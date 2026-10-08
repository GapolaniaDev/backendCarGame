// Phase 8 Chunk 3 — Per-day anti-cheat stats aggregate.
//
// `anti_cheat_stats/{utcDate}` — system-owned, R=1/W=0 (server-only).
// Lazy-created by `incrementStats` on the first mark of the day. The
// stats row is a rolling 1-day snapshot — nothing here persists past
// the cron window; if we ever need 30-day retention, that's a separate
// cron (out of scope).

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';
import type { MarkKind } from './types';
import type { AntiCheatMark } from './marks';

/** Storage collection for daily anti-cheat stats. */
export const ANTI_CHEAT_STATS_COLLECTION = 'anti_cheat_stats';

/** Sentinel owner for stats rows. */
export const ANTI_CHEAT_STATS_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** Counts of marks per detection kind. */
export interface MarksByKind {
  partial_impossible: number;
  abrupt_improvement: number;
  quorum_disagreement: number;
}

/** Counts of marks per severity ladder rung. */
export interface MarksBySeverity {
  low: number;
  medium: number;
  high: number;
}

/** Single-day aggregate. */
export interface DailyAntiCheatStats {
  schemaVersion: 1;
  utcDate: string;
  marksTotal: number;
  marksByKind: MarksByKind;
  marksBySeverity: MarksBySeverity;
  usersHidden: number;
  usersConfirmed: number;
}

/** Construct an empty stats row for the given UTC date. */
export function emptyStats(utcDate: string): DailyAntiCheatStats {
  return {
    schemaVersion: 1,
    utcDate,
    marksTotal: 0,
    marksByKind: {
      partial_impossible: 0,
      abrupt_improvement: 0,
      quorum_disagreement: 0,
    },
    marksBySeverity: { low: 0, medium: 0, high: 0 },
    usersHidden: 0,
    usersConfirmed: 0,
  };
}

function emptyByKind(): MarksByKind {
  return { partial_impossible: 0, abrupt_improvement: 0, quorum_disagreement: 0 };
}

function emptyBySeverity(): MarksBySeverity {
  return { low: 0, medium: 0, high: 0 };
}

function isMarkKind(value: string): value is MarkKind {
  return (
    value === 'partial_impossible' ||
    value === 'abrupt_improvement' ||
    value === 'quorum_disagreement'
  );
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface StatsReadResult {
  record: DailyAntiCheatStats;
  version: string;
}

function readStatsRow(nk: INakama, utcDate: string): StatsReadResult | null {
  const objs = nk.storageRead([
    {
      collection: ANTI_CHEAT_STATS_COLLECTION,
      key: utcDate,
      userId: ANTI_CHEAT_STATS_SYSTEM_USER,
    },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<DailyAntiCheatStats>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.utcDate !== 'string' ||
    typeof v.marksTotal !== 'number'
  ) {
    return null;
  }
  return {
    record: v as DailyAntiCheatStats,
    version: obj.version ?? '',
  };
}

/** Read the stats row for a date. Returns an empty stats when absent. */
export function readDailyStats(nk: INakama, utcDate: string): DailyAntiCheatStats {
  const row = readStatsRow(nk, utcDate);
  if (row !== null) return row.record;
  return emptyStats(utcDate);
}

/**
 * Write a full stats row, overwriting any prior value (CAS-retry
 * handles races against concurrent writers).
 */
export function writeDailyStats(
  nk: INakama,
  stats: DailyAntiCheatStats,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readStatsRow(nk, stats.utcDate);
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_STATS_COLLECTION,
      key: stats.utcDate,
      userId: ANTI_CHEAT_STATS_SYSTEM_USER,
      value: stats as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
    };
    if (existing !== null) {
      (obj as unknown as { version: string }).version = existing.version;
    }
    try {
      nk.storageWrite([obj]);
      return;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('writeDailyStats: CAS retries exhausted');
      }
    }
  }
  throw new Error('writeDailyStats: unreachable');
}

/**
 * Pure increment: returns a NEW stats row that has `mark` added. The
 * caller is expected to follow up with `writeDailyStats` to persist
 * (avoids losing the read-modify-write race).
 */
export function bumpStats(
  prev: DailyAntiCheatStats,
  mark: AntiCheatMark,
): DailyAntiCheatStats {
  const byKind: MarksByKind = isMarkKind(mark.kind)
    ? { ...emptyByKind(), ...prev.marksByKind, [mark.kind]: (prev.marksByKind[mark.kind] ?? 0) + 1 }
    : { ...emptyByKind(), ...prev.marksByKind };
  const bySeverity: MarksBySeverity = {
    ...emptyBySeverity(),
    ...prev.marksBySeverity,
    [mark.severity]: (prev.marksBySeverity[mark.severity] ?? 0) + 1,
  };
  return {
    schemaVersion: 1,
    utcDate: prev.utcDate,
    marksTotal: prev.marksTotal + 1,
    marksByKind: byKind,
    marksBySeverity: bySeverity,
    usersHidden: prev.usersHidden,            // tracked separately (subscribers)
    usersConfirmed: prev.usersConfirmed + (mark.confirmed ? 1 : 0),
  };
}

/**
 * Increment the daily stats row by one mark. Reads current stats,
 * applies `bumpStats`, writes back (CAS-retry). Lazy-creates the row
 * when absent.
 */
export function incrementStats(
  nk: INakama,
  utcDate: string,
  mark: AntiCheatMark,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const prev = readDailyStats(nk, utcDate);
    const next = bumpStats(prev, mark);
    const existing = readStatsRow(nk, utcDate);
    const obj: IStorageObject = {
      collection: ANTI_CHEAT_STATS_COLLECTION,
      key: utcDate,
      userId: ANTI_CHEAT_STATS_SYSTEM_USER,
      value: next as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 0,
    };
    if (existing !== null) {
      (obj as unknown as { version: string }).version = existing.version;
    }
    try {
      nk.storageWrite([obj]);
      return;
    } catch {
      if (attempt === MAX_CAS_RETRIES - 1) {
        throw new Error('incrementStats: CAS retries exhausted');
      }
    }
  }
  throw new Error('incrementStats: unreachable');
}