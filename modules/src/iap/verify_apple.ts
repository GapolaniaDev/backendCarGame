// Phase 9 Chunk 2 — Apple App Store receipt verifier.
//
// Apple exposes two endpoints:
//   - production: https://buy.itunes.apple.com/verifyReceipt
//   - sandbox:    https://sandbox.itunes.apple.com/verifyReceipt
//
// The production endpoint answers 21007 for a sandbox receipt; Apple's
// guidance is to retry it on the sandbox endpoint (TestFlight and
// review builds). 21008 (a production receipt sent to sandbox) is not
// auto-routed.
//
// Apple response shape (success, status 0):
//   { status: 0, receipt: { in_app: [...] }, latest_receipt_info: [...] }
//
// We pick the entry whose `transaction_id` matches the receipt's
// client-reported transactionId. For subscription auto-renew we look
// at `latest_receipt_info` and pick the matching entry; its
// `original_transaction_id` is the FIRST purchase's id and
// `expires_date_ms` is the latest renewal. An entry with
// `cancellation_date_ms` was refunded (T-24): rejected.
//
// T-24 (PC-04): the dispatcher passes `nk` (the old default caller read
// an undefined `deps.nk`), the caller reads `httpRequest`'s `body` (3.27;
// it read `content`), sends the request body once (it wrapped it twice)
// and passes the timeout to `nk.httpRequest`. Without
// `IAP_APPLE_SHARED_SECRET` nothing is sent to Apple.
//
// 1 retry on network error only.

import type { IapRuntimeConfig, IapVerificationError, IapVerificationResult } from './types';
import type { INakama, ILogger } from '../nkruntime';
import { appleReceiptPayload } from './receipt';

const APPLE_PRODUCTION = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

const STATUS_OK = 0;
const STATUS_SANDBOX_RECEIPT_SENT_TO_PRODUCTION = 21007;
const STATUS_PRODUCTION_RECEIPT_SENT_TO_SANDBOX = 21008;
const STATUS_MALFORMED = 21002;
const STATUS_INVALID = 21003;
const STATUS_AUTH_FAILURE = 21004;

interface AppleLatestReceiptEntry {
  transaction_id: string;
  original_transaction_id: string;
  product_id: string;
  purchase_date_ms?: string;
  expires_date_ms?: string;
  cancellation_date_ms?: string;
}

interface AppleResponse {
  status: number;
  receipt?: { in_app?: AppleLatestReceiptEntry[] };
  latest_receipt_info?: AppleLatestReceiptEntry[];
  environment?: string;
}

export interface AppleHttpCaller {
  /**
   * Synchronous HTTP POST of `body` (already JSON). Returns `null` on a
   * timeout / network error so the caller can retry, else `{ code, content }`.
   */
  post(url: string, body: string, deadlineMs: number): { code: number; content: string } | null;
}

/** Default caller — `nk.httpRequest` with the deadline as its timeout. */
export function makeNakamaHttpCaller(nk: INakama): AppleHttpCaller {
  return {
    post(url, body, deadlineMs) {
      try {
        const resp = nk.httpRequest(url, 'post', { 'Content-Type': 'application/json' }, body, deadlineMs);
        return { code: resp.code, content: resp.body };
      } catch {
        return null;
      }
    },
  };
}

interface VerifyArgs {
  receiptData: string;
  expectedProductId: string;
  transactionId: string;
  nowUtc: number;
  config: IapRuntimeConfig;
}

export interface VerifyOutcome {
  result: IapVerificationResult;
  attempts: number;
}

function pickEntry(entries: AppleLatestReceiptEntry[] | undefined, transactionId: string)
  : AppleLatestReceiptEntry | undefined {
  if (!entries) return undefined;
  return entries.find((e) => e.transaction_id === transactionId);
}

function err(platform: 'apple', productId: string, code: IapVerificationError): IapVerificationResult {
  return {
    valid: false,
    platform,
    productId,
    transactionId: '',
    originalTransactionId: '',
    purchaseDateUtc: 0,
    isSubscriptionRenewal: false,
    error: code,
  };
}

function isNetworkError(code: number): boolean {
  return code === 0 || code === 408 || code === 429 || code === 500 || code === 502
    || code === 503 || code === 504;
}

