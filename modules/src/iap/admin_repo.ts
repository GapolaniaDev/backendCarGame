// Phase 9 Chunk 6 — Admin IAP query helpers.
//
// The 6 admin RPCs in `admin.ts` need to read across the entire
// `iap_purchases` and `iap_fraud_flags` collections. This file
// centralises the cross-user read patterns + the 60s stats TTL cache.
//
// `iap_fraud_flags/{txId}` is a server-owned collection populated by
// `iap_purchase` (Chunk 3) whenever a cross-user transactionId
// collision is detected. The admin list RPC reads from this index.

import type { IStorageObject, INakama } from '../nkruntime';
import type { IapPlatform } from './types';
import type { PurchaseRecord } from './purchase_repo';
import { asPurchase } from './purchase_repo';

export const FRAUD_FLAGS_COLLECTION = 'iap_fraud_flags';

export type FraudFlagStatus = 'pending' | 'reviewed' | 'actioned';
export type FraudFlagAction = 'ban' | 'dismiss' | 'confirm';

export interface FraudFlag {
  transactionId: string;
  claimedByUserId: string;
  conflictByUserId: string;
  packId: string;
  platform: IapPlatform;
  detectedAtUtc: number;
  status: FraudFlagStatus;
  actionedAtUtc?: number;
  actionedByAdminId?: string;
  actionedReason?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFraudFlag(v: unknown, transactionId: string): FraudFlag | null {
  if (!isPlainObject(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r['claimedByUserId'] !== 'string' || typeof r['conflictByUserId'] !== 'string') return null;
  if (typeof r['packId'] !== 'string' || typeof r['detectedAtUtc'] !== 'number') return null;
  const platform = r['platform'];
  if (platform !== 'apple' && platform !== 'google') return null;
  const status = r['status'];
  if (status !== 'pending' && status !== 'reviewed' && status !== 'actioned') return null;
  const out: FraudFlag = {
    transactionId,
    claimedByUserId: r['claimedByUserId'] as string,
    conflictByUserId: r['conflictByUserId'] as string,
    packId: r['packId'] as string,
    platform: platform as IapPlatform,
    detectedAtUtc: r['detectedAtUtc'] as number,
    status,
  };
  if (typeof r['actionedAtUtc'] === 'number') out.actionedAtUtc = r['actionedAtUtc'];
  if (typeof r['actionedByAdminId'] === 'string') out.actionedByAdminId = r['actionedByAdminId'];
  if (typeof r['actionedReason'] === 'string') out.actionedReason = r['actionedReason'];
  return out;
}

// ─── Fraud flags ──────────────────────────────────────────────────────

export function readFraudFlag(
  nk: INakama,
  transactionId: string,
): FraudFlag | null {
  const reads = nk.storageRead([
    { collection: FRAUD_FLAGS_COLLECTION, key: transactionId, userId: '' },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asFraudFlag(obj.value, transactionId);
}

export function readFraudFlagWithVersion(
  nk: INakama,
  transactionId: string,
): { version: string; flag: FraudFlag } | null {
  const reads = nk.storageRead([
    { collection: FRAUD_FLAGS_COLLECTION, key: transactionId, userId: '' },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  const flag = asFraudFlag(obj.value, transactionId);
  if (!flag || typeof obj.version !== 'string') return null;
  return { version: obj.version, flag };
}

export function writeFraudFlagCreate(
  nk: INakama,
  transactionId: string,
  flag: FraudFlag,
): void {
  // `userId: ''` is the system-user sentinel for a server-owned row
  // not tied to a specific user. Matches the precedent in
  // `liveops/config.ts`.
  const obj: IStorageObject = {
    collection: FRAUD_FLAGS_COLLECTION,
    key: transactionId,
    userId: '',
    value: flag as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

export function writeFraudFlagUpdate(
  nk: INakama,
  transactionId: string,
  flag: FraudFlag,
  expectedVersion: string,
): void {
  const obj: IStorageObject = {
    collection: FRAUD_FLAGS_COLLECTION,
    key: transactionId,
    userId: '',
    value: flag as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: expectedVersion,
  };
  nk.storageWrite([obj]);
}

export function listAllFraudFlags(
  nk: INakama,
  limit: number = 10_000,
): Array<{ transactionId: string; version: string; flag: FraudFlag }> {
  const list = nk.storageList({ collection: FRAUD_FLAGS_COLLECTION, limit });
  const out: Array<{ transactionId: string; version: string; flag: FraudFlag }> = [];
  for (const o of list.objects) {
    const f = asFraudFlag(o.value, o.key);
    if (!f || typeof o.version !== 'string') continue;
    out.push({ transactionId: o.key, version: o.version, flag: f });
  }
  return out;
}

// ─── Purchase list filter (used by admin_iap_purchases_list) ────────

export interface PurchaseFilter {
  platform?: IapPlatform;
  packId?: string;
  userId?: string;
  refunded?: boolean;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export interface FilteredPurchase {
  userId: string;
  transactionId: string;
  record: PurchaseRecord;
}

export function listAndFilterPurchases(
  nk: INakama,
  filter: PurchaseFilter,
): FilteredPurchase[] {
  const list = nk.storageList({ collection: 'iap_purchases', limit: 10_000 });
  const rows: FilteredPurchase[] = [];
  for (const o of list.objects) {
    const rec = asPurchase(o.value, o.userId, o.key);
    if (!rec) continue;
    if (filter.platform !== undefined && rec.platform !== filter.platform) continue;
    if (filter.packId !== undefined && rec.packId !== filter.packId) continue;
    if (filter.userId !== undefined && rec.userId !== filter.userId) continue;
    if (filter.refunded !== undefined) {
      const isRefunded = rec.refunded === true;
      if (isRefunded !== filter.refunded) continue;
    }
    if (filter.fromDate !== undefined) {
      const from = Date.parse(`${filter.fromDate}T00:00:00Z`);
      if (Number.isFinite(from) && rec.grantedAtUtc < from) continue;
    }
    if (filter.toDate !== undefined) {
      const to = Date.parse(`${filter.toDate}T23:59:59Z`);
      if (Number.isFinite(to) && rec.grantedAtUtc > to) continue;
    }
    rows.push({ userId: rec.userId, transactionId: o.key, record: rec });
  }
  // Sort by grantedAtUtc desc.
  rows.sort((a, b) => b.record.grantedAtUtc - a.record.grantedAtUtc);
  if (filter.limit !== undefined && filter.limit > 0) {
    return rows.slice(0, filter.limit);
  }
  return rows;
}

// ─── Revenue stats (60s TTL cache) ──────────────────────────────────

export interface RevenueStatsDay {
  date: string; // YYYY-MM-DD
  totalRevenue: { apple: number; google: number };
  totalRefunds: number;
  netRevenue: number;
  purchaseCount: number;
  uniqueBuyers: number;
}

export interface RevenueStatsByPack {
  packId: string;
  revenue: { apple: number; google: number };
  refunds: number;
  purchaseCount: number;
}

export interface RevenueStatsByPlatform {
  platform: IapPlatform;
  revenue: number;
  refunds: number;
  purchaseCount: number;
}

export interface RevenueStats {
  fromDate: string;
  toDate: string;
  days: RevenueStatsDay[];
  byPack: RevenueStatsByPack[];
  byPlatform: RevenueStatsByPlatform[];
  totalRevenue: { apple: number; google: number };
  totalRefunds: number;
  netRevenue: number;
  purchaseCount: number;
  uniqueBuyers: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE = new Map<string, { result: RevenueStats; expiresAt: number }>();
let LAST_EVICT_AT = 0;

function cacheKey(args: { fromDate: string; toDate: string }): string {
  return `${args.fromDate}|${args.toDate}`;
}

function evictCacheIfDue(nowUtc: number): void {
  if (nowUtc - LAST_EVICT_AT < CACHE_TTL_MS) return;
  for (const [k, v] of CACHE) {
    if (v.expiresAt <= nowUtc) CACHE.delete(k);
  }
  LAST_EVICT_AT = nowUtc;
}

export function getCachedRevenueStats(
  fromDate: string,
  toDate: string,
  nowUtc: number,
): RevenueStats | null {
  evictCacheIfDue(nowUtc);
  const entry = CACHE.get(cacheKey({ fromDate, toDate }));
  if (entry && entry.expiresAt > nowUtc) return entry.result;
  return null;
}

export function cacheRevenueStats(
  fromDate: string,
  toDate: string,
  stats: RevenueStats,
  nowUtc: number,
): void {
  CACHE.set(cacheKey({ fromDate, toDate }), {
    result: stats,
    expiresAt: nowUtc + CACHE_TTL_MS,
  });
}

export function invalidateRevenueStatsCache(): void {
  CACHE.clear();
  LAST_EVICT_AT = 0;
}

function dateOnlyUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function coinsFromRecord(rec: PurchaseRecord): number {
  // The `content` is an IapGrantPlan which always has a `coins` field.
  // For subscriptions the coins from the iap_purchase grant are just the
  // pack's `baseCoins` (no first-time bonus); the monthly grant lives
  // elsewhere in the subscription flow. The stats endpoint counts the
  // initial pack coins for revenue, NOT monthly grants.
  const c = (rec.content as { coins?: number }).coins;
  return typeof c === 'number' ? c : 0;
}

export function computeRevenueStats(
  nk: INakama,
  fromDate: string,
  toDate: string,
): RevenueStats {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T23:59:59Z`);
  const rows: PurchaseRecord[] = [];
  const list = nk.storageList({ collection: 'iap_purchases', limit: 10_000 });
  for (const o of list.objects) {
    const rec = asPurchase(o.value, o.userId, o.key);
    if (!rec) continue;
    if (Number.isFinite(from) && rec.grantedAtUtc < from) continue;
    if (Number.isFinite(to) && rec.grantedAtUtc > to) continue;
    rows.push(rec);
  }
  // D83: revenue stats EXCLUDE refunded purchases.
  const unrevoked = rows.filter((r) => r.refunded !== true);
  const refunded = rows.filter((r) => r.refunded === true);

  const days: RevenueStatsDay[] = [];
  const dayMap = new Map<string, { apple: number; google: number; refunds: number; count: number; buyers: Set<string> }>();
  for (const r of unrevoked) {
    const date = dateOnlyUtc(r.grantedAtUtc);
    let entry = dayMap.get(date);
    if (!entry) {
      entry = { apple: 0, google: 0, refunds: 0, count: 0, buyers: new Set() };
      dayMap.set(date, entry);
    }
    const coins = coinsFromRecord(r);
    if (r.platform === 'apple') entry.apple += coins;
    else entry.google += coins;
    entry.count += 1;
    entry.buyers.add(r.userId);
  }
  for (const r of refunded) {
    const date = dateOnlyUtc(r.grantedAtUtc ?? 0);
    let entry = dayMap.get(date);
    if (!entry) {
      entry = { apple: 0, google: 0, refunds: 0, count: 0, buyers: new Set() };
      dayMap.set(date, entry);
    }
    entry.refunds += coinsFromRecord(r);
  }
  for (const [date, e] of Array.from(dayMap.entries()).sort()) {
    days.push({
      date,
      totalRevenue: { apple: e.apple, google: e.google },
      totalRefunds: e.refunds,
      netRevenue: e.apple + e.google - e.refunds,
      purchaseCount: e.count,
      uniqueBuyers: e.buyers.size,
    });
  }

  const byPackMap = new Map<string, { apple: number; google: number; refunds: number; count: number }>();
  for (const r of unrevoked) {
    let e = byPackMap.get(r.packId);
    if (!e) { e = { apple: 0, google: 0, refunds: 0, count: 0 }; byPackMap.set(r.packId, e); }
    const coins = coinsFromRecord(r);
    if (r.platform === 'apple') e.apple += coins;
    else e.google += coins;
    e.count += 1;
  }
  for (const r of refunded) {
    let e = byPackMap.get(r.packId);
    if (!e) { e = { apple: 0, google: 0, refunds: 0, count: 0 }; byPackMap.set(r.packId, e); }
    e.refunds += coinsFromRecord(r);
  }
  const byPack: RevenueStatsByPack[] = [];
  for (const [packId, e] of Array.from(byPackMap.entries())) {
    byPack.push({
      packId,
      revenue: { apple: e.apple, google: e.google },
      refunds: e.refunds,
      purchaseCount: e.count,
    });
  }

  const byPlatformMap = new Map<IapPlatform, { revenue: number; refunds: number; count: number }>();
  for (const r of unrevoked) {
    let e = byPlatformMap.get(r.platform);
    if (!e) { e = { revenue: 0, refunds: 0, count: 0 }; byPlatformMap.set(r.platform, e); }
    e.revenue += coinsFromRecord(r);
    e.count += 1;
  }
  for (const r of refunded) {
    let e = byPlatformMap.get(r.platform);
    if (!e) { e = { revenue: 0, refunds: 0, count: 0 }; byPlatformMap.set(r.platform, e); }
    e.refunds += coinsFromRecord(r);
  }
  const byPlatform: RevenueStatsByPlatform[] = [];
  for (const [platform, e] of Array.from(byPlatformMap.entries())) {
    byPlatform.push({
      platform,
      revenue: e.revenue,
      refunds: e.refunds,
      purchaseCount: e.count,
    });
  }

  const totalApple = unrevoked.filter((r) => r.platform === 'apple').reduce((s, r) => s + coinsFromRecord(r), 0);
  const totalGoogle = unrevoked.filter((r) => r.platform === 'google').reduce((s, r) => s + coinsFromRecord(r), 0);
  const totalRefunds = refunded.reduce((s, r) => s + coinsFromRecord(r), 0);

  return {
    fromDate,
    toDate,
    days,
    byPack,
    byPlatform,
    totalRevenue: { apple: totalApple, google: totalGoogle },
    totalRefunds,
    netRevenue: totalApple + totalGoogle - totalRefunds,
    purchaseCount: unrevoked.length,
    uniqueBuyers: new Set(unrevoked.map((r) => r.userId)).size,
  };
}
