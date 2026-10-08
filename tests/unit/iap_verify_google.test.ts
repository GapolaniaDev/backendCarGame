// Phase 9 Chunk 2 — Unit tests for the Google Play receipt verifier.

import { describe, it, expect } from 'vitest';
import { verifyGoogle, type GoogleHttpCaller } from '../../modules/src/iap/verify_google';
import type { IapVerificationConfig } from '../../modules/src/iap/types';
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

const CFG: IapVerificationConfig = {
  provider: 'google',
  googleServiceAccount: 'ya29.fake',
  packageName: 'com.cvg.game',
  environment: 'sandbox',
  timeoutMs: 1000,
};

interface FakeResponse { code: number; content: string }

function mkCaller(responses: Array<FakeResponse | null>): GoogleHttpCaller & { calls: number; lastUrl: string } {
  let i = 0;
  return {
    calls: 0,
    lastUrl: '',
    get(url) {
      this.calls += 1;
      this.lastUrl = url;
      const r = responses[i];
      i = i < responses.length ? i + 1 : responses.length - 1;
      return r ?? null;
    },
  };
}

describe('verifyGoogle (Phase 9 Chunk 2)', () => {
  it('returns VERIFICATION_FAILED when the config is missing googleServiceAccount', () => {
    const caller = mkCaller([]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: { ...CFG, googleServiceAccount: undefined } },
      mkLogger(),
    );
    expect(out.result.error).toBe('VERIFICATION_FAILED');
  });

  it('returns VERIFICATION_FAILED when the config is missing packageName', () => {
    const caller = mkCaller([]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: { ...CFG, packageName: undefined } },
      mkLogger(),
    );
    expect(out.result.error).toBe('VERIFICATION_FAILED');
  });

  it('returns a valid result for a successful product purchase', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({
        purchaseState: 0,
        consumptionState: 0,
        productId: 'coins_100',
        orderId: 'gpa.order-1',
        purchaseTimeMillis: String(NOW - 1000),
      }),
    }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'coins_100', transactionId: 'gpa.order-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(out.result.productId).toBe('coins_100');
    expect(out.result.transactionId).toBe('gpa.order-1');
  });

  it('returns ALREADY_CONSUMED when consumptionState=1', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ purchaseState: 0, consumptionState: 1, productId: 'coins_100' }),
    }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'coins_100', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('ALREADY_CONSUMED');
  });

  it('returns INVALID_RECEIPT when purchaseState=1 (canceled)', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ purchaseState: 1, consumptionState: 0, productId: 'coins_100' }),
    }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'coins_100', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('INVALID_RECEIPT');
  });

  it('returns INVALID_RECEIPT on HTTP 404', () => {
    const caller = mkCaller([{ code: 404, content: '' }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('INVALID_RECEIPT');
  });

  it('returns VERIFICATION_FAILED on HTTP 401/403', () => {
    for (const code of [401, 403]) {
      const caller = mkCaller([{ code, content: '' }]);
      const out = verifyGoogle(
        caller,
        { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
        mkLogger(),
      );
      expect(out.result.error).toBe('VERIFICATION_FAILED');
    }
  });

  it('returns PRODUCT_MISMATCH when productId does not match expected', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ purchaseState: 0, consumptionState: 0, productId: 'wrong', orderId: 'gpa.x', purchaseTimeMillis: '1' }),
    }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'coins_100', transactionId: 'gpa.x', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('PRODUCT_MISMATCH');
  });

  it('returns INVALID_RECEIPT when the response is not JSON', () => {
    const caller = mkCaller([{ code: 200, content: 'not-json' }]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('INVALID_RECEIPT');
  });

  it('returns NETWORK_ERROR when the caller returns null twice', () => {
    const caller = mkCaller([null, null]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('NETWORK_ERROR');
    expect(out.attempts).toBe(2);
  });

  it('retries once on 503 then succeeds', () => {
    const caller = mkCaller([
      { code: 503, content: '' },
      { code: 200, content: JSON.stringify({ purchaseState: 0, consumptionState: 0, productId: 'p', orderId: 'o', purchaseTimeMillis: '1' }) },
    ]);
    const out = verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'p', transactionId: 'o', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(caller.calls).toBe(2);
  });

  it('builds the URL with the package name and product id encoded', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ purchaseState: 0, consumptionState: 0, productId: 'coins 100', orderId: 'o', purchaseTimeMillis: '1' }),
    }]);
    verifyGoogle(
      caller,
      { receiptData: 'tok', expectedProductId: 'coins 100', transactionId: 'o', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(caller.lastUrl).toContain('com.cvg.game');
    expect(caller.lastUrl).toContain('coins%20100');
    expect(caller.lastUrl).toContain('androidpublisher');
  });
});
