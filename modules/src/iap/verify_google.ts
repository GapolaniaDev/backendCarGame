// Phase 9 Chunk 2 — Google Play receipt verifier.
//
// Calls the Android Publisher API
//   GET https://androidpublisher.googleapis.com/androidpublisher/v3/
//       applications/{packageName}/purchases/products/{productId}/
//       tokens/{purchaseToken}
// authorized with an OAuth2 access token of a service account.
//
// T-24 (PC-04, HT-75, HT-78): the verifier has a caller now
// (`makeNakamaGoogleCaller`: `nk.httpRequest`), and the access token is
// minted in the runtime from the service account in `runtime.env`
// (`IAP_GOOGLE_CLIENT_EMAIL` + `IAP_GOOGLE_PRIVATE_KEY`): an RS256 JWT
// signed with `nk.jwtGenerate`, exchanged at Google's token endpoint and
// cached per VM until shortly before it expires. (The old design expected
// a pre-computed bearer token rotated by a sidecar, D62, that never
// existed.) Without the three settings nothing is sent to Google.
//
// The receipt is any of the client's formats (`receipt.ts`): the purchase
// token comes from it, its package must be ours, and the client's
// transactionId must be its orderId or purchaseToken. `purchaseState`:
// 0 purchased, 1 canceled — a refunded or revoked purchase — and 2
// pending; only 0 is delivered.

import type { IapRuntimeConfig, IapVerificationError, IapVerificationResult } from './types';
import type { ILogger, INakama } from '../nkruntime';
import { googlePurchase } from './receipt';

const GOOGLE_ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface GoogleHttpCaller {
  /** Access token for the Android Publisher scope, or `null` when it cannot be obtained. */
  accessToken(cfg: IapRuntimeConfig): string | null;
  get(url: string, bearer: string, deadlineMs: number): { code: number; content: string } | null;
}

interface CachedToken {
  email: string;
  token: string;
  expiresAtMs: number;
}

// Per VM: each goja VM mints its own token once an hour at most.
let TOKEN: CachedToken | null = null;