export function verifyApple(
  caller: AppleHttpCaller,
  args: VerifyArgs,
  logger: ILogger,
): VerifyOutcome {
  const cfg = args.config;
  if (cfg.appleSharedSecret.length === 0) {
    return { attempts: 0, result: err('apple', args.expectedProductId, 'NOT_CONFIGURED') };
  }
  const payload = appleReceiptPayload(args.receiptData);
  if (payload === null) {
    return { attempts: 0, result: err('apple', args.expectedProductId, 'INVALID_RECEIPT') };
  }
  const primary = APPLE_PRODUCTION;
  const body = JSON.stringify({
    'receipt-data': payload,
    password: cfg.appleSharedSecret,
    'exclude-old-transactions': false,
  });
  const deadlineMs = cfg.timeoutMs;

  const attempt = (url: string): { code: number; content: string } | null => {
    return caller.post(url, body, deadlineMs);
  };

  let attempts = 0;
  let lastNet: { code: number; content: string } | null = null;
  let resp: { code: number; content: string } | null = null;

  // 1 attempt + 1 retry on network error.
  for (let i = 0; i < 2; i += 1) {
    attempts += 1;
    const r = attempt(primary);
    if (r === null) {
      // network error — retry
      continue;
    }
    if (isNetworkError(r.code)) {
      lastNet = r;
      continue;
    }
    resp = r;
    break;
  }
  if (resp === null) {
    logger.warn('iap verifyApple: network error after %d attempts', attempts);
    return {
      attempts,
      result: { ...err('apple', args.expectedProductId, 'NETWORK_ERROR') },
    };
  }
  if (resp.code !== 200) {
    logger.warn('iap verifyApple: HTTP %d', resp.code);
    return {
      attempts,
      result: { ...err('apple', args.expectedProductId, 'NETWORK_ERROR') },
    };
  }
  // void lastNet to keep the variable referenced (consumed above only
  // when we never set resp).
  void lastNet;

  let parsed: AppleResponse;
  try {
    parsed = JSON.parse(resp.content) as AppleResponse;
  } catch {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'INVALID_RECEIPT') } };
  }

  // Sandbox auto-reroute for production-only flag.
  if (parsed.status === STATUS_SANDBOX_RECEIPT_SENT_TO_PRODUCTION) {
    const r2 = attempt(APPLE_SANDBOX);
    if (r2 === null || r2.code !== 200) {
      return { attempts, result: { ...err('apple', args.expectedProductId, 'NETWORK_ERROR') } };
    }
    try {
      parsed = JSON.parse(r2.content) as AppleResponse;
    } catch {
      return { attempts, result: { ...err('apple', args.expectedProductId, 'INVALID_RECEIPT') } };
    }
    attempts += 1;
  }
  if (parsed.status === STATUS_PRODUCTION_RECEIPT_SENT_TO_SANDBOX) {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'PROVIDER_MISMATCH') } };
  }
  if (parsed.status === STATUS_MALFORMED || parsed.status === STATUS_INVALID) {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'INVALID_RECEIPT') } };
  }
  if (parsed.status === STATUS_AUTH_FAILURE) {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'VERIFICATION_FAILED') } };
  }
  if (parsed.status !== STATUS_OK) {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'VERIFICATION_FAILED') } };
  }

  // Apple returns the latest subscription entry in `latest_receipt_info`
  // and the consumable entries in `receipt.in_app`. We try the latest
  // list first (catches renewals), then fall back to in_app.
  const candidates: AppleLatestReceiptEntry[] = [
    ...(parsed.latest_receipt_info ?? []),
    ...(parsed.receipt?.in_app ?? []),
  ];
  const entry = pickEntry(candidates, args.transactionId);
  if (!entry) {
    return { attempts, result: { ...err('apple', args.expectedProductId, 'INVALID_RECEIPT') } };
  }
  if (entry.product_id !== args.expectedProductId) {
    return {
      attempts,
      result: {
        valid: false,
        platform: 'apple',
        productId: args.expectedProductId,
        transactionId: entry.transaction_id,
        originalTransactionId: entry.original_transaction_id,
        purchaseDateUtc: entry.purchase_date_ms ? Number(entry.purchase_date_ms) : 0,
        isSubscriptionRenewal: entry.transaction_id !== entry.original_transaction_id,
        error: 'PRODUCT_MISMATCH',
      },
    };
  }
  if (entry.cancellation_date_ms !== undefined && entry.cancellation_date_ms !== '') {
    return {
      attempts,
      result: {
        valid: false,
        platform: 'apple',
        productId: entry.product_id,
        transactionId: entry.transaction_id,
        originalTransactionId: entry.original_transaction_id,
        purchaseDateUtc: entry.purchase_date_ms ? Number(entry.purchase_date_ms) : 0,
        isSubscriptionRenewal: entry.transaction_id !== entry.original_transaction_id,
        error: 'REFUNDED',
      },
    };
  }
  const isSub = entry.expires_date_ms !== undefined;
  const purchaseDateUtc = entry.purchase_date_ms ? Number(entry.purchase_date_ms) : args.nowUtc;
  const expiresAtUtc = entry.expires_date_ms ? Number(entry.expires_date_ms) : undefined;
  const isRenewal = entry.transaction_id !== entry.original_transaction_id;
  if (isSub && expiresAtUtc !== undefined && expiresAtUtc < args.nowUtc) {
    return {
      attempts,
      result: {
        valid: false,
        platform: 'apple',
        productId: entry.product_id,
        transactionId: entry.transaction_id,
        originalTransactionId: entry.original_transaction_id,
        purchaseDateUtc,
        expiresAtUtc,
        isSubscriptionRenewal: isRenewal,
        error: 'EXPIRED',
      },
    };
  }
  const out: IapVerificationResult = {
    valid: true,
    platform: 'apple',
    productId: entry.product_id,
    transactionId: entry.transaction_id,
    originalTransactionId: entry.original_transaction_id,
    purchaseDateUtc,
    isSubscriptionRenewal: isRenewal,
  };
  if (expiresAtUtc !== undefined) out.expiresAtUtc = expiresAtUtc;
  return { attempts, result: out };
}
