// Phase 9 Chunk 2 / T-24 — e2e boot test for receipt verification.
//
// Through the built bundle (the code Nakama runs):
//   1. boot does not crash and the bundled LiveOps default no longer
//      carries an `iapVerification` block (PC-04: it was the mock);
//   2. `iap_purchase` with a mock receipt is rejected unless the call's
//      `runtime.env` has IAP_MOCK=true, and without store credentials an
//      Apple / Google receipt is rejected without any HTTP call;
//   3. a refunded mock receipt is rejected.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeNakama, FakeContext } from './_stubs';
import type { LoadedBundle } from './_stubs';
import liveopsDefault from '../../modules/src/catalogs/liveops.default.json';
import type { IContext, ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const NOW = 1_700_000_000_000;
const USER = '11111111-1111-4111-8111-111111111111';

function call(bundle: LoadedBundle, nk: FakeNakama, env: Record<string, string> | undefined, payload: Record<string, unknown>):
  { ok: boolean; data?: Record<string, unknown>; error?: { code: string; details?: { reason?: string } } } {
  const ctx: IContext = { ...FakeContext, userId: USER, ...(env !== undefined ? { env } : {}) };
  const handler = bundle.resolver('iap_purchase');
  if (!handler) throw new Error('iap_purchase not registered');
  return JSON.parse(handler(ctx, mkLogger(), nk.nakama, JSON.stringify(payload))) as ReturnType<typeof call>;
}

const mockReceipt = (tx: string, over: Record<string, unknown> = {}): string => JSON.stringify({
  productId: 'com.cvg.coins100', transactionId: tx, originalTransactionId: tx, purchaseDateUtc: NOW, ...over,
});

describe('iap verify boot e2e (Phase 9 Chunk 2, T-24)', () => {
  let bundle: LoadedBundle;
  let nk: FakeNakama;

  beforeEach(() => {
    bundle = loadBundleForTest();
    nk = new FakeNakama();
    nk.httpRequestThrow = new Error('no network in tests');
  });

  it('boot does not crash and the bundled LiveOps default has no iapVerification', () => {
    expect(() => loadBundleForTest()).not.toThrow();
    expect((liveopsDefault as Record<string, unknown>)['iapVerification']).toBeUndefined();
  });

  it('without IAP_MOCK a mock receipt is rejected on both platforms, with no HTTP call and no coins', () => {
    for (const [platform, productId] of [['apple', 'com.cvg.coins100'], ['google', 'coins_100']] as const) {
      const r = call(bundle, nk, undefined, {
        platform, productId, transactionId: `forged-${platform}`, receiptData: mockReceipt(`forged-${platform}`, { productId }),
      });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('SERVICE_UNAVAILABLE');
      expect(r.error?.details?.reason).toBe('NOT_CONFIGURED');
    }
    expect(nk.httpRequests.filter((r) => !r.url.includes('analytics'))).toHaveLength(0);
    expect(nk.wallets.get(USER)?.['coins'] ?? 0).toBe(0);
  });

  it('IAP_MOCK=false and a stale LiveOps override with provider=mock still reject', () => {
    nk.nakama.storageWrite([{
      collection: 'liveops', key: 'config', userId: '00000000-0000-0000-0000-000000000000',
      value: { ...(liveopsDefault as Record<string, unknown>), iapVerification: { provider: 'mock', environment: 'sandbox', timeoutMs: 10000 } },
      permissionRead: 0, permissionWrite: 0,
    }]);
    const r = call(bundle, nk, { IAP_MOCK: 'false' }, {
      platform: 'apple', productId: 'com.cvg.coins100', transactionId: 'forged-2', receiptData: mockReceipt('forged-2'),
    });
    expect(r.ok).toBe(false);
    expect(nk.wallets.get(USER)?.['coins'] ?? 0).toBe(0);
  });

  it('with IAP_MOCK=true a mock receipt is delivered, and a refunded one is rejected', () => {
    const okR = call(bundle, nk, { IAP_MOCK: 'true' }, {
      platform: 'apple', productId: 'com.cvg.coins100', transactionId: 'mock-1', receiptData: mockReceipt('mock-1'),
    });
    expect(okR.ok).toBe(true);
    const refunded = call(bundle, nk, { IAP_MOCK: 'true' }, {
      platform: 'apple', productId: 'com.cvg.coins100', transactionId: 'mock-2', receiptData: mockReceipt('mock-2', { refundTime: NOW }),
    });
    expect(refunded.ok).toBe(false);
    expect(refunded.error?.code).toBe('BAD_REQUEST');
    expect(refunded.error?.details?.reason).toBe('REFUNDED');
  });
});
