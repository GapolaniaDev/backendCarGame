// Phase 9 Chunk 2 — Unit tests for the Google Play receipt verifier.
//
// T-24 (PC-04, HT-75, HT-78): the receipt arrives in the client's
// formats (Unity unified receipt with the `UnityPayload` JSON, the
// `PurchaseJson` purchase JSON, or a bare purchase token); the access
// token comes from the caller (service account); no credentials → no
// call; a canceled (refunded) purchase is REFUNDED.

import { describe, it, expect } from 'vitest';
import { verifyGoogle, type GoogleHttpCaller } from '../../modules/src/iap/verify_google';
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
const TOKEN = 'opaque-purchase-token.AO-J1Oz1234567890';

const CFG: IapRuntimeConfig = {
  mock: false,
  appleSharedSecret: '',
  googleClientEmail: 'iap@racinggame.iam.gserviceaccount.com',
  googlePrivateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  googlePackageName: 'com.cvg.game',
  timeoutMs: 1000,
};

/** The purchase JSON Google signs (`PurchaseJson` mode). */
function purchaseJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    orderId: 'GPA.1234-5678',
    packageName: 'com.cvg.game',
    productId: 'coins_100',
    purchaseTime: NOW - 1000,
    purchaseState: 0,
    purchaseToken: TOKEN,
    ...over,
  });
}

/** What the fulfiller sends by default: Unity's unified receipt with the `UnityPayload` JSON. */
function unityReceipt(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Store: 'GooglePlay',
    TransactionID: TOKEN,
    Payload: JSON.stringify({ json: purchaseJson(over), signature: 'sig', skuDetails: ['{}'] }),
  });
}

interface FakeResponse { code: number; content: string }

function mkCaller(
  responses: Array<FakeResponse | null>,
  token: string | null = 'ya29.access',
): GoogleHttpCaller & { calls: number; lastUrl: string; lastBearer: string } {
  let i = 0;
  return {
    calls: 0,
    lastUrl: '',
    lastBearer: '',
    accessToken() {
      return token;
    },
    get(url, bearer) {
      this.calls += 1;
      this.lastUrl = url;
      this.lastBearer = bearer;
      const r = responses[i];
      i = i < responses.length ? i + 1 : responses.length - 1;
      return r ?? null;
    },
  };
}

const OK_BODY: FakeResponse = {
  code: 200,
  content: JSON.stringify({
    purchaseState: 0,
    consumptionState: 0,
    productId: 'coins_100',
    orderId: 'GPA.1234-5678',
    purchaseTimeMillis: String(NOW - 1000),
  }),
};

const args = (receiptData: string, over: Partial<{ transactionId: string; expectedProductId: string; config: IapRuntimeConfig }> = {}) => ({
  receiptData,
  expectedProductId: over.expectedProductId ?? 'coins_100',
  transactionId: over.transactionId ?? TOKEN,
  nowUtc: NOW,
  config: over.config ?? CFG,
});

