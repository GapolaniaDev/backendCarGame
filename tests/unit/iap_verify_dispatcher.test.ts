// Phase 9 Chunk 2 — Unit tests for the receipt verification dispatcher.
//
// T-24 (PC-04, HT-75): the dispatcher takes `nk` and routes by platform
// with the `runtime.env` settings (`iapConfigFromEnv`): the mock only with
// IAP_MOCK=true; Apple and Google with their default callers built on
// `nk.httpRequest` (the old Apple default read an undefined `deps.nk`;
// Google had no caller); no credentials → NOT_CONFIGURED and no HTTP call.

import { describe, it, expect, beforeEach } from 'vitest';
import { verifyReceipt } from '../../modules/src/iap/verify';
import { iapConfigFromEnv } from '../../modules/src/iap/config';
import { _resetGoogleTokenForTests } from '../../modules/src/iap/verify_google';
import type { IapRuntimeConfig } from '../../modules/src/iap/types';
import type { IContext, ILogger, INakama } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const NOW = 1_700_000_000_000;
const APPLE_RECEIPT = 'TUlJVDhRWUpLb1pJaHZjTkFRY0NvSUlUNGpDQ0UrNENBUUV4Q3pBSkJn';
const TOKEN = 'opaque-purchase-token.AO-J1Oz1234567890';

interface Call { url: string; method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }

/** `nk` with a scripted `httpRequest` (3.27 shape: `{code, body, headers}`) and a recording of the calls. */
function fakeNk(script: (c: Call) => { code: number; body: string }): { nk: INakama; calls: Call[] } {
  const calls: Call[] = [];
  const nk = {
    httpRequest(url: string, method: string, headers?: Record<string, string>, body?: string, timeoutMs?: number) {
      const c: Call = { url, method };
      if (headers !== undefined) c.headers = headers;
      if (body !== undefined) c.body = body;
      if (timeoutMs !== undefined) c.timeoutMs = timeoutMs;
      calls.push(c);
      return { ...script(c), headers: {} };
    },
    jwtGenerate(algo: string, key: string, claims: Record<string, unknown>) {
      return `jwt.${algo}.${String(claims['iss'])}.${key.length}`;
    },
  } as unknown as INakama;
  return { nk, calls };
}

const ctxWith = (env: Record<string, string>): IContext => ({ _brand: 'NakamaContext', userId: 'u', env } as IContext);

const NONE: IapRuntimeConfig = iapConfigFromEnv(ctxWith({}));

const mockReceipt = (tx: string, over: Record<string, unknown> = {}): string => JSON.stringify({
  productId: 'com.cvg.coins100', transactionId: tx, originalTransactionId: tx, purchaseDateUtc: NOW - 1000, ...over,
});

