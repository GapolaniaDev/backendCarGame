// Phase 9 Chunk 6 — Unit tests for the admin IAP repo.
//
// Coverage:
//   - Fraud flag CRUD (readFraudFlag, readFraudFlagWithVersion, writeFraudFlagCreate,
//     writeFraudFlagUpdate, listAllFraudFlags)
//   - listAndFilterPurchases (filters: platform, packId, userId, refunded, fromDate,
//     toDate, limit; sort by grantedAtUtc desc)
//   - computeRevenueStats (D83: revenue excludes refunded; days / byPack / byPlatform)
//   - Stats cache (get/set/invalidate + 60s TTL eviction)

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, SYSTEM_USER_ID } from '../e2e/_stubs';
import type { FakeNakama as FakeNakamaT } from '../e2e/_stubs';
import {
  readFraudFlag,
  readFraudFlagWithVersion,
  writeFraudFlagCreate,
  writeFraudFlagUpdate,
  listAllFraudFlags,
  listAndFilterPurchases,
  computeRevenueStats,
  getCachedRevenueStats,
  cacheRevenueStats,
  invalidateRevenueStatsCache,
  FRAUD_FLAGS_COLLECTION,
  type FraudFlag,
} from '../../modules/src/iap/admin_repo';
import {
  writePurchase,
  type PurchaseRecord,
} from '../../modules/src/iap/purchase_repo';

const NOW = 1_700_000_000_000;

function newNak(): FakeNakamaT {
  return new FakeNakama();
}

function makeRecord(overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    userId: 'user-A',
    packId: 'coins_100',
    platform: 'apple',
    productId: 'com.cvg.coins100',
    content: { coins: 100, firstTimeBonus: 50 },
    grantedAtUtc: NOW,
    idempotencyKey: 'iap_purchase:tx-1',
    isFirstTime: true,
    ...overrides,
  };
}

function makeFlag(overrides: Partial<FraudFlag> = {}): FraudFlag {
  return {
    transactionId: 'tx-1',
    claimedByUserId: 'claimed',
    conflictByUserId: 'conflict',
    packId: 'coins_100',
    platform: 'apple',
    detectedAtUtc: NOW,
    status: 'pending',
    ...overrides,
  };
}

