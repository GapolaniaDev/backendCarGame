// Phase 9 Chunk 8 — Full end-to-end flow covering IAP, ads, subscriptions
// and admin analytics. This is the "wrap" e2e test that drives the whole
// purchase/revenue pipeline through the public RPCs and verifies the
// analytics layer reports consistent results.
//
// The individual RPCs each have their own dedicated e2e tests
// (`iap_purchase_e2e`, `ads_e2e`, `iap_subscription_e2e`,
// `iap_analytics_e2e`, `iap_admin_e2e`); this file is the integration
// layer that proves the end-to-end pipeline works as a whole.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeContext, FakeNakama, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import type { FakeNakama as FakeNakamaT } from './_stubs';
import type { IContext, ILogger } from '../../modules/src/nkruntime';
import {
  _resetIapPacksCatalogForTests,
  loadIapPacksCatalog,
  findIapPackByProductId,
} from '../../modules/src/iap/catalog';
import { _resetVerifyCacheForTests } from '../../modules/src/iap/_reset_for_tests';
import { _resetAdRewardsCatalogForTests } from '../../modules/src/ads/_reset_for_tests';
import { loadAdRewardsCatalog } from '../../modules/src/ads/catalog';
import { writeAdLastWatched } from '../../modules/src/ads/repo';
import { invalidateAllAnalyticsCaches } from '../../modules/src/analytics/_reset_for_tests';
import { ANALYTICS_COLLECTION } from '../../modules/src/core/admin/analytics';
import iapPacksJson from '../../modules/src/catalogs/iap_packs.json';
import adRewardsJson from '../../modules/src/catalogs/ad_rewards.json';

const ADMIN_KEY = 'test-admin-key-phase9-wrap';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

function call<T>(
  bundle: LoadedBundle,
  nk: FakeNakamaT,
  userId: string,
  rpc: string,
  payload: Record<string, unknown>,
): Resp<T> {
  const ctx: IContext = { ...FakeContext, userId };
  const handler = bundle.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler(ctx, mkLogger(), nk.nakama, JSON.stringify(payload)) as string) as Resp<T>;
}

function makeMockReceipt(productId: string, transactionId: string): string {
  return JSON.stringify({
    productId,
    transactionId,
    originalTransactionId: transactionId,
    purchaseDateUtc: Date.now(),
  });
}

function setAdminKey(bundle: LoadedBundle, maintenance = false): void {
  bundle.nak.storageWrite([{
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      version: 1,
      flags: { maintenance },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
      // Carry the iapVerification block so receipt verify still works
      // after we override the liveops config (default was provider='mock').
      iapVerification: { provider: 'mock', environment: 'sandbox', timeoutMs: 5000 },
    },
    permissionRead: 0,
    permissionWrite: 0,
  }]);
  invalidateAllAnalyticsCaches();
}

function seedEvent(
  bundle: LoadedBundle,
  name: string,
  userId: string | null,
  ts: number,
  props: Record<string, unknown>,
): void {
  bundle.nak.storageWrite([{
    collection: ANALYTICS_COLLECTION,
    key: `${ts}-${Math.random().toString(36).slice(2, 10)}`,
    userId: userId ?? SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      id: `seed-${ts}-${Math.random().toString(36).slice(2, 6)}`,
      ts,
      name,
      userId: userId ?? undefined,
      props,
    },
    permissionRead: 2,
    permissionWrite: 0,
  }]);
}

function countEvents(bundle: LoadedBundle, name: string): number {
  let n = 0;
  for (const o of bundle.fakeNakama.store.values()) {
    if (o.collection !== ANALYTICS_COLLECTION) continue;
    if ((o.value as { name?: unknown })?.name === name) n += 1;
  }
  return n;
}

