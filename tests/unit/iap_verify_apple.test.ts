// Phase 9 Chunk 2 — Unit tests for the Apple App Store receipt verifier.
//
// The HTTP layer is replaced with an injectable `AppleHttpCaller` so
// the response shapes can be exercised without going through
// `nk.httpRequest`. Status codes 0/21007/21008/21002/21003/21004 are
// all covered.

import { describe, it, expect, beforeEach } from 'vitest';
import { verifyApple, type AppleHttpCaller } from '../../modules/src/iap/verify_apple';
import type { IapRuntimeConfig } from '../../modules/src/iap/types';
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

const CFG: IapRuntimeConfig = {
  mock: false,
  appleSharedSecret: 'a'.repeat(32),
  googleClientEmail: '',
  googlePrivateKey: '',
  googlePackageName: '',
  timeoutMs: 1000,
};

/** A base64 App Store receipt stand-in (the verifier only checks the alphabet). */
const RECEIPT = 'TUlJVDhRWUpLb1pJaHZjTkFRY0NvSUlUNGpDQ0UrNENBUUV4Q3pBSkJn';

interface FakeResponse { code: number; content: string }

function mkCaller(responses: Array<FakeResponse | null>): AppleHttpCaller & { calls: number; bodies: string[] } {
  let i = 0;
  return {
    calls: 0,
    bodies: [],
    post(_url, body) {
      this.calls += 1;
      this.bodies.push(body);
      const r = responses[i];
      i = i < responses.length ? i + 1 : responses.length - 1;
      return r ?? null;
    },
  };
}

function makeSuccessResponse(transactionId: string, productId: string, msAgo: number, expiresMs?: number): FakeResponse {
  return {
    code: 200,
    content: JSON.stringify({
      status: 0,
      receipt: { in_app: [{
        transaction_id: transactionId,
        original_transaction_id: transactionId,
        product_id: productId,
        purchase_date_ms: String(NOW - msAgo),
        ...(expiresMs !== undefined ? { expires_date_ms: String(expiresMs) } : {}),
      }] },
    }),
  };
}