describe('iap admin_repo — fraud flags (Phase 9 Chunk 6)', () => {
  let nak: FakeNakamaT;
  beforeEach(() => { nak = newNak(); });

  it('writeFraudFlagCreate + readFraudFlag round-trips', () => {
    writeFraudFlagCreate(nak.nakama, 'tx-1', makeFlag());
    const got = readFraudFlag(nak.nakama, 'tx-1');
    expect(got).not.toBeNull();
    expect(got!.transactionId).toBe('tx-1');
    expect(got!.claimedByUserId).toBe('claimed');
    expect(got!.conflictByUserId).toBe('conflict');
    expect(got!.status).toBe('pending');
  });

  it('readFraudFlag returns null for unknown txId', () => {
    expect(readFraudFlag(nak.nakama, 'no-such')).toBeNull();
  });

  it('readFraudFlagWithVersion returns version + flag', () => {
    writeFraudFlagCreate(nak.nakama, 'tx-1', makeFlag());
    const got = readFraudFlagWithVersion(nak.nakama, 'tx-1');
    expect(got).not.toBeNull();
    expect(got!.flag.transactionId).toBe('tx-1');
    expect(typeof got!.version).toBe('string');
    expect(got!.version.length).toBeGreaterThan(0);
  });

  it('writeFraudFlagUpdate CAS-updates and preserves optional actioned fields', () => {
    writeFraudFlagCreate(nak.nakama, 'tx-1', makeFlag());
    const v0 = readFraudFlagWithVersion(nak.nakama, 'tx-1')!;
    const updated: FraudFlag = {
      ...v0.flag,
      status: 'actioned',
      actionedAtUtc: NOW + 1000,
      actionedByAdminId: 'admin-1',
      actionedReason: 'fraud confirmed',
    };
    writeFraudFlagUpdate(nak.nakama, 'tx-1', updated, v0.version);
    const got = readFraudFlag(nak.nakama, 'tx-1');
    expect(got!.status).toBe('actioned');
    expect(got!.actionedAtUtc).toBe(NOW + 1000);
    expect(got!.actionedByAdminId).toBe('admin-1');
    expect(got!.actionedReason).toBe('fraud confirmed');
  });

  it('listAllFraudFlags returns every row', () => {
    writeFraudFlagCreate(nak.nakama, 'tx-1', makeFlag());
    writeFraudFlagCreate(nak.nakama, 'tx-2', makeFlag({
      transactionId: 'tx-2', claimedByUserId: 'c2', conflictByUserId: 'c3', status: 'reviewed',
    }));
    const all = listAllFraudFlags(nak.nakama);
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.flag.transactionId).sort();
    expect(ids).toEqual(['tx-1', 'tx-2']);
  });

  it('asFraudFlag rejects invalid status / platform / missing fields', () => {
    // Invalid platform.
    writeFraudFlagCreate(nak.nakama, 'bad-1', makeFlag({ transactionId: 'bad-1', platform: 'nokia' as unknown as 'apple' }));
    expect(readFraudFlag(nak.nakama, 'bad-1')).toBeNull();

    // Invalid status.
    writeFraudFlagCreate(nak.nakama, 'bad-2', makeFlag({ transactionId: 'bad-2', status: 'gone' as unknown as 'pending' }));
    expect(readFraudFlag(nak.nakama, 'bad-2')).toBeNull();

    // Missing claimedByUserId.
    nak.nakama.storageWrite([{
      collection: FRAUD_FLAGS_COLLECTION,
      key: 'bad-3',
      userId: '',
      value: {
        transactionId: 'bad-3',
        // claimedByUserId missing
        conflictByUserId: 'c',
        packId: 'coins_100',
        platform: 'apple',
        detectedAtUtc: NOW,
        status: 'pending',
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    expect(readFraudFlag(nak.nakama, 'bad-3')).toBeNull();
  });

  it('fraud flag storage uses R=1/W=0 (server-only)', () => {
    writeFraudFlagCreate(nak.nakama, 'tx-1', makeFlag());
    const obj = nak.store.get(`${FRAUD_FLAGS_COLLECTION}/tx-1/${SYSTEM_USER_ID === '00000000-0000-0000-0000-000000000000' ? '' : SYSTEM_USER_ID}`);
    // The empty-userId sentinel lives at key `iap_fraud_flags/tx-1/`.
    const obj2 = Array.from(nak.store.values()).find(
      (o) => o.collection === FRAUD_FLAGS_COLLECTION && o.key === 'tx-1',
    );
    expect(obj2).toBeDefined();
    expect(obj2!.permissionRead).toBe(1);
    expect(obj2!.permissionWrite).toBe(0);
    expect(obj2!.userId).toBe('');
  });
});

describe('iap admin_repo — listAndFilterPurchases (Phase 9 Chunk 6)', () => {
  let nak: FakeNakamaT;
  beforeEach(() => { nak = newNak(); });

  function seed(): void {
    writePurchase(nak.nakama, 'tx-1', makeRecord({
      userId: 'user-A', packId: 'coins_100', platform: 'apple', grantedAtUtc: NOW,
    }));
    writePurchase(nak.nakama, 'tx-2', makeRecord({
      userId: 'user-A', packId: 'gems_50', platform: 'google', grantedAtUtc: NOW + 1000,
    }));
    writePurchase(nak.nakama, 'tx-3', makeRecord({
      userId: 'user-B', packId: 'coins_100', platform: 'apple', grantedAtUtc: NOW + 2000,
    }));
    writePurchase(nak.nakama, 'tx-4', makeRecord({
      userId: 'user-B', packId: 'coins_100', platform: 'apple', grantedAtUtc: NOW + 3000,
      refunded: true, refundedAtUtc: NOW + 4000, refundedReason: 'test',
    }));
  }

  it('returns all rows when no filter is applied', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, {});
    expect(rows).toHaveLength(4);
  });

  it('sorts by grantedAtUtc desc', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, {});
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-4', 'tx-3', 'tx-2', 'tx-1']);
  });

  it('filter by platform', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { platform: 'google' });
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-2']);
  });

  it('filter by packId', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { packId: 'coins_100' });
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-4', 'tx-3', 'tx-1']);
  });

  it('filter by userId', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { userId: 'user-B' });
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-4', 'tx-3']);
  });

  it('filter by refunded=true excludes non-refunded', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { refunded: true });
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-4']);
  });

  it('filter by refunded=false excludes refunded', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { refunded: false });
    expect(rows.map((r) => r.transactionId).sort()).toEqual(['tx-1', 'tx-2', 'tx-3']);
  });

  it('filter by fromDate / toDate', () => {
    // Re-seed with purchases spread across 3 distinct UTC days.
    const d1 = Date.UTC(2024, 0, 1, 12, 0, 0); // 2024-01-01
    const d2 = Date.UTC(2024, 0, 2, 12, 0, 0); // 2024-01-02
    const d3 = Date.UTC(2024, 0, 3, 12, 0, 0); // 2024-01-03
    writePurchase(nak.nakama, 'tx-1', makeRecord({ userId: 'user-A', grantedAtUtc: d1 }));
    writePurchase(nak.nakama, 'tx-2', makeRecord({ userId: 'user-A', grantedAtUtc: d2 }));
    writePurchase(nak.nakama, 'tx-3', makeRecord({ userId: 'user-B', grantedAtUtc: d3 }));
    const fromRows = listAndFilterPurchases(nak.nakama, { fromDate: '2024-01-02' });
    expect(fromRows.map((r) => r.transactionId)).toEqual(['tx-3', 'tx-2']);
    const toRows = listAndFilterPurchases(nak.nakama, { toDate: '2024-01-02' });
    expect(toRows.map((r) => r.transactionId).sort()).toEqual(['tx-1', 'tx-2']);
  });

  it('filter by limit caps the result', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-4', 'tx-3']);
  });

  it('combines multiple filters (AND)', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { platform: 'apple', packId: 'coins_100', refunded: false });
    expect(rows.map((r) => r.transactionId)).toEqual(['tx-3', 'tx-1']);
  });

  it('empty result for impossible filter combination', () => {
    seed();
    const rows = listAndFilterPurchases(nak.nakama, { platform: 'google', packId: 'coins_100' });
    expect(rows).toEqual([]);
  });
});

