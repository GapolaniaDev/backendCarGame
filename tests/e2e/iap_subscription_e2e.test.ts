// Phase 9 Chunk 4 — e2e tests for subscription lifecycle.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeNakama, FakeContext } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  _resetVerifyCacheForTests,
  stopSubscriptionScanner,
} from '../../modules/src/iap/_reset_for_tests';
import {
  loadIapPacksCatalog,
  _resetIapPacksCatalogForTests,
  findIapPackByProductId,
} from '../../modules/src/iap/catalog';
import iapPacksJson from '../../modules/src/catalogs/iap_packs.json';
import { writeSubscriptionCreate, readSubscription } from '../../modules/src/iap/subscription_repo';
import { scanOnce } from '../../modules/src/iap/subscription_scanner';
import { IapSubscription } from '../../modules/src/iap/subscription';
import type { FakeNakama as FakeNakamaT } from './_stubs';
import type { IContext, ILogger } from '../../modules/src/nkruntime';

const MS_PER_DAY = 86_400_000;
/** The bundle's runtime uses Date.now() — so test data must be relative to that. */
const REAL_NOW = Date.now();

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

function makeMockSubReceipt(
  productId: string,
  transactionId: string,
  originalTransactionId: string,
  expiresAtUtc: number,
): string {
  return JSON.stringify({
    productId,
    transactionId,
    originalTransactionId,
    purchaseDateUtc: REAL_NOW,
    expiresAtUtc,
  });
}

function callRpc(
  bundle: LoadedBundle,
  nk: FakeNakamaT,
  userId: string,
  rpcName: string,
  payload: Record<string, unknown>,
): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } {
  const ctx: IContext = { ...FakeContext, userId };
  const handler = bundle.resolver(rpcName);
  if (!handler) throw new Error(`${rpcName} RPC not registered`);
  const raw = handler(ctx, mkLogger(), nk.nakama, JSON.stringify(payload));
  return JSON.parse(raw) as ReturnType<typeof callRpc>;
}

