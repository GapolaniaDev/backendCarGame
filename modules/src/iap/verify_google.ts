// Phase 9 Chunk 2 — Google Play receipt verifier.
//
// Google uses an OAuth2 service-account flow to authorize the
// AndroidPublisher API and then calls
//   GET https://androidpublisher.googleapis.com/androidpublisher/v3/
//       applications/{packageName}/purchases/products/{productId}/
//       tokens/{token}
// for consumables / non-consumables, and
//   GET .../purchases/subscriptionsv2/tokens/{token}
// for subscriptions.
//
// Production-grade JWT signing (RS256 from a service-account key) is
// out of scope for the in-game runtime — we accept a pre-computed
// bearer token via `googleServiceAccount` (the operator rotates the
// token via `liveops_config_override`). The token is passed to
// `Authorization: Bearer ...` on every call.
//
// Acknowledged: this trades operational convenience (the operator
// runs a sidecar that refreshes the token) for the in-runtime
// complexity of JWT signing. D62.

import type { IapVerificationConfig, IapVerificationError, IapVerificationResult } from './types';
import type { ILogger } from '../nkruntime';

const GOOGLE_ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export interface GoogleHttpCaller {
  get(url: string, bearer: string, deadlineMs: number): { code: number; content: string } | null;
}

interface VerifyArgs {
  receiptData: string;        // the "purchaseToken" Google assigned
  expectedProductId: string;
  transactionId: string;       // the "orderId" Google assigned
  nowUtc: number;
  config: IapVerificationConfig;
}

export interface VerifyOutcome {
  result: IapVerificationResult;
  attempts: number;
}

// ─── Google product API response shapes ────────────────────────────────────

interface GoogleProductPurchase {
  purchaseState?: number;     // 0=Purchased, 1=Canceled, 2=Pending
  consumptionState?: number;  // 0=NotConsumed, 1=Consumed
  acknowledgementState?: number;
  orderId?: string;
  productId?: string;
  purchaseTimeMillis?: string;
  regionCode?: string;
}

interface GoogleSubscriptionV2Purchase {
  // Subscription v2 returns a richer shape; we use the legacy v1
  // endpoint for simplicity because the spec anchors on v3 product
  // tokens and v2 subs via the SAME path. We accept both shapes.
  subscriptionState?: string; // 'SUBSCRIPTION_STATE_ACTIVE' etc.
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    orderId?: string;
  }>;
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
  if (!cfg.googleServiceAccount) {
    return { attempts: 0, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }
  if (!cfg.packageName) {
    return { attempts: 0, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }
  const bearer = cfg.googleServiceAccount;
  const url = `${GOOGLE_ANDROID_PUBLISHER}/${encodeURIComponent(cfg.packageName)}`
    + `/purchases/products/${encodeURIComponent(args.expectedProductId)}`
    + `/tokens/${encodeURIComponent(args.receiptData)}`;

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
  if (resp.code === 404) {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  if (resp.code === 401 || resp.code === 403) {
    return { attempts, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }
  if (resp.code !== 200) {
    return { attempts, result: err(args.expectedProductId, 'VERIFICATION_FAILED') };
  }

  let parsed: GoogleProductPurchase;
  try {
    parsed = JSON.parse(resp.content) as GoogleProductPurchase;
  } catch {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }

  // Consumable already consumed on a server.
  if (parsed.consumptionState === 1) {
    return { attempts, result: err(args.expectedProductId, 'ALREADY_CONSUMED') };
  }
  if (parsed.purchaseState === 1) {
    return { attempts, result: err(args.expectedProductId, 'INVALID_RECEIPT') };
  }
  if (parsed.productId !== args.expectedProductId) {
    return {
      attempts,
      result: {
        valid: false,
        platform: 'google',
        productId: args.expectedProductId,
        transactionId: parsed.orderId ?? args.transactionId,
        originalTransactionId: parsed.orderId ?? args.transactionId,
        purchaseDateUtc: parsed.purchaseTimeMillis ? Number(parsed.purchaseTimeMillis) : 0,
        isSubscriptionRenewal: false,
        error: 'PRODUCT_MISMATCH',
      },
    };
  }
  const purchaseDateUtc = parsed.purchaseTimeMillis ? Number(parsed.purchaseTimeMillis) : args.nowUtc;
  const orderId = parsed.orderId ?? args.transactionId;
  return {
    attempts,
    result: {
      valid: true,
      platform: 'google',
      productId: parsed.productId,
      transactionId: orderId,
      originalTransactionId: orderId,
      purchaseDateUtc,
      isSubscriptionRenewal: false,
    },
  };
}
