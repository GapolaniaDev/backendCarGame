// Phase 9 Chunk 2 — Receipt verification dispatcher.
//
// Routes to the configured provider (mock | apple | google) and
// applies a 24h sha256-dedup cache keyed by `${platform}:${txId}`.
// The cache exists to short-circuit the second of two duplicate
// `iap_purchase` submissions — common when the client retries on a
// transport hiccup and the first submission already granted the
// reward. The cache stores the full `IapVerificationResult` so the
// RPC layer can re-deliver the SAME success shape on a retry, which
// keeps the wallet idempotency keys stable (D61).
//
// 10s soft timeout per request, 1 retry on network error only.

import type {
  IapPlatform,
  IapVerificationConfig,
  IapVerificationResult,
} from './types';
import type { ILogger } from '../nkruntime';
import { verifyMock } from './verify_mock';
import { verifyApple, makeNakamaHttpCaller, type AppleHttpCaller } from './verify_apple';
import { verifyGoogle, type GoogleHttpCaller } from './verify_google';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Tiny FNV-1a string hash. We don't need crypto strength; the cache
 *  key just has to be stable per-process. */
function hashKey(platform: IapPlatform, transactionId: string): string {
  // FNV-1a 32-bit, base 16.
  let h = 0x811c9dc5;
  for (let i = 0; i < platform.length; i += 1) {
    h ^= platform.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  h ^= 0x2f; // ':'
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  for (let i = 0; i < transactionId.length; i += 1) {
    h ^= transactionId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

interface CacheEntry {
  result: IapVerificationResult;
  expiresAt: number;
}

const CACHED = new Map<string, CacheEntry>();
let LAST_EVICT_AT = 0;
const EVICT_INTERVAL_MS = 60_000;

function evictIfDue(nowUtc: number): void {
  if (nowUtc - LAST_EVICT_AT < EVICT_INTERVAL_MS) return;
  for (const [k, v] of CACHED) {
    if (v.expiresAt <= nowUtc) CACHED.delete(k);
  }
  LAST_EVICT_AT = nowUtc;
}

export interface DispatchDeps {
  config: IapVerificationConfig | undefined;
  logger: ILogger;
  nowUtc: number;
  appleCaller?: AppleHttpCaller;
  googleCaller?: GoogleHttpCaller;
}

export function verifyReceipt(
  args: {
    platform: IapPlatform;
    expectedProductId: string;
    transactionId: string;
    receiptData: string;
  },
  deps: DispatchDeps,
): IapVerificationResult {
  const { platform, expectedProductId, transactionId, receiptData } = args;
  const cfg = deps.config;
  if (!cfg) {
    return {
      valid: false,
      platform,
      productId: expectedProductId,
      transactionId,
      originalTransactionId: '',
      purchaseDateUtc: 0,
      isSubscriptionRenewal: false,
      error: 'VERIFICATION_FAILED',
    };
  }

  evictIfDue(deps.nowUtc);

  // Dedup check — return the same result the previous call produced.
  const key = hashKey(platform, transactionId);
  const hit = CACHED.get(key);
  if (hit !== undefined && hit.expiresAt > deps.nowUtc) {
    return hit.result;
  }

  // Provider dispatch.
  let result: IapVerificationResult;
  if (cfg.provider === 'mock') {
    result = verifyMock(platform, receiptData, expectedProductId, deps.nowUtc);
  } else if (cfg.provider === 'apple') {
    const caller = deps.appleCaller ?? makeNakamaHttpCaller((deps as unknown as { nk: never }).nk);
    const out = verifyApple(caller, {
      receiptData,
      expectedProductId,
      transactionId,
      nowUtc: deps.nowUtc,
      config: cfg,
    }, deps.logger);
    result = out.result;
  } else if (cfg.provider === 'google') {
    const caller = deps.googleCaller;
    if (!caller) {
      result = {
        valid: false,
        platform,
        productId: expectedProductId,
        transactionId,
        originalTransactionId: '',
        purchaseDateUtc: 0,
        isSubscriptionRenewal: false,
        error: 'INTERNAL_ERROR',
      };
    } else {
      const out = verifyGoogle(caller, {
        receiptData,
        expectedProductId,
        transactionId,
        nowUtc: deps.nowUtc,
        config: cfg,
      }, deps.logger);
      result = out.result;
    }
  } else {
    result = {
      valid: false,
      platform,
      productId: expectedProductId,
      transactionId,
      originalTransactionId: '',
      purchaseDateUtc: 0,
      isSubscriptionRenewal: false,
      error: 'INTERNAL_ERROR',
    };
  }

  // Cache the result (success or failure) for 24h.
  CACHED.set(key, { result, expiresAt: deps.nowUtc + CACHE_TTL_MS });
  return result;
}

/** Test-only: wipe the dedup cache. */
export function _resetVerifyCacheForTests(): void {
  CACHED.clear();
  LAST_EVICT_AT = 0;
}

/** Test-only: peek at the dedup cache. */
export function _peekVerifyCacheForTests(platform: IapPlatform, transactionId: string): IapVerificationResult | undefined {
  const hit = CACHED.get(hashKey(platform, transactionId));
  return hit ? hit.result : undefined;
}