describe('verifyGoogle (Phase 9 Chunk 2, T-24)', () => {
  it('NOT_CONFIGURED and no call when any service-account setting is missing', () => {
    for (const missing of ['googleClientEmail', 'googlePrivateKey', 'googlePackageName'] as const) {
      const caller = mkCaller([OK_BODY]);
      const out = verifyGoogle(caller, args(unityReceipt(), { config: { ...CFG, [missing]: '' } }), mkLogger());
      expect(out.result.error).toBe('NOT_CONFIGURED');
      expect(caller.calls).toBe(0);
    }
  });

  it('accepts the UnityPayload format (unified receipt) and verifies the purchase token', () => {
    const caller = mkCaller([OK_BODY]);
    const out = verifyGoogle(caller, args(unityReceipt()), mkLogger());
    expect(out.result.valid).toBe(true);
    expect(out.result.transactionId).toBe('GPA.1234-5678');
    expect(caller.lastUrl).toContain(`/tokens/${encodeURIComponent(TOKEN)}`);
    expect(caller.lastBearer).toBe('ya29.access');
  });

  it('accepts the PurchaseJson format (the raw purchase JSON)', () => {
    const caller = mkCaller([OK_BODY]);
    const out = verifyGoogle(caller, args(purchaseJson()), mkLogger());
    expect(out.result.valid).toBe(true);
  });

  it('accepts the PurchaseJson format wrapped in the unified receipt and the orderId as transaction id', () => {
    const caller = mkCaller([OK_BODY]);
    const wrapped = JSON.stringify({ Store: 'GooglePlay', TransactionID: TOKEN, Payload: purchaseJson() });
    const out = verifyGoogle(caller, args(wrapped, { transactionId: 'GPA.1234-5678' }), mkLogger());
    expect(out.result.valid).toBe(true);
  });

  it('accepts a bare purchase token (older callers)', () => {
    const caller = mkCaller([OK_BODY]);
    const out = verifyGoogle(caller, args(TOKEN), mkLogger());
    expect(out.result.valid).toBe(true);
  });

  it('INVALID_RECEIPT without a call for a receipt with no purchase token', () => {
    const caller = mkCaller([OK_BODY]);
    for (const r of ['{"json":"{}"}', '{"productId":"coins_100"}', 'x', JSON.stringify({ Store: 'GooglePlay', Payload: '{"json":"not json"}' })]) {
      expect(verifyGoogle(caller, args(r), mkLogger()).result.error).toBe('INVALID_RECEIPT');
    }
    expect(caller.calls).toBe(0);
  });

  it('INVALID_RECEIPT when the declared transaction id is not this purchase', () => {
    const caller = mkCaller([OK_BODY]);
    const out = verifyGoogle(caller, args(unityReceipt(), { transactionId: 'someone-elses-token' }), mkLogger());
    expect(out.result.error).toBe('INVALID_RECEIPT');
    expect(caller.calls).toBe(0);
  });

  it('PROVIDER_MISMATCH for another package and PRODUCT_MISMATCH for another product (no call)', () => {
    const caller = mkCaller([OK_BODY]);
    expect(verifyGoogle(caller, args(unityReceipt({ packageName: 'com.other.app' })), mkLogger()).result.error)
      .toBe('PROVIDER_MISMATCH');
    expect(verifyGoogle(caller, args(unityReceipt({ productId: 'coins_5000' })), mkLogger()).result.error)
      .toBe('PRODUCT_MISMATCH');
    expect(caller.calls).toBe(0);
  });

  it('VERIFICATION_FAILED when no access token can be obtained', () => {
    const caller = mkCaller([OK_BODY], null);
    expect(verifyGoogle(caller, args(unityReceipt()), mkLogger()).result.error).toBe('VERIFICATION_FAILED');
    expect(caller.calls).toBe(0);
  });

  it('REFUNDED when purchaseState=1 (canceled / refunded) and PENDING when 2', () => {
    for (const [state, error] of [[1, 'REFUNDED'], [2, 'PENDING']] as const) {
      const caller = mkCaller([{ code: 200, content: JSON.stringify({ purchaseState: state, consumptionState: 0, productId: 'coins_100' }) }]);
      expect(verifyGoogle(caller, args(unityReceipt()), mkLogger()).result.error).toBe(error);
    }
  });

  it('ALREADY_CONSUMED when consumptionState=1', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ purchaseState: 0, consumptionState: 1, productId: 'coins_100' }) }]);
    expect(verifyGoogle(caller, args(unityReceipt()), mkLogger()).result.error).toBe('ALREADY_CONSUMED');
  });

  it('INVALID_RECEIPT on HTTP 404 / 400 (unknown token) and VERIFICATION_FAILED on 401 / 403', () => {
    for (const code of [404, 400]) {
      expect(verifyGoogle(mkCaller([{ code, content: '' }]), args(unityReceipt()), mkLogger()).result.error).toBe('INVALID_RECEIPT');
    }
    for (const code of [401, 403]) {
      expect(verifyGoogle(mkCaller([{ code, content: '' }]), args(unityReceipt()), mkLogger()).result.error).toBe('VERIFICATION_FAILED');
    }
  });

  it('PRODUCT_MISMATCH when the API names another product', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ purchaseState: 0, consumptionState: 0, productId: 'wrong' }) }]);
    expect(verifyGoogle(caller, args(TOKEN), mkLogger()).result.error).toBe('PRODUCT_MISMATCH');
  });

  it('INVALID_RECEIPT when the API orderId differs from the receipt orderId', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ purchaseState: 0, consumptionState: 0, orderId: 'GPA.other' }) }]);
    expect(verifyGoogle(caller, args(unityReceipt()), mkLogger()).result.error).toBe('INVALID_RECEIPT');
  });

  it('INVALID_RECEIPT when the response is not JSON', () => {
    expect(verifyGoogle(mkCaller([{ code: 200, content: 'not-json' }]), args(unityReceipt()), mkLogger()).result.error)
      .toBe('INVALID_RECEIPT');
  });

  it('NETWORK_ERROR when the caller returns null twice', () => {
    const caller = mkCaller([null, null]);
    const out = verifyGoogle(caller, args(unityReceipt()), mkLogger());
    expect(out.result.error).toBe('NETWORK_ERROR');
    expect(out.attempts).toBe(2);
  });

  it('retries once on 503 then succeeds', () => {
    const caller = mkCaller([{ code: 503, content: '' }, OK_BODY]);
    const out = verifyGoogle(caller, args(unityReceipt()), mkLogger());
    expect(out.result.valid).toBe(true);
    expect(caller.calls).toBe(2);
  });

  it('builds the URL with the package name and product id encoded', () => {
    const caller = mkCaller([{ code: 200, content: JSON.stringify({ purchaseState: 0, consumptionState: 0 }) }]);
    verifyGoogle(caller, args(TOKEN, { expectedProductId: 'coins 100' }), mkLogger());
    expect(caller.lastUrl).toContain('/applications/com.cvg.game/');
    expect(caller.lastUrl).toContain('/products/coins%20100/');
    expect(caller.lastUrl).toContain('androidpublisher');
  });
});