describe('iap subscription e2e (Phase 9 Chunk 4)', () => {
  let bundle: LoadedBundle;
  let nak: FakeNakamaT;

  beforeEach(() => {
    bundle = loadBundleForTest();
    _resetIapPacksCatalogForTests();
    loadIapPacksCatalog(mkLogger(), iapPacksJson);
    _resetVerifyCacheForTests();
    stopSubscriptionScanner();
    nak = new FakeNakama();
    // Confirm the catalog has the subscription pack.
    expect(findIapPackByProductId('apple', 'com.cvg.monthlypass')).toBeDefined();
  });

  // ─── iap_subscription_status ─────────────────────────────────────────

  it('status with no subscription → {hasSubscription: false}', () => {
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_status', {});
    expect(r.ok).toBe(true);
    expect(r.data!.hasSubscription).toBe(false);
  });

  it('status with active subscription → {hasSubscription: true, ...}', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_status', {});
    expect(r.ok).toBe(true);
    expect(r.data!.hasSubscription).toBe(true);
    const s = r.data!.subscription as Record<string, unknown>;
    expect(s.packId).toBe('monthly_pass');
    expect(s.isActive).toBe(true);
    expect(s.renewalCount).toBe(0);
  });

  it('status shows cancelled but still active (Apple/Google behavior)', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      cancelledAtUtc: REAL_NOW - 1 * MS_PER_DAY,
      autoRenewing: false,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_status', {});
    expect(r.ok).toBe(true);
    const s = r.data!.subscription as Record<string, unknown>;
    expect(s.isActive).toBe(true);
    expect(s.autoRenewing).toBe(false);
    expect(s.cancelledAtUtc).toBe(REAL_NOW - 1 * MS_PER_DAY);
  });

  it('status shows expired (past expiresAtUtc)', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 40 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      autoRenewing: false,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_status', {});
    const s = r.data!.subscription as Record<string, unknown>;
    expect(s.isActive).toBe(false);
    expect(s.isExpired).toBe(true);
    expect(s.timeRemainingMs).toBe(0);
  });

  // ─── iap_subscription_cancel ─────────────────────────────────────────

  it('cancel on active sub sets cancelledAtUtc + autoRenewing=false', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: 'tx-1',
    });
    expect(r.ok).toBe(true);
    const data = r.data!;
    expect(data.cancelledAtUtc).toBeGreaterThan(0);
    expect(data.willRemainActiveUntilUtc).toBe(REAL_NOW + 25 * MS_PER_DAY);
    const after = readSubscription(nak.nakama, 'user-A');
    expect(after!.cancelledAtUtc).toBeDefined();
    expect(after!.autoRenewing).toBe(false);
  });

  it('cancel on already-cancelled sub → CONFLICT', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      cancelledAtUtc: REAL_NOW - 1 * MS_PER_DAY,
      autoRenewing: false,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: 'tx-1',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CONFLICT');
  });

  it('cancel with mismatched transactionId → BAD_REQUEST', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: 'wrong-tx',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('cancel with no subscription → NOT_FOUND', () => {
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: 'tx-1',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('NOT_FOUND');
  });

  it('cancel accepts the originalTransactionId (first-activation case)', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'orig-1',
      activatedAtUtc: REAL_NOW - 5 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 25 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: false,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', {
      platform: 'apple', transactionId: 'orig-1',
    });
    expect(r.ok).toBe(true);
  });

  it('cancel: BAD_REQUEST when platform is missing', () => {
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', { transactionId: 'tx-1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  it('cancel: BAD_REQUEST when transactionId is missing', () => {
    const r = callRpc(bundle, nak, 'user-A', 'iap_subscription_cancel', { platform: 'apple' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('BAD_REQUEST');
  });

  // ─── iap_purchase subscription flow ──────────────────────────────────

  it('iap_purchase: subscription first activation creates record + monthly grant', () => {
    const r = callRpc(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-sub-1', 'orig-1', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-sub-1',
      originalTransactionId: 'orig-1',
    });
    if (!r.ok) throw new Error('iap_purchase sub failed: ' + JSON.stringify(r));
    const sub = readSubscription(nak.nakama, 'user-A');
    expect(sub).toBeDefined();
    expect(sub!.packId).toBe('monthly_pass');
    expect(sub!.originalTransactionId).toBe('orig-1');
    expect(sub!.latestTransactionId).toBe('tx-sub-1');
    expect(sub!.expiresAtUtc).toBeGreaterThan(REAL_NOW);
    expect(sub!.expiresAtUtc).toBeLessThan(REAL_NOW + 31 * MS_PER_DAY);
    expect(sub!.monthlyCosmeticGranted).toBe(true);
    // Monthly cosmetic in the garage bag.
    const g = nak.store.get('garage/user-A/user-A');
    const bag = (g?.value as { cosmeticsBag: string[] } | undefined)?.cosmeticsBag ?? [];
    expect(bag).toContain('pass_exclusive_01');
  });

  it('iap_purchase: renewal extends expiresAtUtc + grants monthly again', () => {
    // First activation.
    const r1 = callRpc(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-sub-1', 'orig-1', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-sub-1',
      originalTransactionId: 'orig-1',
    });
    if (!r1.ok) throw new Error('first activation failed: ' + JSON.stringify(r1));
    const firstSub = readSubscription(nak.nakama, 'user-A');
    const firstExpiry = firstSub!.expiresAtUtc;
    // Renewal: same originalTransactionId, new transactionId.
    const r2 = callRpc(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-sub-2', 'orig-1', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-sub-2',
      originalTransactionId: 'orig-1',
    });
    if (!r2.ok) throw new Error('renewal failed: ' + JSON.stringify(r2));
    const sub = readSubscription(nak.nakama, 'user-A');
    // expiresAtUtc extended by 30d.
    expect(sub!.expiresAtUtc).toBe(firstExpiry + 30 * MS_PER_DAY);
    expect(sub!.renewalHistory.length).toBe(1);
    expect(sub!.renewalHistory[0]!.transactionId).toBe('tx-sub-2');
    expect(sub!.latestTransactionId).toBe('tx-sub-2');
  });

  it('iap_purchase: different originalTransactionId replaces the sub', () => {
    // First sub.
    const r1 = callRpc(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-1', 'orig-A', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-1',
      originalTransactionId: 'orig-A',
    });
    if (!r1.ok) throw new Error('first sub failed: ' + JSON.stringify(r1));
    // Same user buys a different sub pack (different originalTxId).
    const r2 = callRpc(bundle, nak, 'user-A', 'iap_purchase', {
      platform: 'apple',
      productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-2', 'orig-B', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-2',
      originalTransactionId: 'orig-B',
    });
    if (!r2.ok) throw new Error('second sub failed: ' + JSON.stringify(r2));
    const sub = readSubscription(nak.nakama, 'user-A');
    expect(sub!.originalTransactionId).toBe('orig-B');
    expect(sub!.renewalHistory.length).toBe(0); // fresh activation, no renewals
  });

  it('iap_purchase: subscription idempotent replay returns same state', () => {
    const args = {
      platform: 'apple', productId: 'com.cvg.monthlypass',
      receiptData: makeMockSubReceipt('com.cvg.monthlypass', 'tx-1', 'orig-1', REAL_NOW + 30 * MS_PER_DAY),
      transactionId: 'tx-1', originalTransactionId: 'orig-1',
    };
    const r1 = callRpc(bundle, nak, 'user-A', 'iap_purchase', args);
    if (!r1.ok) throw new Error('first failed: ' + JSON.stringify(r1));
    // Replay with the same transactionId but garbage receipt — should hit the
    // user-scoped idempotency cache before verify.
    const r2 = callRpc(bundle, nak, 'user-A', 'iap_purchase', { ...args, receiptData: 'garbage' });
    if (!r2.ok) throw new Error('replay failed: ' + JSON.stringify(r2));
    expect(r2.data!.idempotent).toBe(true);
  });

  // ─── Scanner ─────────────────────────────────────────────────────────

  it('scanner sends subscription_expired inbox when expired', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 40 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW - 1 * MS_PER_DAY,
      autoRenewing: false,
      renewalHistory: [],
      monthlyCosmeticGranted: true,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.scanned).toBe(1);
    expect(stats.expiredNotified).toBe(1);
  });

  it('scanner sends subscription_expiring_soon when 6d left', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 24 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 6 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: true,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.warned).toBe(1);
  });

  it('scanner does not re-warn when warnedExpiring=true', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 24 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 6 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: true,
      warnedExpiring: true,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.warned).toBe(0);
  });

  it('scanner does not warn for non-expiring subs (20d away)', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 10 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW + 20 * MS_PER_DAY,
      autoRenewing: true,
      renewalHistory: [],
      monthlyCosmeticGranted: true,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.warned).toBe(0);
    expect(stats.expiredNotified).toBe(0);
  });

  it('scanner: best-effort — empty store does not throw', () => {
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.scanned).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('scanner: hard-deletes cancelled+expired for >30d', () => {
    const sub: IapSubscription = {
      userId: 'user-A', packId: 'monthly_pass', platform: 'apple',
      originalTransactionId: 'orig-1', latestTransactionId: 'tx-1',
      activatedAtUtc: REAL_NOW - 100 * MS_PER_DAY,
      expiresAtUtc: REAL_NOW - 60 * MS_PER_DAY,
      cancelledAtUtc: REAL_NOW - 60 * MS_PER_DAY,
      autoRenewing: false,
      renewalHistory: [],
      monthlyCosmeticGranted: true,
      expiredNotified: true,
    };
    writeSubscriptionCreate(nak.nakama, sub);
    const stats = scanOnce(nak.nakama, mkLogger(), REAL_NOW);
    expect(stats.deleted).toBe(1);
    expect(readSubscription(nak.nakama, 'user-A')).toBeNull();
  });
});