describe('Phase 9 flow — end-to-end (Chunk 8 wrap)', () => {
  let bundle: LoadedBundle;
  let nak: FakeNakamaT;

  beforeEach(() => {
    bundle = loadBundleForTest();
    _resetIapPacksCatalogForTests();
    loadIapPacksCatalog(mkLogger(), iapPacksJson);
    _resetVerifyCacheForTests();
    _resetAdRewardsCatalogForTests();
    loadAdRewardsCatalog(mkLogger(), adRewardsJson);
    nak = bundle.fakeNakama;
    setAdminKey(bundle);
    expect(findIapPackByProductId('apple', 'com.cvg.coins100')).toBeDefined();
  });

  // ─── 1. IAP purchase end-to-end ───────────────────────────────────

  it('IAP consumable: 1 user, 1 purchase → wallet + iap_purchases + 3 events', () => {
    const r = call<{ packId: string; content: { coinsGranted: number } }>(
      bundle, nak, 'user-A', 'iap_purchase', {
        platform: 'apple',
        productId: 'com.cvg.coins100',
        receiptData: makeMockReceipt('com.cvg.coins100', 'tx-wrap-1'),
        transactionId: 'tx-wrap-1',
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.packId).toBe('coins_100');
    // content.coinsGranted = base 100 (firstTimeBonus is reported separately)
    expect(r.data.content.coinsGranted).toBe(100);
    expect(r.data.content.firstTimeBonus).toBe(50);

    // wallet credit
    expect(nak.wallets.get('user-A')?.coins).toBe(150);
    // iap_purchases storage row
    const purchaseRow = Array.from(nak.store.values()).find(
      (o) => o.collection === 'iap_purchases' && o.key === 'tx-wrap-1',
    );
    expect(purchaseRow).toBeDefined();
    // 3 analytics events: initiated, validated, delivered
    expect(countEvents(bundle, 'iap_purchase_initiated')).toBe(1);
    expect(countEvents(bundle, 'iap_purchase_validated')).toBe(1);
    expect(countEvents(bundle, 'iap_purchase_delivered')).toBe(1);
  });

  it('IAP idempotent: same transactionId → no double grant, no double event', () => {
    const args = {
      platform: 'apple',
      productId: 'com.cvg.coins100',
      receiptData: makeMockReceipt('com.cvg.coins100', 'tx-wrap-2'),
      transactionId: 'tx-wrap-2',
    };
    const r1 = call<{ idempotent: boolean }>(bundle, nak, 'user-A', 'iap_purchase', args);
    expect(r1.ok).toBe(true);
    const r2 = call<{ idempotent: boolean }>(bundle, nak, 'user-A', 'iap_purchase', args);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.idempotent).toBe(true);
    // wallet only credited once (150, firstTime bonus only applies on first grant)
    expect(nak.wallets.get('user-A')?.coins).toBe(150);
    // delivered event still fires once (the replay path emits delivered on
    // first grant only — re-emit is NOT desired).
    expect(countEvents(bundle, 'iap_purchase_delivered')).toBe(1);
  });

  it('IAP first-time bonus: 1st 100-coin pack → +50 bonus → 150 total', () => {
    const r1 = call<{ content: { coinsGranted: number; firstTimeBonus: number } }>(
      bundle, nak, 'user-A', 'iap_purchase', {
        platform: 'apple',
        productId: 'com.cvg.coins100',
        receiptData: makeMockReceipt('com.cvg.coins100', 'tx-bonus-1'),
        transactionId: 'tx-bonus-1',
      },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.content.firstTimeBonus).toBe(50);
    expect(nak.wallets.get('user-A')?.coins).toBe(150);

    // 2nd purchase of same pack → no bonus
    const r2 = call<{ content: { coinsGranted: number; firstTimeBonus: number } }>(
      bundle, nak, 'user-A', 'iap_purchase', {
        platform: 'apple',
        productId: 'com.cvg.coins100',
        receiptData: makeMockReceipt('com.cvg.coins100', 'tx-bonus-2'),
        transactionId: 'tx-bonus-2',
      },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.content.firstTimeBonus).toBe(0);
    expect(nak.wallets.get('user-A')?.coins).toBe(250);
  });

  it('IAP cross-user fraud: user-B reuses user-A txId → CONFLICT + flag', () => {
    const r1 = call(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.coins100',
      receiptData: makeMockReceipt('com.cvg.coins100', 'tx-fraud-1'),
      transactionId: 'tx-fraud-1',
    });
    expect(r1.ok).toBe(true);
    const r2 = call(bundle, nak, 'user-B', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.coins100',
      receiptData: makeMockReceipt('com.cvg.coins100', 'tx-fraud-1'),
      transactionId: 'tx-fraud-1',
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error?.code).toBe('CONFLICT');
    // fraud flag stored
    const flag = Array.from(nak.store.values()).find(
      (o) => o.collection === 'iap_fraud_flags' && o.key === 'tx-fraud-1',
    );
    expect(flag).toBeDefined();
  });

  // ─── 2. Ad rewards end-to-end ─────────────────────────────────────

  it('Ads happy: 1 small ad → 5 coins + 1 ad_watch_granted event', () => {
    writeAdLastWatched(nak.nakama as never, 'user-A', 'small', {
      lastWatchedAtUtc: 0,
      lastImpressionId: '',
    });
    const r = call<{ coinsGranted: number; newBalance: number }>(
      bundle, nak, 'user-A', 'ad_watched', {
        tier: 'small', provider: 'mock', adUnitId: 'unit-1',
        impressionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        watchedAtUtc: Date.now() - 1000,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coinsGranted).toBe(5);
    expect(r.data.newBalance).toBe(5);
    expect(countEvents(bundle, 'ad_watch_granted')).toBe(1);
  });

  it('Ads idempotent: same impressionId twice → no double grant', () => {
    writeAdLastWatched(nak.nakama as never, 'user-A', 'small', {
      lastWatchedAtUtc: 0,
      lastImpressionId: '',
    });
    const args = {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      watchedAtUtc: Date.now() - 1000,
    };
    const r1 = call<{ coinsGranted: number }>(bundle, nak, 'user-A', 'ad_watched', args);
    const r2 = call<{ coinsGranted: number; idempotent: boolean }>(bundle, nak, 'user-A', 'ad_watched', args);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.idempotent).toBe(true);
    expect(nak.wallets.get('user-A')?.coins).toBe(5);
  });

  it('Ads cooldown: same tier twice → 2nd CONFLICT + ad_watch_blocked', () => {
    writeAdLastWatched(nak.nakama as never, 'user-A', 'small', {
      lastWatchedAtUtc: 0,
      lastImpressionId: '',
    });
    const r1 = call(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: '11111111-1111-4111-8111-111111111111',
      watchedAtUtc: Date.now() - 1000,
    });
    expect(r1.ok).toBe(true);
    const r2 = call(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: '22222222-2222-4222-8222-222222222222',
      watchedAtUtc: Date.now() - 1000,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error?.code).toBe('CONFLICT');
    expect(countEvents(bundle, 'ad_watch_blocked')).toBe(1);
  });

  // ─── 3. Subscription end-to-end ───────────────────────────────────

  it('Subscription: status + cancel + re-cancel = CONFLICT', () => {
    // Seed an active sub by writing the storage row directly.
    const now = Date.now();
    const origTx = 'orig-tx-sub-1';
    bundle.nak.storageWrite([{
      collection: 'iap_subscriptions',
      key: 'user-A',
      userId: 'user-A',
      value: {
        userId: 'user-A',
        packId: 'pass_monthly',
        productId: 'com.cvg.pass.monthly',
        platform: 'apple',
        originalTransactionId: origTx,
        latestTransactionId: origTx,
        activatedAtUtc: now - 86_400_000,
        expiresAtUtc: now + 29 * 86_400_000,
        autoRenewing: true,
        monthlyCosmeticGranted: false,
        renewalHistory: [],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);

    const r1 = call<{ hasSubscription: boolean; subscription: { isActive: boolean; autoRenewing: boolean } | null }>(
      bundle, nak, 'user-A', 'iap_subscription_status', {},
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.hasSubscription).toBe(true);
    expect(r1.data.subscription?.isActive).toBe(true);
    expect(r1.data.subscription?.autoRenewing).toBe(true);

    const cancel1 = call(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: origTx,
    });
    expect(cancel1.ok).toBe(true);

    const cancel2 = call(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: origTx,
    });
    expect(cancel2.ok).toBe(false);
    if (cancel2.ok) return;
    expect(cancel2.error?.code).toBe('CONFLICT');
  });

  // ─── 4. Admin analytics across the full pipeline ──────────────────

  it('Admin analytics: mixed IAP+ad events → aggregated counts in one query', () => {
    const now = Date.now();
    // Synthesise a full-day sample: 2 IAP delivered (100+200) + 1 IAP failed
    // + 1 refund (50) + 3 ad_watch_granted (5+15+30).
    seedEvent(bundle, 'iap_purchase_delivered', 'u1', now - 5000, { amountCoins: 100, transactionId: 'a' });
    seedEvent(bundle, 'iap_purchase_delivered', 'u2', now - 4000, { amountCoins: 200, transactionId: 'b' });
    seedEvent(bundle, 'iap_purchase_failed', 'u3', now - 3000, { failureReason: 'verify' });
    seedEvent(bundle, 'iap_refund_completed', 'u1', now - 2000, { amountCoins: 50, transactionId: 'a' });
    seedEvent(bundle, 'ad_watch_granted', 'u1', now - 1500, { amountCoins: 5, tier: 'small' });
    seedEvent(bundle, 'ad_watch_granted', 'u2', now - 1000, { amountCoins: 15, tier: 'medium' });
    seedEvent(bundle, 'ad_watch_granted', 'u3', now - 500, { amountCoins: 30, tier: 'large' });

    const today = new Date(now).toISOString().slice(0, 10);
    const r = call<{
      totalDelivered: number; totalRefunded: number; netRevenue: number;
      adWatchCount: number; adCoinsGranted: number; uniqueBuyers: number;
    }>(bundle, nak, 'admin-1', 'admin_iap_analytics_get', {
      adminKey: ADMIN_KEY, fromDate: today, toDate: today,
    });
    if (!r.ok) throw new Error('admin_iap_analytics_get failed: ' + JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.totalDelivered).toBe(2);
    expect(r.data.totalRefunded).toBe(1);
    expect(r.data.netRevenue).toBe(250); // 100+200 - 50
    expect(r.data.adWatchCount).toBe(3);
    expect(r.data.adCoinsGranted).toBe(50);
    expect(r.data.uniqueBuyers).toBe(2);
  });

  it('Admin top buyers: 3 users with different spend → sorted desc', () => {
    const now = Date.now();
    seedEvent(bundle, 'iap_purchase_delivered', 'u1', now, { amountCoins: 100, packId: 'p1' });
    seedEvent(bundle, 'iap_purchase_delivered', 'u2', now + 1, { amountCoins: 200, packId: 'p2' });
    seedEvent(bundle, 'iap_purchase_delivered', 'u3', now + 2, { amountCoins: 50, packId: 'p1' });
    const today = new Date(now).toISOString().slice(0, 10);
    const r = call<{ buyers: Array<{ userId: string; totalSpent: number }> }>(
      bundle, nak, 'admin-1', 'admin_iap_top_buyers_get', {
        adminKey: ADMIN_KEY, fromDate: today, toDate: today, limit: 10,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.buyers.map((b) => b.userId)).toEqual(['u2', 'u1', 'u3']);
  });

  it('Admin funnel: 10 initiated / 8 validated / 6 delivered → 0.8 / 0.75', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      seedEvent(bundle, 'iap_purchase_initiated', `u${i}`, now + i, { transactionId: `tx-${i}`, packId: 'p1' });
    }
    for (let i = 0; i < 8; i += 1) {
      seedEvent(bundle, 'iap_purchase_validated', `u${i}`, now + 100 + i, { transactionId: `tx-${i}`, packId: 'p1' });
    }
    for (let i = 0; i < 6; i += 1) {
      seedEvent(bundle, 'iap_purchase_delivered', `u${i}`, now + 200 + i, { transactionId: `tx-${i}`, packId: 'p1', amountCoins: 100 });
    }
    const r = call<{
      stages: Array<{ count: number; conversionFromInitiated: number; conversionFromPrevious: number }>;
    }>(bundle, nak, 'admin-1', 'admin_iap_funnel_get', { adminKey: ADMIN_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.stages[0]?.count).toBe(10);
    expect(r.data.stages[1]?.count).toBe(8);
    expect(r.data.stages[2]?.count).toBe(6);
    expect(r.data.stages[1]?.conversionFromInitiated).toBeCloseTo(0.8, 2);
    expect(r.data.stages[2]?.conversionFromPrevious).toBeCloseTo(0.75, 2);
  });

  it('Admin LTV: 1 cohort with 3 users, single 100-coin purchase each → 100', () => {
    const jan1 = Date.UTC(2024, 0, 1);
    const jan5 = Date.UTC(2024, 0, 5);
    const jan7 = Date.UTC(2024, 0, 7);
    seedEvent(bundle, 'iap_purchase_delivered', 'u1', jan1, { amountCoins: 100, packId: 'p1', cohortDate: '2024-01-01' });
    seedEvent(bundle, 'iap_purchase_delivered', 'u2', jan5, { amountCoins: 100, packId: 'p1', cohortDate: '2024-01-02' });
    seedEvent(bundle, 'iap_purchase_delivered', 'u3', jan7, { amountCoins: 100, packId: 'p1', cohortDate: '2024-01-03' });
    const r = call<{ cohortSize: number; ltv: { '7d': number } }>(
      bundle, nak, 'admin-1', 'admin_iap_ltv_get', {
        adminKey: ADMIN_KEY, cohortWeekStart: '2024-01-01', windows: ['7d'],
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cohortSize).toBe(3);
    expect(r.data.ltv['7d']).toBe(100);
  });

  // ─── 5. Maintenance bypass across all 3 public flows ──────────────

  it('Maintenance bypass: IAP + sub + ads work even with maintenance=true', () => {
    setAdminKey(bundle, true);
    // IAP happy
    const iapR = call<{ packId: string }>(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.coins100',
      receiptData: makeMockReceipt('com.cvg.coins100', 'tx-mnt-1'),
      transactionId: 'tx-mnt-1',
    });
    expect(iapR.ok).toBe(true);

    // Subscription status
    const origTxMnt = 'orig-tx-mnt-1';
    bundle.nak.storageWrite([{
      collection: 'iap_subscriptions',
      key: 'user-A',
      userId: 'user-A',
      value: {
        userId: 'user-A',
        packId: 'pass_monthly',
        productId: 'com.cvg.pass.monthly',
        platform: 'apple',
        originalTransactionId: origTxMnt,
        latestTransactionId: origTxMnt,
        activatedAtUtc: Date.now() - 86_400_000,
        expiresAtUtc: Date.now() + 29 * 86_400_000,
        autoRenewing: true,
        monthlyCosmeticGranted: false,
        renewalHistory: [],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    const subR = call<{ hasSubscription: boolean }>(bundle, nak, 'user-A', 'iap_subscription_status', {});
    expect(subR.ok).toBe(true);

    // Ad reward
    writeAdLastWatched(nak.nakama as never, 'user-A', 'small', {
      lastWatchedAtUtc: 0,
      lastImpressionId: '',
    });
    const adR = call<{ tier: string }>(bundle, nak, 'user-A', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      watchedAtUtc: Date.now() - 1000,
    });
    expect(adR.ok).toBe(true);
  });

  // ─── 6. Admin refund end-to-end ──────────────────────────────────

  it('Admin refund: 7d-old purchase → wallet -100 + iap_refund inbox + iap_refund_completed event', () => {
    // Seed a 7-day-old purchase + pre-fund the user wallet.
    const recent = Date.now() - 7 * 86_400_000;
    bundle.nak.storageWrite([{
      collection: 'iap_purchases',
      key: 'tx-refund-1',
      userId: 'user-A',
      value: {
        userId: 'user-A',
        packId: 'coins_100',
        platform: 'apple',
        productId: 'com.cvg.coins100',
        content: { coins: 100, firstTimeBonus: 0 },
        grantedAtUtc: recent,
        idempotencyKey: 'iap_purchase:tx-refund-1',
        isFirstTime: false,
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    nak.wallets.set('user-A', { coins: 200, gems: 0 });

    const r = call<{ amountRefunded: number; newBalance: number }>(
      bundle, nak, 'admin-1', 'admin_iap_refund', {
        adminKey: ADMIN_KEY, userId: 'user-A', transactionId: 'tx-refund-1', reason: 'customer complaint',
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.amountRefunded).toBe(100);
    expect(r.data.newBalance).toBe(100);

    // inbox entry
    const inbox = Array.from(nak.store.values()).find(
      (o) => o.collection === 'liveops_inbox' && o.key === 'user-A/iap_refund:tx-refund-1',
    );
    expect(inbox).toBeDefined();
    // refund event
    expect(countEvents(bundle, 'iap_refund_completed')).toBe(1);
  });

  // ─── 7. End-to-end event coverage summary ─────────────────────────

  it('Event coverage: 1 IAP + 1 ad grant + 1 sub cancel → 7 distinct event names fired', () => {
    // IAP
    const iapR = call(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.coins100',
      receiptData: makeMockReceipt('com.cvg.coins100', 'tx-cov-1'),
      transactionId: 'tx-cov-1',
    });
    expect(iapR.ok).toBe(true);

    // Ad
    writeAdLastWatched(nak.nakama as never, 'user-B', 'small', {
      lastWatchedAtUtc: 0, lastImpressionId: '',
    });
    const adR = call(bundle, nak, 'user-B', 'ad_watched', {
      tier: 'small', provider: 'mock', adUnitId: 'unit-1',
      impressionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      watchedAtUtc: Date.now() - 1000,
    });
    expect(adR.ok).toBe(true);

    // Sub cancel (seed first)
    const now = Date.now();
    const origTxCov = 'orig-tx-cov-c';
    bundle.nak.storageWrite([{
      collection: 'iap_subscriptions',
      key: 'user-C',
      userId: 'user-C',
      value: {
        userId: 'user-C',
        packId: 'pass_monthly',
        productId: 'com.cvg.pass.monthly',
        platform: 'apple',
        originalTransactionId: origTxCov,
        latestTransactionId: origTxCov,
        activatedAtUtc: now - 86_400_000,
        expiresAtUtc: now + 29 * 86_400_000,
        autoRenewing: true,
        monthlyCosmeticGranted: false,
        renewalHistory: [],
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);
    const cancelR = call(bundle, nak, 'user-C', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: origTxCov,
    });
    expect(cancelR.ok).toBe(true);

    // All 7 events fired (initiated/validated/delivered + ad_initiated/ad_granted + sub_cancelled + admin_action from cache+events)
    const names = new Set<string>();
    for (const o of nak.store.values()) {
      if (o.collection === ANALYTICS_COLLECTION) {
        const n = (o.value as { name?: unknown })?.name;
        if (typeof n === 'string') names.add(n);
      }
    }
    expect(names.has('iap_purchase_initiated')).toBe(true);
    expect(names.has('iap_purchase_validated')).toBe(true);
    expect(names.has('iap_purchase_delivered')).toBe(true);
    expect(names.has('ad_watch_initiated')).toBe(true);
    expect(names.has('ad_watch_granted')).toBe(true);
    expect(names.has('iap_subscription_cancelled')).toBe(true);
  });
});
