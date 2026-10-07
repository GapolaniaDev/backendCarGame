// Phase 7 Chunk 7 — Reports storage repo + per-reporter rate limiter.
//
// Read/write helpers for the three report collections. The rate limit
// is intentionally separate from the global `core/checkRateLimit` —
// reports are 5/HOUR (not per-minute), so we don't want a
// minute-window counter. We use a per-user storage row with CAS retry,
// same pattern as `chat/rate_limit.ts` and `chat/silenced.ts`.

import type { IStorageObject, INakama } from '../nkruntime';
import {
  REPORTS_PER_HOUR_LIMIT,
  REPORTS_RATE_COLLECTION,
  REPORTS_RATE_WINDOW_MS,
  REPORTS_RECENT_COLLECTION,
  asReportsRateWrite,
  asReportsRecentWrite,
  type ReportsRateRecord,
  type ReportsRecentRecord,
} from './types';

export const MAX_CAS_RETRIES = 3;

// ─── Reports rate (per reporter, 5/hour) ───────────────────────────────────

export interface ReportsRateVerdict {
  allowed: boolean;
  /** How many reports have been filed inside the current hour. */
  count: number;
  /** Limit applied (always REPORTS_PER_HOUR_LIMIT). */
  limit: number;
}

export function readReportsRate(
  nk: INakama,
  reporterUserId: string,
): { record: ReportsRateRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: REPORTS_RATE_COLLECTION, key: reporterUserId, userId: reporterUserId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<ReportsRateRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.reporterUserId !== 'string' ||
    typeof v.windowStartTs !== 'number' ||
    typeof v.count !== 'number'
  ) {
    return null;
  }
  return { record: v as ReportsRateRecord, version: obj.version ?? '' };
}

export function writeReportsRateCreate(
  nk: INakama,
  rec: ReportsRateRecord,
): string {
  const obj: IStorageObject = asReportsRateWrite(rec);
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function writeReportsRateUpdate(
  nk: INakama,
  rec: ReportsRateRecord,
  version: string,
): string {
  const obj: IStorageObject = { ...asReportsRateWrite(rec), version };
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

/**
 * Pure: compute the next rate state from the previous one + nowMs.
 * - If the current window has expired → new window with count=1.
 * - Otherwise → previous.count + 1.
 *
 * Exported for testability.
 */
export function computeNextReportsRate(
  prev: ReportsRateRecord | null,
  reporterUserId: string,
  nowMs: number,
): ReportsRateRecord {
  if (prev === null || nowMs - prev.windowStartTs >= REPORTS_RATE_WINDOW_MS) {
    return { schemaVersion: 1, reporterUserId, windowStartTs: nowMs, count: 1 };
  }
  return { ...prev, count: prev.count + 1 };
}

/**
 * CAS-retry rate-limit check. Returns `{allowed, count, limit}`.
 * Increments the counter on success; does NOT increment on rejection.
 */
export function checkReportsRateLimit(
  nk: INakama,
  reporterUserId: string,
  nowMs: number,
): ReportsRateVerdict {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const prev = readReportsRate(nk, reporterUserId);
    const projectedCount =
      prev === null
        ? 1
        : nowMs - prev.record.windowStartTs >= REPORTS_RATE_WINDOW_MS
          ? 1
          : prev.record.count + 1;
    if (projectedCount > REPORTS_PER_HOUR_LIMIT) {
      return { allowed: false, count: prev?.record.count ?? 0, limit: REPORTS_PER_HOUR_LIMIT };
    }
    const next = computeNextReportsRate(prev?.record ?? null, reporterUserId, nowMs);
    try {
      if (prev === null) {
        writeReportsRateCreate(nk, next);
      } else {
        writeReportsRateUpdate(nk, next, prev.version);
      }
      return { allowed: true, count: next.count, limit: REPORTS_PER_HOUR_LIMIT };
    } catch {
      // CAS conflict → retry with fresh state
      if (attempt === MAX_CAS_RETRIES - 1) {
        return { allowed: false, count: prev?.record.count ?? 0, limit: REPORTS_PER_HOUR_LIMIT };
      }
    }
  }
  return { allowed: false, count: 0, limit: REPORTS_PER_HOUR_LIMIT };
}

// ─── Reports recent (rolling window of distinct reporters) ─────────────────

export function readReportsRecent(
  nk: INakama,
  targetUserId: string,
): { record: ReportsRecentRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: REPORTS_RECENT_COLLECTION, key: targetUserId, userId: targetUserId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<ReportsRecentRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.targetUserId !== 'string' ||
    typeof v.entries !== 'object' || v.entries === null
  ) {
    return null;
  }
  return { record: v as ReportsRecentRecord, version: obj.version ?? '' };
}

export function writeReportsRecentCreate(
  nk: INakama,
  rec: ReportsRecentRecord,
): string {
  const obj: IStorageObject = asReportsRecentWrite(rec);
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

export function writeReportsRecentUpdate(
  nk: INakama,
  rec: ReportsRecentRecord,
  version: string,
): string {
  const obj: IStorageObject = { ...asReportsRecentWrite(rec), version };
  const acks = nk.storageWrite([obj]);
  return (acks as Array<{ version?: string }>)[0]?.version ?? '';
}

/**
 * Pure: GC entries older than `nowMs - windowMs` and add the new
 * reporter. Returns the updated record. Exported for testability.
 */
export function gcReportsRecent(
  prev: ReportsRecentRecord | null,
  targetUserId: string,
  reporterUserId: string,
  nowMs: number,
  windowMs: number,
): ReportsRecentRecord {
  const cutoff = nowMs - windowMs;
  const baseEntries = prev?.entries ?? {};
  const nextEntries: Record<string, number> = {};
  for (const [uid, ts] of Object.entries(baseEntries)) {
    if (ts >= cutoff) nextEntries[uid] = ts;
  }
  // Overwrite (or insert) the reporter — most recent ts wins.
  nextEntries[reporterUserId] = nowMs;
  return {
    schemaVersion: 1,
    targetUserId,
    entries: nextEntries,
  };
}

/**
 * Pure: count distinct reporter entries after GC. Exported for
 * testability.
 */
export function countDistinctReporters(rec: ReportsRecentRecord): number {
  return Object.keys(rec.entries).length;
}