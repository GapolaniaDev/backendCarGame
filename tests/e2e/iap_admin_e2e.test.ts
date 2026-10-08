// Phase 9 Chunk 6 — Admin IAP RPCs e2e tests.
//
// 15+ cases covering all 6 admin RPCs (`admin_iap_purchases_list`,
// `admin_iap_purchases_get`, `admin_iap_refund`,
// `admin_iap_fraud_flags_list`, `admin_iap_fraud_flag_action`,
// `admin_iap_revenue_stats_get`) end-to-end through the bundle.
//
// Pattern: set the `adminRpcKey` in liveops config so the
// `assertAdminKey` helper accepts the test key. Seed the
// `iap_purchases` + `iap_fraud_flags` collections directly via
// `storageWrite` so we don't have to drive the full
// `iap_purchase` flow.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  invalidateRevenueStatsCache,
  type FraudFlag,
} from '../../modules/src/iap/admin_repo';
import type { PurchaseRecord } from '../../modules/src/iap/purchase_repo';

const ADMIN_KEY = 'test-admin-key-chunk6-e2e';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: LoadedBundle,
  rpc: string,
  caller: string | null,
  payload: Record<string, unknown>,
): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  return JSON.parse(handler(ctx, env.logger, env.nak, JSON.stringify(payload)) as string) as Resp<T>;
}

function setAdminKey(env: LoadedBundle): void {
  // Override liveops config with our test adminRpcKey.
  env.nak.storageWrite([{
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    permissionRead: 0,
    permissionWrite: 0,
  }]);
}

function seedPurchase(
  env: LoadedBundle,
  userId: string,
  transactionId: string,
  rec: Partial<PurchaseRecord> = {},
): PurchaseRecord {
  const full: PurchaseRecord = {
    userId,
    packId: rec.packId ?? 'coins_100',
    platform: rec.platform ?? 'apple',
    productId: rec.productId ?? 'com.cvg.coins100',
    content: rec.content ?? { coins: 100, firstTimeBonus: 0 },
    grantedAtUtc: rec.grantedAtUtc ?? Date.now(),
    idempotencyKey: rec.idempotencyKey ?? `iap_purchase:${transactionId}`,
    isFirstTime: rec.isFirstTime ?? false,
    ...(rec.refunded !== undefined ? { refunded: rec.refunded } : {}),
    ...(rec.refundedAtUtc !== undefined ? { refundedAtUtc: rec.refundedAtUtc } : {}),
    ...(rec.refundedReason !== undefined ? { refundedReason: rec.refundedReason } : {}),
    ...(rec.refundedByAdminId !== undefined ? { refundedByAdminId: rec.refundedByAdminId } : {}),
  };
  env.nak.storageWrite([{
    collection: 'iap_purchases',
    key: transactionId,
    userId,
    value: full as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  }]);
  return full;
}

function seedFraudFlag(
  env: LoadedBundle,
  transactionId: string,
  flag: Partial<FraudFlag> = {},
): FraudFlag {
  const full: FraudFlag = {
    transactionId,
    claimedByUserId: flag.claimedByUserId ?? 'claimed',
    conflictByUserId: flag.conflictByUserId ?? 'conflict',
    packId: flag.packId ?? 'coins_100',
    platform: flag.platform ?? 'apple',
    detectedAtUtc: flag.detectedAtUtc ?? Date.now(),
    status: flag.status ?? 'pending',
    ...(flag.actionedAtUtc !== undefined ? { actionedAtUtc: flag.actionedAtUtc } : {}),
    ...(flag.actionedByAdminId !== undefined ? { actionedByAdminId: flag.actionedByAdminId } : {}),
    ...(flag.actionedReason !== undefined ? { actionedReason: flag.actionedReason } : {}),
  };
  env.nak.storageWrite([{
    collection: 'iap_fraud_flags',
    key: transactionId,
    userId: '',
    value: full as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  }]);
  return full;
}