describe('verifyApple (Phase 9 Chunk 2)', () => {
  beforeEach(() => {});

  it('returns a valid result for a consumable with status 0', () => {
    const caller = mkCaller([makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000)]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(out.result.transactionId).toBe('tx-1');
    expect(out.result.productId).toBe('com.cvg.coins100');
    expect(out.attempts).toBe(1);
  });

  it('returns EXPIRED for a subscription past expires_date_ms', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({
        status: 0,
        receipt: { in_app: [{
          transaction_id: 'tx-sub',
          original_transaction_id: 'tx-sub',
          product_id: 'com.cvg.monthlypass',
          purchase_date_ms: String(NOW - 5_000_000),
          expires_date_ms: String(NOW - 1000),
        }] },
      }),
    }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.monthlypass', transactionId: 'tx-sub', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(false);
    expect(out.result.error).toBe('EXPIRED');
  });

  it('returns VERIFICATION_FAILED for an unrecognized status code', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ status: 21100 }) }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('VERIFICATION_FAILED');
  });

  it('returns INVALID_RECEIPT for status 21002 (malformed) and 21003 (invalid)', () => {
    for (const status of [21002, 21003]) {
      const caller = mkCaller([{ code: 200, content: JSON.stringify({ status }) }]);
      const out = verifyApple(
        caller,
        { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
        mkLogger(),
      );
      expect(out.result.error).toBe('INVALID_RECEIPT');
    }
  });

  it('returns VERIFICATION_FAILED for status 21004 (auth failure)', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ status: 21004 }) }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('VERIFICATION_FAILED');
  });

  it('returns INVALID_RECEIPT when the response is not JSON', () => {
    const caller = mkCaller([{ code: 200, content: 'not-json' }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('INVALID_RECEIPT');
  });

  it('returns INVALID_RECEIPT when no matching transaction_id is found', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ status: 0, receipt: { in_app: [] } }),
    }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'no-match', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('INVALID_RECEIPT');
  });

  it('returns PRODUCT_MISMATCH when the entry product_id differs from the expected', () => {
    const caller = mkCaller([makeSuccessResponse('tx-1', 'com.cvg.wrong', 1000)]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('PRODUCT_MISMATCH');
  });

  it('auto-reroutes to sandbox on status 21007 in production', () => {
    const prodCfg: IapRuntimeConfig = { ...CFG };
    // 1st call: prod returns 21007. 2nd call: sandbox returns 0.
    const caller = mkCaller([
      { code: 200, content: JSON.stringify({ status: 21007 }) },
      makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000),
    ]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: prodCfg },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(caller.calls).toBe(2);
  });

  it('returns PROVIDER_MISMATCH on status 21008 (sandbox sent to sandbox from production)', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ status: 21008 }) }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('PROVIDER_MISMATCH');
  });

  it('returns NETWORK_ERROR when the caller returns null twice', () => {
    const caller = mkCaller([null, null]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('NETWORK_ERROR');
    expect(out.attempts).toBe(2);
  });

  it('retries once on 500 (network error) then succeeds', () => {
    const caller = mkCaller([
      { code: 500, content: 'boom' },
      makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000),
    ]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(caller.calls).toBe(2);
  });

  it('marks isSubscriptionRenewal=true when transaction_id differs from original', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({
        status: 0,
        latest_receipt_info: [{
          transaction_id: 'tx-renewal',
          original_transaction_id: 'tx-original',
          product_id: 'com.cvg.monthlypass',
          purchase_date_ms: String(NOW - 1000),
          expires_date_ms: String(NOW + 2_000_000),
        }],
      }),
    }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.monthlypass', transactionId: 'tx-renewal', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    expect(out.result.isSubscriptionRenewal).toBe(true);
    expect(out.result.expiresAtUtc).toBe(NOW + 2_000_000);
  });

  it('returns NETWORK_ERROR when HTTP code is not 200 after retry', () => {
    const caller = mkCaller([{ code: 502, content: '' }, { code: 502, content: '' }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'p', transactionId: 'tx', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.error).toBe('NETWORK_ERROR');
  });

  // ── T-24 (PC-04, HT-75) ────────────────────────────────────────────────
  it('T-24: without IAP_APPLE_SHARED_SECRET nothing is sent to Apple (NOT_CONFIGURED)', () => {
    const caller = mkCaller([makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000)]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: { ...CFG, appleSharedSecret: '' } },
      mkLogger(),
    );
    expect(out.result.error).toBe('NOT_CONFIGURED');
    expect(caller.calls).toBe(0);
  });

  it('T-24: a receipt that is not a base64 App Store receipt never reaches Apple', () => {
    const caller = mkCaller([makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000)]);
    for (const receiptData of ['{"productId":"com.cvg.coins100"}', 'forged receipt!', 'abc']) {
      const out = verifyApple(
        caller,
        { receiptData, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
        mkLogger(),
      );
      expect(out.result.error).toBe('INVALID_RECEIPT');
    }
    expect(caller.calls).toBe(0);
  });

  it('T-24: unwraps the Unity unified receipt and sends the payload once, with the shared secret', () => {
    const caller = mkCaller([makeSuccessResponse('tx-1', 'com.cvg.coins100', 1000)]);
    const unified = JSON.stringify({ Store: 'AppleAppStore', TransactionID: 'tx-1', Payload: RECEIPT });
    const out = verifyApple(
      caller,
      { receiptData: unified, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(true);
    const sent = JSON.parse(caller.bodies[0]!) as Record<string, unknown>;
    expect(sent['receipt-data']).toBe(RECEIPT);
    expect(sent['password']).toBe(CFG.appleSharedSecret);
  });

  it('T-24: a refunded purchase (cancellation_date_ms) is REFUNDED', () => {
    const caller = mkCaller([{
      code: 200,
      content: JSON.stringify({ status: 0, receipt: { in_app: [{
        transaction_id: 'tx-1', original_transaction_id: 'tx-1', product_id: 'com.cvg.coins100',
        purchase_date_ms: String(NOW - 5000), cancellation_date_ms: String(NOW - 1000),
      }] } }),
    }]);
    const out = verifyApple(
      caller,
      { receiptData: RECEIPT, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', nowUtc: NOW, config: CFG },
      mkLogger(),
    );
    expect(out.result.valid).toBe(false);
    expect(out.result.error).toBe('REFUNDED');
  });
});