describe('iap admin_repo — computeRevenueStats (Phase 9 Chunk 6)', () => {
  let nak: FakeNakamaT;
  beforeEach(() => {
    nak = newNak();
    invalidateRevenueStatsCache();
  });

  it('empty stats when there are no purchases', () => {
    const fromDate = '2024-01-01';
    const toDate = '2024-01-07';
    const s = computeRevenueStats(nak.nakama, fromDate, toDate);
    expect(s.fromDate).toBe(fromDate);
    expect(s.toDate).toBe(toDate);
    expect(s.days).toEqual([]);
    expect(s.byPack).toEqual([]);
    expect(s.byPlatform).toEqual([]);
    expect(s.totalRevenue).toEqual({ apple: 0, google: 0 });
    expect(s.totalRefunds).toBe(0);
    expect(s.netRevenue).toBe(0);
    expect(s.purchaseCount).toBe(0);
    expect(s.uniqueBuyers).toBe(0);
  });

  it('aggregates revenue by day / pack / platform', () => {
    const day1 = Date.UTC(2024, 5, 1, 12, 0, 0); // 2024-06-01
    const day2 = Date.UTC(2024, 5, 2, 12, 0, 0); // 2024-06-02
    writePurchase(nak.nakama, 'tx-1', makeRecord({
      userId: 'user-A', packId: 'coins_100', platform: 'apple', grantedAtUtc: day1,
      content: { coins: 100, firstTimeBonus: 0 },
    }));
    writePurchase(nak.nakama, 'tx-2', makeRecord({
      userId: 'user-B', packId: 'coins_100', platform: 'google', grantedAtUtc: day1,
      content: { coins: 200, firstTimeBonus: 0 },
    }));
    writePurchase(nak.nakama, 'tx-3', makeRecord({
      userId: 'user-A', packId: 'gems_50', platform: 'apple', grantedAtUtc: day2,
      content: { coins: 50, firstTimeBonus: 0 },
    }));
    const s = computeRevenueStats(nak.nakama, '2024-06-01', '2024-06-02');
    expect(s.purchaseCount).toBe(3);
    expect(s.uniqueBuyers).toBe(2);
    expect(s.totalRevenue).toEqual({ apple: 150, google: 200 });
    expect(s.netRevenue).toBe(350);
    expect(s.totalRefunds).toBe(0);

    // byDay: 2 entries.
    expect(s.days).toHaveLength(2);
    expect(s.days[0]?.date).toBe('2024-06-01');
    expect(s.days[0]?.totalRevenue).toEqual({ apple: 100, google: 200 });
    expect(s.days[0]?.purchaseCount).toBe(2);
    expect(s.days[0]?.uniqueBuyers).toBe(2);
    expect(s.days[1]?.date).toBe('2024-06-02');
    expect(s.days[1]?.totalRevenue).toEqual({ apple: 50, google: 0 });
    expect(s.days[1]?.purchaseCount).toBe(1);

    // byPack.
    expect(s.byPack).toHaveLength(2);
    const packById = new Map(s.byPack.map((p) => [p.packId, p]));
    expect(packById.get('coins_100')?.revenue).toEqual({ apple: 100, google: 200 });
    expect(packById.get('coins_100')?.purchaseCount).toBe(2);
    expect(packById.get('gems_50')?.revenue).toEqual({ apple: 50, google: 0 });

    // byPlatform.
    expect(s.byPlatform).toHaveLength(2);
    const platById = new Map(s.byPlatform.map((p) => [p.platform, p]));
    expect(platById.get('apple')?.revenue).toBe(150);
    expect(platById.get('apple')?.purchaseCount).toBe(2);
    expect(platById.get('google')?.revenue).toBe(200);
    expect(platById.get('google')?.purchaseCount).toBe(1);
  });

  it('D83: revenue excludes refunded purchases but counts them as refunds', () => {
    const day = Date.UTC(2024, 5, 1, 12, 0, 0);
    writePurchase(nak.nakama, 'tx-1', makeRecord({
      userId: 'user-A', packId: 'coins_100', platform: 'apple', grantedAtUtc: day,
      content: { coins: 100, firstTimeBonus: 0 },
    }));
    writePurchase(nak.nakama, 'tx-2', makeRecord({
      userId: 'user-B', packId: 'gems_50', platform: 'google', grantedAtUtc: day,
      content: { coins: 200, firstTimeBonus: 0 },
      refunded: true, refundedAtUtc: day + 1000, refundedReason: 'test',
    }));
    const s = computeRevenueStats(nak.nakama, '2024-06-01', '2024-06-01');
    // tx-1 is in revenue (100 apple), tx-2 is excluded from revenue but
    // counted as a refund (200 google). Net = revenue - refunds.
    expect(s.totalRevenue).toEqual({ apple: 100, google: 0 });
    expect(s.totalRefunds).toBe(200);
    expect(s.netRevenue).toBe(100 - 200);
    expect(s.purchaseCount).toBe(1);
    expect(s.byPlatform).toHaveLength(2);
    const platById = new Map(s.byPlatform.map((p) => [p.platform, p]));
    expect(platById.get('google')?.revenue).toBe(0);
    expect(platById.get('google')?.refunds).toBe(200);
    expect(platById.get('google')?.purchaseCount).toBe(0);
  });

  it('respects the fromDate / toDate window', () => {
    const day1 = Date.UTC(2024, 5, 1, 12, 0, 0);
    const day5 = Date.UTC(2024, 5, 5, 12, 0, 0);
    writePurchase(nak.nakama, 'tx-1', makeRecord({
      userId: 'user-A', packId: 'coins_100', platform: 'apple', grantedAtUtc: day1,
      content: { coins: 100, firstTimeBonus: 0 },
    }));
    writePurchase(nak.nakama, 'tx-2', makeRecord({
      userId: 'user-A', packId: 'coins_100', platform: 'apple', grantedAtUtc: day5,
      content: { coins: 500, firstTimeBonus: 0 },
    }));
    const s = computeRevenueStats(nak.nakama, '2024-06-02', '2024-06-04');
    expect(s.purchaseCount).toBe(0);
    expect(s.days).toEqual([]);
    expect(s.totalRevenue).toEqual({ apple: 0, google: 0 });
  });

  it('handles a non-consumable (0 coins) purchase — does not affect revenue', () => {
    const day = Date.UTC(2024, 5, 1, 12, 0, 0);
    writePurchase(nak.nakama, 'tx-1', makeRecord({
      userId: 'user-A', packId: 'paint_red', platform: 'apple', grantedAtUtc: day,
      content: { coins: 0, firstTimeBonus: 0, cosmeticId: 'paint_red' },
    }));
    const s = computeRevenueStats(nak.nakama, '2024-06-01', '2024-06-01');
    expect(s.purchaseCount).toBe(1);
    expect(s.totalRevenue).toEqual({ apple: 0, google: 0 });
    expect(s.uniqueBuyers).toBe(1);
  });
});