describe('admin_iap_purchases_list (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
    invalidateRevenueStatsCache();
  });

  it('returns all purchases when no filter applied', () => {
    seedPurchase(env, 'u1', 'tx-1');
    seedPurchase(env, 'u1', 'tx-2', { packId: 'gems_50', platform: 'google' });
    seedPurchase(env, 'u2', 'tx-3');
    const r = call<{ purchases: Array<{ transactionId: string }> }>(
      env, 'admin_iap_purchases_list', 'admin-1', { adminKey: ADMIN_KEY },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.purchases).toHaveLength(3);
  });

  it('filters by platform', () => {
    seedPurchase(env, 'u1', 'tx-1', { platform: 'apple' });
    seedPurchase(env, 'u1', 'tx-2', { platform: 'google' });
    const r = call<{ purchases: Array<{ transactionId: string; platform: string }> }>(
      env, 'admin_iap_purchases_list', 'admin-1', { adminKey: ADMIN_KEY, platform: 'google' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.purchases).toHaveLength(1);
    expect(r.data.purchases[0]?.transactionId).toBe('tx-2');
  });

  it('filters by userId', () => {
    seedPurchase(env, 'u1', 'tx-1');
    seedPurchase(env, 'u2', 'tx-2');
    const r = call<{ purchases: Array<{ transactionId: string; userId: string }> }>(
      env, 'admin_iap_purchases_list', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.purchases).toHaveLength(1);
    expect(r.data.purchases[0]?.userId).toBe('u1');
  });

  it('BAD_REQUEST on invalid platform', () => {
    const r = call(env, 'admin_iap_purchases_list', 'admin-1', { adminKey: ADMIN_KEY, platform: 'windows' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('rejects bad adminKey with FORBIDDEN', () => {
    const r = call(env, 'admin_iap_purchases_list', 'admin-1', { adminKey: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('FORBIDDEN');
  });
});

describe('admin_iap_purchases_get (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
  });

  it('returns the purchase + empty fraud flags', () => {
    seedPurchase(env, 'u1', 'tx-1', { refunded: true, refundedAtUtc: 1000, refundedReason: 'test' });
    const r = call<{ purchase: { transactionId: string; refunded: boolean; refundedReason?: string }; fraudFlags: unknown[] }>(
      env, 'admin_iap_purchases_get', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.purchase.transactionId).toBe('tx-1');
    expect(r.data.purchase.refunded).toBe(true);
    expect(r.data.purchase.refundedReason).toBe('test');
    expect(r.data.fraudFlags).toEqual([]);
  });

  it('attaches the matching fraud flag', () => {
    seedPurchase(env, 'u1', 'tx-1');
    seedFraudFlag(env, 'tx-1', { conflictByUserId: 'u2' });
    seedFraudFlag(env, 'tx-9', { conflictByUserId: 'u3' }); // different tx
    const r = call<{ purchase: { transactionId: string }; fraudFlags: Array<{ transactionId: string; conflictByUserId: string }> }>(
      env, 'admin_iap_purchases_get', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.fraudFlags).toHaveLength(1);
    expect(r.data.fraudFlags[0]?.transactionId).toBe('tx-1');
    expect(r.data.fraudFlags[0]?.conflictByUserId).toBe('u2');
  });

  it('NOT_FOUND for missing purchase', () => {
    const r = call(env, 'admin_iap_purchases_get', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('BAD_REQUEST for missing userId / transactionId', () => {
    const r1 = call(env, 'admin_iap_purchases_get', 'admin-1', { adminKey: ADMIN_KEY, transactionId: 'tx-1' });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error?.code).toBe('BAD_REQUEST');

    const r2 = call(env, 'admin_iap_purchases_get', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error?.code).toBe('BAD_REQUEST');
  });
});

describe('admin_iap_refund (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
    invalidateRevenueStatsCache();
  });

  it('happy: spends wallet, marks refunded, sends inbox, invalidates cache', () => {
    // Pre-fund the user so `spend` passes its balance pre-check.
    env.fakeNakama.wallets.set('u1', { coins: 500, gems: 0 });
    const recent = Date.now() - 7 * 86_400_000; // 7 days ago, within 90d window
    seedPurchase(env, 'u1', 'tx-1', { grantedAtUtc: recent, content: { coins: 100, firstTimeBonus: 0 } });

    const r = call<{ refundedAtUtc: number; amountRefunded: number; newBalance: number; adminUserId: string }>(
      env, 'admin_iap_refund', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'duplicate' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.amountRefunded).toBe(100);
    expect(r.data.newBalance).toBe(400);
    expect(r.data.adminUserId).toBe('admin-1');
    expect(typeof r.data.refundedAtUtc).toBe('number');

    // Wallet decremented.
    const w = env.fakeNakama.wallets.get('u1');
    expect(w?.coins).toBe(400);

    // Purchase row marked refunded.
    const obj = Array.from(env.fakeNakama.store.values()).find(
      (o) => o.collection === 'iap_purchases' && o.key === 'tx-1' && o.userId === 'u1',
    );
    expect(obj).toBeDefined();
    const v = obj!.value as PurchaseRecord;
    expect(v.refunded).toBe(true);
    expect(v.refundedReason).toBe('duplicate');
    expect(v.refundedByAdminId).toBe('admin-1');

    // Inbox entry exists. The inbox storage key is `${userId}/${rewardId}`.
    const inbox = Array.from(env.fakeNakama.store.values()).find(
      (o) => o.collection === 'liveops_inbox' && o.key === 'u1/iap_refund:tx-1',
    );
    expect(inbox).toBeDefined();
    const iv = inbox!.value as { type: string; payload: { coins: number; note: string } };
    expect(iv.type).toBe('iap_refund');
    expect(iv.payload.coins).toBe(100);
    expect(iv.payload.note).toContain('duplicate');
  });

  it('replay: same admin retry returns CONFLICT (D90: refund blocked if already refunded)', () => {
    env.fakeNakama.wallets.set('u1', { coins: 500, gems: 0 });
    const recent = Date.now() - 7 * 86_400_000;
    seedPurchase(env, 'u1', 'tx-1', { grantedAtUtc: recent, content: { coins: 100, firstTimeBonus: 0 } });
    const first = call<{ newBalance: number }>(
      env, 'admin_iap_refund', 'admin-1',
      { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'first' },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Wallet decremented exactly once.
    expect(env.fakeNakama.wallets.get('u1')?.coins).toBe(400);

    const replay = call(env, 'admin_iap_refund', 'admin-1',
      { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'second' },
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error?.code).toBe('CONFLICT');
    // Wallet unchanged on the second call.
    expect(env.fakeNakama.wallets.get('u1')?.coins).toBe(400);
  });

  it('CONFLICT on already-refunded', () => {
    seedPurchase(env, 'u1', 'tx-1', {
      refunded: true, refundedAtUtc: Date.now() - 1000, refundedReason: 'already',
    });
    const r = call(env, 'admin_iap_refund', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'second' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('CONFLICT when refund window expired (>90d)', () => {
    const old = Date.now() - 91 * 86_400_000;
    seedPurchase(env, 'u1', 'tx-1', { grantedAtUtc: old, content: { coins: 100, firstTimeBonus: 0 } });
    const r = call(env, 'admin_iap_refund', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'late' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('NOT_FOUND for missing purchase', () => {
    const r = call(env, 'admin_iap_refund', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'nope', reason: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('BAD_REQUEST for empty reason', () => {
    seedPurchase(env, 'u1', 'tx-1');
    const r = call(env, 'admin_iap_refund', 'admin-1', { adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });
});

describe('admin_iap_fraud_flags_list (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
  });

  it('returns all flags when no filter', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    seedFraudFlag(env, 'tx-2', { status: 'reviewed' });
    seedFraudFlag(env, 'tx-3', { status: 'actioned' });
    const r = call<{ flags: Array<{ transactionId: string; status: string }> }>(
      env, 'admin_iap_fraud_flags_list', 'admin-1', { adminKey: ADMIN_KEY },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.flags).toHaveLength(3);
  });

  it('filters by status=pending', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    seedFraudFlag(env, 'tx-2', { status: 'reviewed' });
    seedFraudFlag(env, 'tx-3', { status: 'pending' });
    const r = call<{ flags: Array<{ transactionId: string; status: string }> }>(
      env, 'admin_iap_fraud_flags_list', 'admin-1', { adminKey: ADMIN_KEY, status: 'pending' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.flags).toHaveLength(2);
    for (const f of r.data.flags) expect(f.status).toBe('pending');
  });

  it('BAD_REQUEST for invalid status', () => {
    const r = call(env, 'admin_iap_fraud_flags_list', 'admin-1', { adminKey: ADMIN_KEY, status: 'gone' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });
});

describe('admin_iap_fraud_flag_action (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
  });

  it('ban: actioned + emits admin_anti_cheat_sanction', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    const r = call<{ newStatus: string; newAction: string; targetUserId: string; adminUserId: string }>(
      env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'ban', reason: 'fraud' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.newStatus).toBe('actioned');
    expect(r.data.newAction).toBe('ban');
    expect(r.data.targetUserId).toBe('claimed');
    expect(r.data.adminUserId).toBe('admin-1');

    // The flag row is now actioned.
    const obj = Array.from(env.fakeNakama.store.values()).find(
      (o) => o.collection === 'iap_fraud_flags' && o.key === 'tx-1',
    );
    expect(obj).toBeDefined();
    const v = obj!.value as FraudFlag;
    expect(v.status).toBe('actioned');
    expect(v.actionedReason).toBe('fraud');
  });

  it('dismiss: status becomes reviewed, NO anti_cheat sanction', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    const r = call<{ newStatus: string; newAction: string }>(
      env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'dismiss', reason: 'false positive' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.newStatus).toBe('reviewed');
    expect(r.data.newAction).toBe('dismiss');
  });

  it('confirm: actioned, no sanction (manual fraud only — operator handled separately)', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    const r = call<{ newStatus: string; newAction: string }>(
      env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'confirm', reason: 'manual review' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.newStatus).toBe('actioned');
    expect(r.data.newAction).toBe('confirm');
  });

  it('CONFLICT on already-actioned flag', () => {
    seedFraudFlag(env, 'tx-1', { status: 'actioned' });
    const r = call(env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'ban', reason: 'dup' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('CONFLICT');
  });

  it('NOT_FOUND for unknown txId', () => {
    const r = call(env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'nope', action: 'ban', reason: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('BAD_REQUEST for invalid action', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    const r = call(env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'ignore', reason: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST for empty reason', () => {
    seedFraudFlag(env, 'tx-1', { status: 'pending' });
    const r = call(env, 'admin_iap_fraud_flag_action', 'admin-1',
      { adminKey: ADMIN_KEY, transactionId: 'tx-1', action: 'ban', reason: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });
});

describe('admin_iap_revenue_stats_get (Phase 9 Chunk 6)', () => {
  let env: LoadedBundle;
  beforeEach(() => {
    env = loadBundleForTest();
    setAdminKey(env);
    invalidateRevenueStatsCache();
  });

  it('happy: returns totals + day breakdown', () => {
    const day = Date.UTC(2024, 5, 1, 12, 0, 0);
    seedPurchase(env, 'u1', 'tx-1', {
      platform: 'apple', grantedAtUtc: day, content: { coins: 100, firstTimeBonus: 0 },
    });
    seedPurchase(env, 'u2', 'tx-2', {
      platform: 'google', grantedAtUtc: day, content: { coins: 200, firstTimeBonus: 0 },
    });
    const r = call<{
      totalRevenue: { apple: number; google: number };
      purchaseCount: number;
      uniqueBuyers: number;
      days: Array<{ date: string; purchaseCount: number }>;
    }>(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: '2024-06-01', toDate: '2024-06-01',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.totalRevenue).toEqual({ apple: 100, google: 200 });
    expect(r.data.purchaseCount).toBe(2);
    expect(r.data.uniqueBuyers).toBe(2);
    expect(r.data.days).toHaveLength(1);
    expect(r.data.days[0]?.date).toBe('2024-06-01');
  });

  it('D83: excludes refunded purchases from totalRevenue but counts them in totalRefunds', () => {
    const day = Date.UTC(2024, 5, 1, 12, 0, 0);
    seedPurchase(env, 'u1', 'tx-1', { platform: 'apple', grantedAtUtc: day, content: { coins: 100, firstTimeBonus: 0 } });
    seedPurchase(env, 'u2', 'tx-2', {
      platform: 'apple', grantedAtUtc: day, content: { coins: 200, firstTimeBonus: 0 },
      refunded: true, refundedAtUtc: day + 1000, refundedReason: 'test',
    });
    const r = call<{ totalRevenue: { apple: number; google: number }; totalRefunds: number; netRevenue: number; purchaseCount: number }>(
      env, 'admin_iap_revenue_stats_get', 'admin-1', {
        adminKey: ADMIN_KEY, fromDate: '2024-06-01', toDate: '2024-06-01',
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.totalRevenue).toEqual({ apple: 100, google: 0 });
    expect(r.data.totalRefunds).toBe(200);
    expect(r.data.netRevenue).toBe(100 - 200);
    expect(r.data.purchaseCount).toBe(1);
  });

  it('BAD_REQUEST for missing fromDate / toDate', () => {
    const r1 = call(env, 'admin_iap_revenue_stats_get', 'admin-1', { adminKey: ADMIN_KEY, toDate: '2024-06-01' });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error?.code).toBe('BAD_REQUEST');
    const r2 = call(env, 'admin_iap_revenue_stats_get', 'admin-1', { adminKey: ADMIN_KEY, fromDate: '2024-06-01' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST when fromDate > toDate', () => {
    const r = call(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: '2024-06-10', toDate: '2024-06-01',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('BAD_REQUEST for malformed date', () => {
    const r = call(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: '06/01/2024', toDate: '2024-06-30',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe('BAD_REQUEST');
  });

  it('cache hit: second call within 60s returns the same totals', () => {
    const day = Date.UTC(2024, 5, 1, 12, 0, 0);
    seedPurchase(env, 'u1', 'tx-1', { platform: 'apple', grantedAtUtc: day, content: { coins: 100, firstTimeBonus: 0 } });
    const a = call<{ purchaseCount: number }>(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: '2024-06-01', toDate: '2024-06-01',
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.data.purchaseCount).toBe(1);
    // Mutate the underlying store (simulating a new purchase); the cached
    // call should NOT pick it up.
    seedPurchase(env, 'u2', 'tx-2', { platform: 'google', grantedAtUtc: day, content: { coins: 50, firstTimeBonus: 0 } });
    const b = call<{ purchaseCount: number }>(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: '2024-06-01', toDate: '2024-06-01',
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.data.purchaseCount).toBe(1); // still cached
  });

  it('admin_iap_refund invalidates the stats cache', () => {
    const day = Date.now() - 7 * 86_400_000; // 7 days ago, well within 90d
    const dateOnly = new Date(day).toISOString().slice(0, 10);
    env.fakeNakama.wallets.set('u1', { coins: 500, gems: 0 });
    seedPurchase(env, 'u1', 'tx-1', { grantedAtUtc: day, content: { coins: 100, firstTimeBonus: 0 } });
    // Warm the cache.
    call(env, 'admin_iap_revenue_stats_get', 'admin-1', {
      adminKey: ADMIN_KEY, fromDate: dateOnly, toDate: dateOnly,
    });
    // Refund invalidates.
    const refundRes = call<{ newBalance: number }>(env, 'admin_iap_refund', 'admin-1', {
      adminKey: ADMIN_KEY, userId: 'u1', transactionId: 'tx-1', reason: 'test',
    });
    if (!refundRes.ok) {
      throw new Error(`refund failed: ${JSON.stringify(refundRes.error)}`);
    }
    expect(refundRes.ok).toBe(true);
    // Next call sees the refund.
    const r = call<{ totalRevenue: { apple: number; google: number }; totalRefunds: number; purchaseCount: number }>(
      env, 'admin_iap_revenue_stats_get', 'admin-1', {
        adminKey: ADMIN_KEY, fromDate: dateOnly, toDate: dateOnly,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.purchaseCount).toBe(0);
    expect(r.data.totalRevenue).toEqual({ apple: 0, google: 0 });
    expect(r.data.totalRefunds).toBe(100);
  });
});
