// Phase 9 Chunk 2 — Unit tests for the receipt verification dispatcher.
//
// Covers the routing (provider dispatch), 24h sha256 dedup cache, and
// the "no config = VERIFICATION_FAILED" path. Apple + Google verifiers
// are tested separately via injectable HTTP callers.

import { describe, it, expect, beforeEach } from 'vitest';
import { verifyReceipt, _resetVerifyCacheForTests, _peekVerifyCacheForTests } from '../../modules/src/iap/verify';
import type { IapVerificationConfig } from '../../modules/src/iap/types';
import type { ILogger } from '../../modules/src/nkruntime';
import type { AppleHttpCaller } from '../../modules/src/iap/verify_apple';
import type { GoogleHttpCaller } from '../../modules/src/iap/verify_google';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const NOW = 1_700_000_000_000;

const MOCK_CFG: IapVerificationConfig = {
  provider: 'mock',
  environment: 'sandbox',
  timeoutMs: 10000,
};

const APPLE_CFG: IapVerificationConfig = {
  provider: 'apple',
  appleSharedSecret: 'a'.repeat(32),
  environment: 'sandbox',
  timeoutMs: 10000,
};

const GOOGLE_CFG: IapVerificationConfig = {
  provider: 'google',
  googleServiceAccount: 'ya29.fake',
  packageName: 'com.cvg.game',
  environment: 'sandbox',
  timeoutMs: 10000,
};

describe('verifyReceipt dispatcher (Phase 9 Chunk 2)', () => {
  beforeEach(() => {
    _resetVerifyCacheForTests();
  });

  it('returns VERIFICATION_FAILED when no config is provided', () => {
    const r = verifyReceipt(
      { platform: 'apple', expectedProductId: 'p', transactionId: 't', receiptData: '{}' },
      { config: undefined, logger: mkLogger(), nowUtc: NOW },
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('VERIFICATION_FAILED');
  });

  it('routes to verifyMock when provider=mock', () => {
    const r = verifyReceipt(
      {
        platform: 'apple',
        expectedProductId: 'p1',
        transactionId: 't1',
        receiptData: JSON.stringify({
          productId: 'p1', transactionId: 't1', originalTransactionId: 't1', purchaseDateUtc: NOW,
        }),
      },
      { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW },
    );
    expect(r.valid).toBe(true);
    expect(r.transactionId).toBe('t1');
  });

  it('dedup caches a success result for the same platform+transactionId', () => {
    const args = {
      platform: 'apple' as const,
      expectedProductId: 'p1',
      transactionId: 'dedup-1',
      receiptData: JSON.stringify({
        productId: 'p1', transactionId: 'dedup-1', originalTransactionId: 'dedup-1', purchaseDateUtc: NOW,
      }),
    };
    const r1 = verifyReceipt(args, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    expect(r1.valid).toBe(true);
    const cached = _peekVerifyCacheForTests('apple', 'dedup-1');
    expect(cached).toBeDefined();
    expect(cached!.transactionId).toBe('dedup-1');
  });

  it('returns the same result on the second call without re-verifying', () => {
    const args = {
      platform: 'apple' as const,
      expectedProductId: 'p1',
      transactionId: 'dedup-2',
      receiptData: JSON.stringify({
        productId: 'p1', transactionId: 'dedup-2', originalTransactionId: 'dedup-2', purchaseDateUtc: NOW,
      }),
    };
    const r1 = verifyReceipt(args, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    // Change the receipt to one that would FAIL on re-verify — the
    // dispatcher MUST return the cached success.
    const r2 = verifyReceipt({ ...args, receiptData: 'garbage' }, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    expect(r2.valid).toBe(r1.valid);
    expect(r2.transactionId).toBe(r1.transactionId);
  });

  it('does not share dedup entries across platforms', () => {
    const argsA = {
      platform: 'apple' as const,
      expectedProductId: 'p1',
      transactionId: 'shared',
      receiptData: JSON.stringify({
        productId: 'p1', transactionId: 'shared', originalTransactionId: 'shared', purchaseDateUtc: NOW,
      }),
    };
    const rA = verifyReceipt(argsA, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    expect(rA.valid).toBe(true);
    // Same tx id on a different platform should NOT hit the apple cache.
    const rG = verifyReceipt(
      { ...argsA, platform: 'google' },
      { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW },
    );
    expect(rG.valid).toBe(true);
    // ... but its result echoes the google platform because the mock
    // re-ran.
    expect(rG.platform).toBe('google');
  });

  it('caches failure results too (so retries return the same error)', () => {
    const args = {
      platform: 'apple' as const,
      expectedProductId: 'p1',
      transactionId: 'fail-1',
      receiptData: 'garbage',
    };
    const r1 = verifyReceipt(args, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    expect(r1.error).toBe('INVALID_RECEIPT');
    const r2 = verifyReceipt(args, { config: MOCK_CFG, logger: mkLogger(), nowUtc: NOW });
    expect(r2.error).toBe('INVALID_RECEIPT');
  });

  it('routes to verifyApple when provider=apple and an apple caller is supplied', () => {
    const appleCaller: AppleHttpCaller = {
      post: (_url, _body, _deadline) => ({
        code: 200,
        content: JSON.stringify({
          status: 0,
          receipt: { in_app: [{
            transaction_id: 'apple-tx-1',
            original_transaction_id: 'apple-tx-1',
            product_id: 'com.cvg.coins100',
            purchase_date_ms: String(NOW - 1000),
          }] },
        }),
      }),
    };
    const r = verifyReceipt(
      { platform: 'apple', expectedProductId: 'com.cvg.coins100', transactionId: 'apple-tx-1', receiptData: 'applereceipt' },
      { config: APPLE_CFG, logger: mkLogger(), nowUtc: NOW, appleCaller },
    );
    expect(r.valid).toBe(true);
    expect(r.platform).toBe('apple');
    expect(r.transactionId).toBe('apple-tx-1');
  });

  it('routes to verifyGoogle when provider=google and a google caller is supplied', () => {
    const googleCaller: GoogleHttpCaller = {
      get: (_url, _bearer, _deadline) => ({
        code: 200,
        content: JSON.stringify({
          purchaseState: 0,
          consumptionState: 0,
          productId: 'coins_100',
          orderId: 'gpa.order-1',
          purchaseTimeMillis: String(NOW - 1000),
        }),
      }),
    };
    const r = verifyReceipt(
      { platform: 'google', expectedProductId: 'coins_100', transactionId: 'gpa.order-1', receiptData: 'googletoken' },
      { config: GOOGLE_CFG, logger: mkLogger(), nowUtc: NOW, googleCaller },
    );
    expect(r.valid).toBe(true);
    expect(r.platform).toBe('google');
    expect(r.transactionId).toBe('gpa.order-1');
  });

  it('returns INTERNAL_ERROR when google caller is missing', () => {
    const r = verifyReceipt(
      { platform: 'google', expectedProductId: 'coins_100', transactionId: 'tx', receiptData: 'tok' },
      { config: GOOGLE_CFG, logger: mkLogger(), nowUtc: NOW },
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe('INTERNAL_ERROR');
  });
});