describe('iapConfigFromEnv (T-24)', () => {
  it('defaults: mock off, no credentials', () => {
    expect(NONE).toMatchObject({
      mock: false, appleSharedSecret: '', googleClientEmail: '', googlePrivateKey: '', googlePackageName: '',
    });
  });

  it('IAP_MOCK is on only for an explicit true / 1 / yes', () => {
    for (const v of ['true', 'TRUE', '1', 'yes']) expect(iapConfigFromEnv(ctxWith({ IAP_MOCK: v })).mock).toBe(true);
    for (const v of ['false', '', '0', 'no', 'on?']) expect(iapConfigFromEnv(ctxWith({ IAP_MOCK: v })).mock).toBe(false);
    expect(iapConfigFromEnv({ _brand: 'NakamaContext', userId: null }).mock).toBe(false);
  });

  it('a one-line private key gets its newlines back', () => {
    const cfg = iapConfigFromEnv(ctxWith({ IAP_GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----\\n' }));
    expect(cfg.googlePrivateKey).toBe('-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n');
  });
});

describe('verifyReceipt dispatcher (T-24)', () => {
  beforeEach(() => _resetGoogleTokenForTests());

  it('with IAP_MOCK off a mock JSON receipt is never accepted (Apple: not base64; Google: no token), no HTTP', () => {
    const { nk, calls } = fakeNk(() => ({ code: 500, body: '' }));
    for (const platform of ['apple', 'google'] as const) {
      const r = verifyReceipt(nk, {
        platform, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', receiptData: mockReceipt('tx-1'),
      }, { config: NONE, logger: mkLogger(), nowUtc: NOW });
      expect(r.valid).toBe(false);
      expect(r.error).toBe('NOT_CONFIGURED');
    }
    expect(calls).toHaveLength(0);
  });

  it('with IAP_MOCK=true routes both platforms to the mock (and checks the transaction id)', () => {
    const { nk, calls } = fakeNk(() => ({ code: 500, body: '' }));
    const cfg = iapConfigFromEnv(ctxWith({ IAP_MOCK: 'true' }));
    for (const platform of ['apple', 'google'] as const) {
      const ok = verifyReceipt(nk, {
        platform, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', receiptData: mockReceipt('tx-1'),
      }, { config: cfg, logger: mkLogger(), nowUtc: NOW });
      expect(ok.valid).toBe(true);
      const other = verifyReceipt(nk, {
        platform, expectedProductId: 'com.cvg.coins100', transactionId: 'tx-2', receiptData: mockReceipt('tx-1'),
      }, { config: cfg, logger: mkLogger(), nowUtc: NOW });
      expect(other.error).toBe('INVALID_RECEIPT');
    }
    expect(calls).toHaveLength(0);
  });

  it('the mock rejects a refunded receipt (refundTime / RefundTime / refunded)', () => {
    const { nk } = fakeNk(() => ({ code: 500, body: '' }));
    const cfg = iapConfigFromEnv(ctxWith({ IAP_MOCK: 'true' }));
    for (const over of [{ refundTime: NOW }, { RefundTime: NOW }, { refunded: true }]) {
      const r = verifyReceipt(nk, {
        platform: 'google', expectedProductId: 'com.cvg.coins100', transactionId: 'tx-r', receiptData: mockReceipt('tx-r', over),
      }, { config: cfg, logger: mkLogger(), nowUtc: NOW });
      expect(r.error).toBe('REFUNDED');
    }
  });

  it('Apple: the default caller uses nk.httpRequest once with the receipt, the secret and the timeout', () => {
    const { nk, calls } = fakeNk(() => ({
      code: 200,
      body: JSON.stringify({ status: 0, receipt: { in_app: [{
        transaction_id: 'tx-1', original_transaction_id: 'tx-1', product_id: 'com.cvg.coins100', purchase_date_ms: String(NOW - 1000),
      }] } }),
    }));
    const cfg = iapConfigFromEnv(ctxWith({ IAP_APPLE_SHARED_SECRET: 's'.repeat(32) }));
    const r = verifyReceipt(nk, {
      platform: 'apple', expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1',
      receiptData: JSON.stringify({ Store: 'AppleAppStore', TransactionID: 'tx-1', Payload: APPLE_RECEIPT }),
    }, { config: cfg, logger: mkLogger(), nowUtc: NOW });
    expect(r.valid).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://buy.itunes.apple.com/verifyReceipt');
    expect(calls[0]!.timeoutMs).toBe(cfg.timeoutMs);
    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(sent['receipt-data']).toBe(APPLE_RECEIPT);
    expect(sent['password']).toBe('s'.repeat(32));
  });

  it('Apple: a transport error (httpRequest throws) is NETWORK_ERROR after one retry', () => {
    let n = 0;
    const nk = { httpRequest() { n += 1; throw new Error('dial tcp: timeout'); } } as unknown as INakama;
    const cfg = iapConfigFromEnv(ctxWith({ IAP_APPLE_SHARED_SECRET: 's'.repeat(32) }));
    const r = verifyReceipt(nk, {
      platform: 'apple', expectedProductId: 'com.cvg.coins100', transactionId: 'tx-1', receiptData: APPLE_RECEIPT,
    }, { config: cfg, logger: mkLogger(), nowUtc: NOW });
    expect(r.error).toBe('NETWORK_ERROR');
    expect(n).toBe(2);
  });

  it('Google: the default caller mints a service-account token, then GETs the purchase with it', () => {
    const { nk, calls } = fakeNk((c) => (c.url.startsWith('https://oauth2.googleapis.com/token')
      ? { code: 200, body: JSON.stringify({ access_token: 'ya29.minted', expires_in: 3600 }) }
      : { code: 200, body: JSON.stringify({ purchaseState: 0, consumptionState: 0, orderId: 'GPA.1', productId: 'coins_100' }) }));
    const cfg = iapConfigFromEnv(ctxWith({
      IAP_GOOGLE_CLIENT_EMAIL: 'iap@x.iam.gserviceaccount.com',
      IAP_GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----\\n',
      IAP_GOOGLE_PACKAGE_NAME: 'com.cvg.game',
    }));
    const receipt = JSON.stringify({
      Store: 'GooglePlay', TransactionID: TOKEN,
      Payload: JSON.stringify({ json: JSON.stringify({ orderId: 'GPA.1', packageName: 'com.cvg.game', productId: 'coins_100', purchaseToken: TOKEN }) }),
    });
    for (let i = 0; i < 2; i += 1) {
      const r = verifyReceipt(nk, { platform: 'google', expectedProductId: 'coins_100', transactionId: TOKEN, receiptData: receipt },
        { config: cfg, logger: mkLogger(), nowUtc: NOW });
      expect(r.valid).toBe(true);
    }
    // One token exchange (cached per VM), two purchase reads.
    const tokenCalls = calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.method).toBe('post');
    expect(tokenCalls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    const gets = calls.filter((c) => c.url.startsWith('https://androidpublisher.googleapis.com/'));
    expect(gets).toHaveLength(2);
    expect(gets[0]!.headers?.['Authorization']).toBe('Bearer ya29.minted');
    expect(gets[0]!.url).toContain('/applications/com.cvg.game/purchases/products/coins_100/tokens/');
  });

  it('Google: a refused token exchange is VERIFICATION_FAILED and the purchase is not read', () => {
    const { nk, calls } = fakeNk(() => ({ code: 401, body: '{}' }));
    const cfg = iapConfigFromEnv(ctxWith({
      IAP_GOOGLE_CLIENT_EMAIL: 'iap@x', IAP_GOOGLE_PRIVATE_KEY: 'k', IAP_GOOGLE_PACKAGE_NAME: 'com.cvg.game',
    }));
    const r = verifyReceipt(nk, { platform: 'google', expectedProductId: 'coins_100', transactionId: TOKEN, receiptData: TOKEN },
      { config: cfg, logger: mkLogger(), nowUtc: NOW });
    expect(r.error).toBe('VERIFICATION_FAILED');
    expect(calls).toHaveLength(1);
  });
});