/** Default caller — service-account token exchange and GETs with `nk.httpRequest`. */
export function makeNakamaGoogleCaller(nk: INakama, logger: ILogger): GoogleHttpCaller {
  return {
    accessToken(cfg) {
      const now = Date.now();
      if (TOKEN !== null && TOKEN.email === cfg.googleClientEmail && TOKEN.expiresAtMs - 60_000 > now) {
        return TOKEN.token;
      }
      try {
        const iat = Math.floor(now / 1000);
        const assertion = nk.jwtGenerate('RS256', cfg.googlePrivateKey, {
          iss: cfg.googleClientEmail,
          scope: GOOGLE_SCOPE,
          aud: GOOGLE_TOKEN_URL,
          iat,
          exp: iat + 3600,
        });
        const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}`
          + `&assertion=${encodeURIComponent(assertion)}`;
        const resp = nk.httpRequest(GOOGLE_TOKEN_URL, 'post',
          { 'Content-Type': 'application/x-www-form-urlencoded' }, body, cfg.timeoutMs);
        if (resp.code !== 200) {
          logger.warn('iap verifyGoogle: token endpoint HTTP %d', resp.code);
          return null;
        }
        const parsed = JSON.parse(resp.body) as { access_token?: unknown; expires_in?: unknown };
        if (typeof parsed.access_token !== 'string') return null;
        const ttl = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
        TOKEN = { email: cfg.googleClientEmail, token: parsed.access_token, expiresAtMs: now + ttl * 1000 };
        return TOKEN.token;
      } catch (e) {
        logger.warn('iap verifyGoogle: token exchange failed: %s', e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    get(url, bearer, deadlineMs) {
      try {
        const resp = nk.httpRequest(url, 'get', { Authorization: `Bearer ${bearer}` }, undefined, deadlineMs);
        return { code: resp.code, content: resp.body };
      } catch {
        return null;
      }
    },
  };
}

/** Test-only: forget the cached access token. */
export function _resetGoogleTokenForTests(): void {
  TOKEN = null;
}

interface VerifyArgs {
  /** The client's receipt (any format of `receipt.ts`). */
  receiptData: string;
  expectedProductId: string;
  /** The client's transaction id: the purchase's orderId or purchaseToken. */
  transactionId: string;
  nowUtc: number;
  config: IapRuntimeConfig;
}

export interface VerifyOutcome {
  result: IapVerificationResult;
  attempts: number;
}

// ─── Google product API response shape ─────────────────────────────────────

interface GoogleProductPurchase {
  purchaseState?: number;     // 0=Purchased, 1=Canceled, 2=Pending
  consumptionState?: number;  // 0=NotConsumed, 1=Consumed
  acknowledgementState?: number;
  orderId?: string;
  productId?: string;
  purchaseTimeMillis?: string;
  regionCode?: string;
}

function isNetworkError(code: number): boolean {
  return code === 0 || code === 408 || code === 429 || code === 500 || code === 502
    || code === 503 || code === 504;
}

function err(productId: string, code: IapVerificationError): IapVerificationResult {
  return {
    valid: false,
    platform: 'google',
    productId,
    transactionId: '',
    originalTransactionId: '',
    purchaseDateUtc: 0,
    isSubscriptionRenewal: false,
    error: code,
  };
}

export function verifyGoogle(
  caller: GoogleHttpCaller,
  args: VerifyArgs,
  logger: ILogger,
): VerifyOutcome {
  const cfg = args.config;
  if (!cfg.googleClientEmail || !cfg.googlePrivateKey || !cfg.googlePackageName) {
    return { attempts: 0, result: err(args.expectedProductId, 'NOT_CONFIGURED') };
  }
  const purchase = googlePurchase(args.receiptData);
  if (purchase === null) {
    return { attempts: 0, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  if (purchase.packageName !== undefined && purchase.packageName !== cfg.googlePackageName) {
    return { attempts: 0, result: err(args.expectedProductId, 'PROVIDER_MISMATCH') };
  }
  if (purchase.productId !== undefined && purchase.productId !== args.expectedProductId) {
    return { attempts: 0, result: err(args.expectedProductId, 'PRODUCT_MISMATCH') };
  }
  if (args.transactionId !== purchase.purchaseToken && args.transactionId !== purchase.orderId) {
    return { attempts: 0, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  const bearer = caller.accessToken(cfg);
  if (bearer === null) {
    return { attempts: 0, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }
  const url = `${GOOGLE_ANDROID_PUBLISHER}/${encodeURIComponent(cfg.googlePackageName)}`
    + `/purchases/products/${encodeURIComponent(args.expectedProductId)}`
    + `/tokens/${encodeURIComponent(purchase.purchaseToken)}`;

  let attempts = 0;
  let resp: { code: number; content: string } | null = null;
  for (let i = 0; i < 2; i += 1) {
    attempts += 1;
    const r = caller.get(url, bearer, cfg.timeoutMs);
    if (r === null) continue;
    if (isNetworkError(r.code)) continue;
    resp = r;
    break;
  }
  if (resp === null) {
    logger.warn('iap verifyGoogle: network error after %d attempts', attempts);
    return { attempts, result: err(args.expectedProductId, 'NETWORK_ERROR') };
  }
  if (resp.code === 404 || resp.code === 400 || resp.code === 410) {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  if (resp.code !== 200) {
    // 401 / 403: our service account is not allowed (setup, not the receipt).
    logger.warn('iap verifyGoogle: HTTP %d', resp.code);
    return { attempts, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }

  let parsed: GoogleProductPurchase;
  try {
    parsed = JSON.parse(resp.content) as GoogleProductPurchase;
  } catch {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }

  if (parsed.purchaseState === 1) {
    return { attempts, result: err(args.expectedProductId, 'REFUNDED') };
  }
  if (parsed.purchaseState === 2) {
    return { attempts, result: err(args.expectedProductId, 'PENDING') };
  }
  // Consumable already consumed on a server.
  if (parsed.consumptionState === 1) {
    return { attempts, result: err(args.expectedProductId, 'ALREADY_CONSUMED') };
  }
  // The API answers for the product in the URL; a body naming another
  // product (older API versions) is a mismatch.
  const productId = parsed.productId ?? args.expectedProductId;
  if (productId !== args.expectedProductId) {
    return { attempts, result: err(args.expectedProductId, 'PRODUCT_MISMATCH') };
  }
  const purchaseDateUtc = parsed.purchaseTimeMillis ? Number(parsed.purchaseTimeMillis) : args.nowUtc;
  const orderId = parsed.orderId ?? purchase.orderId ?? args.transactionId;
  if (purchase.orderId !== undefined && parsed.orderId !== undefined && purchase.orderId !== parsed.orderId) {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  return {
    attempts,
    result: {
      valid: true,
      platform: 'google',
      productId,
      transactionId: orderId,
      originalTransactionId: orderId,
      purchaseDateUtc,
      isSubscriptionRenewal: false,
    },
  };
}
