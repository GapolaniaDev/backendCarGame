// Phase 8 Chunk 2 — Abrupt improvement detection + per-user history.
//
// `abrupt_history/{userId}` — owner-scoped (userId), server-only writes.
// One row per user. Append-only ring buffer (capped at
// `ABRUPT_HISTORY_MAX_ENTRIES`).
//
// Detection: when a new race time is >30% better than the MEDIAN of the
// user's last 5 races, mark the player. Median (not mean) — robust to a
// single outlier in the window.

import type { IStorageObject, INakama } from '../nkruntime';
import { MAX_CAS_RETRIES } from './_reset_for_tests';

/** Storage collection for per-user abrupt-improvement history. */
export const ABRUPT_HISTORY_COLLECTION = 'abrupt_history';

/** Cap on entries retained per user (oldest dropped on overflow). */
export const ABRUPT_HISTORY_MAX_ENTRIES = 50;

/** Improvement threshold (percent) above which we mark the player. */
export const ABRUPT_IMPROVEMENT_THRESHOLD_PCT = 30;

/** Minimum history length before to consider the median stable. */
export const ABRUPT_IMPROVEMENT_MIN_HISTORY = 5;

/** Single history entry: a finished race's best time. */
export interface AbruptHistoryEntry {
  raceId: string;
  bestTimeMs: number;
  ts: number;
}

export interface AbruptHistoryRow {
  schemaVersion: 1;
  userId: string;
  entries: AbruptHistoryEntry[];
}

export interface AbruptImprovementResult {
  ok: boolean;
  /** Integer percentage improvement of the new time over the median
   *  (positive = faster). Populated only when `ok=false`. */
  improvementPct?: number;
  /** Median time the detector computed (diagnostic, even on ok). */
  medianMs?: number;
}

/**
 * Pure detection: compare `newTimeMs` to the MEDIAN of the last
 * `ABRUPT_IMPROVEMENT_MIN_HISTORY` (5) entries in `history` (sorted by
 * `ts` descending — i.e. the most recent 5).
 *
 * Returns `{ ok: true }` when the history is shorter than 5 (insufficient
 * data — don't false-positive on a player's first few races). Returns
 * `{ ok: true }` when the median is ≤ 0 (defensive — bad input).
 */
export function detectAbruptImprovement(
  history: ReadonlyArray<AbruptHistoryEntry>,
  newTimeMs: number,
): AbruptImprovementResult {
  if (!Number.isFinite(newTimeMs) || newTimeMs <= 0) return { ok: true };
  if (history.length < ABRUPT_IMPROVEMENT_MIN_HISTORY) return { ok: true };

  // Sort by ts desc, take the 5 most recent.
  const sorted = [...history].sort((a, b) => b.ts - a.ts);
  const recent = sorted.slice(0, ABRUPT_IMPROVEMENT_MIN_HISTORY);
  const median = medianOf(recent.map((e) => e.bestTimeMs));
  if (median <= 0) return { ok: true };

  // Faster = smaller. improvementPct = floor((median - new) / median * 100).
  // Negative or zero pct → not faster, not a violation.
  const pctRaw = ((median - newTimeMs) / median) * 100;
  const improvementPct = Math.floor(pctRaw);
  if (improvementPct > ABRUPT_IMPROVEMENT_THRESHOLD_PCT) {
    return { ok: false, improvementPct, medianMs: median };
  }
  return { ok: true, medianMs: median };
}

function medianOf(nums: ReadonlyArray<number>): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface AbruptHistoryReadResult {
  record: AbruptHistoryRow;
  version: string;
}

function readAbruptHistoryRow(
  nk: INakama,
  userId: string,
): AbruptHistoryReadResult | null {
  const objs = nk.storageRead([
    { collection: ABRUPT_HISTORY_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<AbruptHistoryRow>;
  if (
    !v ||
    typeof v !== 'object' ||
    v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' ||
    !Array.isArray(v.entries)
  ) {
    return null;
  }
  return {
    record: v as AbruptHistoryRow,
    version: obj.version ?? '',
  };
}

/** Read the per-user abrupt history. Returns `[]` when absent. */
export function readAbruptHistory(
  nk: INakama,
  userId: string,
): AbruptHistoryEntry[] {
  const row = readAbruptHistoryRow(nk, userId);
  return row === null ? [] : row.record.entries;
}

/**
 * Append one entry to the user's history. The ring is trimmed to the
 * last `ABRUPT_HISTORY_MAX_ENTRIES`. CAS-retry handles races against
 * concurrent writers (matchmaker fan-out, server reconnects).
 */
export function appendAbruptHistory(
  nk: INakama,
  userId: string,
  entry: AbruptHistoryEntry,
): void {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existing = readAbruptHistoryRow(nk, userId);
    const prev = existing?.record.entries ?? [];
    const next = [...prev, entry].slice(-ABRUPT_HISTORY_MAX_ENTRIES);
    const row: AbruptHistoryRow = {
      schemaVersion: 1,
      userId,
      entries: next,
    };
    const obj: IStorageObject = {
      collection: ABRUPT_HISTORY_COLLECTION,
      key: userId,
      userId,
      value: row as unknown as Record<string, unknown>,
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
        throw new Error('appendAbruptHistory: CAS retries exhausted');
      }
    }
  }
  throw new Error('appendAbruptHistory: unreachable');
}