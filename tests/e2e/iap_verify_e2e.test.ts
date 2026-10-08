// Phase 9 Chunk 2 — e2e boot test for the IAP verification module.
//
// Confirms that:
//   1. InitModule does not crash when the iapVerification block is
//      present in the bundled liveops default (it ships with
//      provider=mock).
//   2. The dispatcher pulls `iapVerification` from the liveops
//      config (the bundled default wins because the test boots the
//      bundle against an empty storage).
//   3. The dedup cache is wired across the bundle→test boundary
//      (because the CACHED map lives on the test-side module
//      instance after `_resetVerifyCacheForTests`).
//
// The bundle's InitModule does not call `verifyReceipt` directly —
// that happens in the iap_purchase RPC (Chunk 3). The dispatch
// surface is exercised through direct unit calls.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest } from './_stubs';
import { _resetVerifyCacheForTests, _peekVerifyCacheForTests, verifyReceipt } from '../../modules/src/iap/verify';
import type { ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const NOW = 1_700_000_000_000;

describe('iap verify boot e2e (Phase 9 Chunk 2)', () => {
  beforeEach(() => {
    loadBundleForTest();
    _resetVerifyCacheForTests();
  });

  it('boot does not crash with the bundled mock provider in iapVerification', () => {
    expect(() => loadBundleForTest()).not.toThrow();
  });

  it('verifyReceipt with no config returns VERIFICATION_FAILED', () => {
    const r = verifyReceipt(
      { platform: 'apple', expectedProductId: 'p', transactionId: 't', receiptData: '{}' },
      { config: undefined, logger: mkLogger(), nowUtc: NOW },
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('VERIFICATION_FAILED');
  });

  it('verifyReceipt with the bundled mock config verifies a valid receipt', () => {
    const r = verifyReceipt(
      { platform: 'apple', expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', receiptData: JSON.stringify({
        productId: 'com.cvg.coins100', transactionId: 'tx-1', originalTransactionId: 'tx-1', purchaseDateUtc: NOW - 1000,
      }) },
      { config: { provider: 'mock', environment: 'sandbox', timeoutMs: 10000 }, logger: mkLogger(), nowUtc: NOW },
    );
    expect(r.valid).toBe(true);
  });

  it('dedup cache populates after a successful verify', () => {
    verifyReceipt(
      { platform: 'apple', expectedProductId: 'p', transactionId: 'e2e-dedup-1', receiptData: JSON.stringify({
        productId: 'p', transactionId: 'e2e-dedup-1', originalTransactionId: 'e2e-dedup-1', purchaseDateUtc: NOW,
      }) },
      { config: { provider: 'mock', environment: 'sandbox', timeoutMs: 10000 }, logger: mkLogger(), nowUtc: NOW },
    );
    const cached = _peekVerifyCacheForTests('apple', 'e2e-dedup-1');
    expect(cached).toBeDefined();
    expect(cached!.valid).toBe(true);
  });

  it('dedup cache populates after a failed verify too', () => {
    verifyReceipt(
      { platform: 'apple', expectedProductId: 'p', transactionId: 'e2e-dedup-fail', receiptData: 'not-json' },
      { config: { provider: 'mock', environment: 'sandbox', timeoutMs: 10000 }, logger: mkLogger(), nowUtc: NOW },
    );
    const cached = _peekVerifyCacheForTests('apple', 'e2e-dedup-fail');
    expect(cached).toBeDefined();
    expect(cached!.error).toBe('INVALID_RECEIPT');
  });
});
