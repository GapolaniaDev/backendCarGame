// Phase 9 Chunk 5 — Ad reward storage.
//
// Three server-owned collections (R=1/W=0):
//
//   ad_last_watched/{userId}/{tier}   — single row per (user, tier)
//                                       tracks the most recent watch
//                                       for cooldown enforcement
//
//   ad_daily_count/{userId}/{utcDate} — single row per (user, UTC day)
//                                       tracks the count for the
//                                       per-user daily cap (D75)
//
//   ad_watch_log/{userId}/{impressionId} — one row per ad watched,
//                                          retained as the
//                                          idempotency anchor and
//                                          as a fraud audit trail.
//
// All three are server-only: clients can read their own
// ad_watch_log (e.g. for the "ads watched today" UI) but can never
// write any of them. Mutating any of them is the server's job.

import type { IStorageObject, INakama } from '../nkruntime';
import type { AdLastWatched, AdDailyCount, AdWatchLog, AdTier } from './types';

export const AD_LAST_WATCHED_COLLECTION = 'ad_last_watched';
export const AD_DAILY_COUNT_COLLECTION = 'ad_daily_count';
export const AD_WATCH_LOG_COLLECTION = 'ad_watch_log';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── ad_last_watched ───────────────────────────────────────────────────

function asAdLastWatched(v: unknown): AdLastWatched | null {
  if (!isPlainObject(v)) return null;
  if (typeof v['lastWatchedAtUtc'] !== 'number' || typeof v['lastImpressionId'] !== 'string') {
    return null;
  }
  return {
    lastWatchedAtUtc: v['lastWatchedAtUtc'],
    lastImpressionId: v['lastImpressionId'],
  };
}

export function readAdLastWatched(
  nk: INakama,
  userId: string,
  tier: AdTier,
): AdLastWatched | null {
  const reads = nk.storageRead([
    { collection: AD_LAST_WATCHED_COLLECTION, key: `${userId}/${tier}`, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asAdLastWatched(obj.value);
}

export function writeAdLastWatched(
  nk: INakama,
  userId: string,
  tier: AdTier,
  data: AdLastWatched,
): void {
  const obj: IStorageObject = {
    collection: AD_LAST_WATCHED_COLLECTION,
    key: `${userId}/${tier}`,
    userId,
    value: data as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

// ─── ad_daily_count ────────────────────────────────────────────────────

function asAdDailyCount(v: unknown): AdDailyCount | null {
  if (!isPlainObject(v)) return null;
  if (typeof v['count'] !== 'number' || typeof v['lastUpdatedUtc'] !== 'number') {
    return null;
  }
  return {
    count: v['count'],
    lastUpdatedUtc: v['lastUpdatedUtc'],
  };
}

export function readAdDailyCount(
  nk: INakama,
  userId: string,
  utcDate: string,
): AdDailyCount | null {
  const reads = nk.storageRead([
    { collection: AD_DAILY_COUNT_COLLECTION, key: `${userId}/${utcDate}`, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asAdDailyCount(obj.value);
}

export function writeAdDailyCount(
  nk: INakama,
  userId: string,
  utcDate: string,
  data: AdDailyCount,
): void {
  const obj: IStorageObject = {
    collection: AD_DAILY_COUNT_COLLECTION,
    key: `${userId}/${utcDate}`,
    userId,
    value: data as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

// ─── ad_watch_log ──────────────────────────────────────────────────────

function asAdWatchLog(v: unknown): AdWatchLog | null {
  if (!isPlainObject(v)) return null;
  const tier = v['tier'];
  if (tier !== 'small' && tier !== 'medium' && tier !== 'large' && tier !== 'xlarge') return null;
  if (typeof v['adUnitId'] !== 'string' || typeof v['grantedAtUtc'] !== 'number') return null;
  if (typeof v['coinsGranted'] !== 'number' || typeof v['newBalance'] !== 'number') return null;
  if (typeof v['idempotencyKey'] !== 'string') return null;
  const provider = v['provider'];
  if (provider !== 'mock' && provider !== 'admob' && provider !== 'unityads') return null;
  return {
    tier: tier as AdTier,
    adUnitId: v['adUnitId'],
    provider: provider as 'mock' | 'admob' | 'unityads',
    watchedAtUtc: typeof v['watchedAtUtc'] === 'number' ? v['watchedAtUtc'] : 0,
    grantedAtUtc: v['grantedAtUtc'],
    coinsGranted: v['coinsGranted'],
    newBalance: v['newBalance'],
    idempotencyKey: v['idempotencyKey'],
  };
}

export function readAdWatchLog(
  nk: INakama,
  userId: string,
  impressionId: string,
): AdWatchLog | null {
  const reads = nk.storageRead([
    { collection: AD_WATCH_LOG_COLLECTION, key: `${userId}/${impressionId}`, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asAdWatchLog(obj.value);
}

export function writeAdWatchLog(
  nk: INakama,
  userId: string,
  impressionId: string,
  data: AdWatchLog,
): void {
  const obj: IStorageObject = {
    collection: AD_WATCH_LOG_COLLECTION,
    key: `${userId}/${impressionId}`,
    userId,
    value: data as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}