describe('iap admin_repo — revenue stats cache (Phase 9 Chunk 6)', () => {
  let nak: FakeNakamaT;
  beforeEach(() => {
    nak = newNak();
    invalidateRevenueStatsCache();
  });

  it('cache miss returns null', () => {
    expect(getCachedRevenueStats('2024-06-01', '2024-06-07', NOW)).toBeNull();
  });

  it('cache hit returns the stored value', () => {
    const stats: ReturnType<typeof computeRevenueStats> = {
      fromDate: '2024-06-01',
      toDate: '2024-06-07',
      days: [], byPack: [], byPlatform: [],
      totalRevenue: { apple: 0, google: 0 },
      totalRefunds: 0,
      netRevenue: 0,
      purchaseCount: 0,
      uniqueBuyers: 0,
    };
    cacheRevenueStats('2024-06-01', '2024-06-07', stats, NOW);
    const got = getCachedRevenueStats('2024-06-01', '2024-06-07', NOW);
    expect(got).toEqual(stats);
  });

  it('cache entry expires after 60s', () => {
    const stats: ReturnType<typeof computeRevenueStats> = {
      fromDate: '2024-06-01',
      toDate: '2024-06-07',
      days: [], byPack: [], byPlatform: [],
      totalRevenue: { apple: 0, google: 0 },
      totalRefunds: 0,
      netRevenue: 0,
      purchaseCount: 0,
      uniqueBuyers: 0,
    };
    cacheRevenueStats('2024-06-01', '2024-06-07', stats, NOW);
    expect(getCachedRevenueStats('2024-06-01', '2024-06-07', NOW + 30_000)).toEqual(stats);
    expect(getCachedRevenueStats('2024-06-01', '2024-06-07', NOW + 60_001)).toBeNull();
  });

  it('invalidateRevenueStatsCache clears all entries', () => {
    const stats: ReturnType<typeof computeRevenueStats> = {
      fromDate: '2024-06-01',
      toDate: '2024-06-07',
      days: [], byPack: [], byPlatform: [],
      totalRevenue: { apple: 0, google: 0 },
      totalRefunds: 0,
      netRevenue: 0,
      purchaseCount: 0,
      uniqueBuyers: 0,
    };
    cacheRevenueStats('2024-06-01', '2024-06-07', stats, NOW);
    cacheRevenueStats('2024-06-08', '2024-06-14', stats, NOW);
    invalidateRevenueStatsCache();
    expect(getCachedRevenueStats('2024-06-01', '2024-06-07', NOW)).toBeNull();
    expect(getCachedRevenueStats('2024-06-08', '2024-06-14', NOW)).toBeNull();
  });

  it('cache key is per (fromDate, toDate) — different windows do not collide', () => {
    const stats1 = computeRevenueStats(nak.nakama, '2024-06-01', '2024-06-07');
    const stats2 = computeRevenueStats(nak.nakama, '2024-06-08', '2024-06-14');
    cacheRevenueStats('2024-06-01', '2024-06-07', stats1, NOW);
    cacheRevenueStats('2024-06-08', '2024-06-14', stats2, NOW);
    expect(getCachedRevenueStats('2024-06-01', '2024-06-07', NOW)).toEqual(stats1);
    expect(getCachedRevenueStats('2024-06-08', '2024-06-14', NOW)).toEqual(stats2);
  });
});
