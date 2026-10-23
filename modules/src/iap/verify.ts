// Phase 9 Chunk 2 — Receipt verification dispatcher.
//
// T-24 (PC-04, HT-75): routes by the receipt's platform with the
// settings of `runtime.env` (`iap/config.ts`):
//   - `IAP_MOCK=true`  → the mock verifier for both platforms (dev / CI);
//   - platform apple   → `verifyApple` with `nk.httpRequest`;
//   - platform google  → `verifyGoogle` with `nk.httpRequest`.
// A store without credentials rejects with NOT_CONFIGURED and no network
// call. Before T-24 the provider came from LiveOps (bundled default:
// mock), the Apple caller read an undefined `deps.nk`, Google had no
// caller, and a per-VM 24 h cache returned a cached failure to a retry;
// the cache is gone: `iap_purchase` answers a retry from the durable
// purchase record before verifying again.

import type { IapPlatform, IapRuntimeConfig, IapVerificationResult } from './types';
import type { ILogger, INakama } from '../nkruntime';
import { verifyMock } from './verify_mock';
import { verifyApple, makeNakamaHttpCaller, type AppleHttpCaller } from './verify_apple';
import { verifyGoogle, makeNakamaGoogleCaller, type GoogleHttpCaller } from './verify_google';

export interface DispatchDeps {
  config: IapRuntimeConfig;
  logger: ILogger;
  nowUtc: number;
  /** Test doubles; the defaults call the stores with `nk.httpRequest`. */
  appleCaller?: AppleHttpCaller;
  googleCaller?: GoogleHttpCaller;
}

export function verifyReceipt(
  nk: INakama,
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
  if (cfg.mock) {
    return verifyMock(platform, receiptData, expectedProductId, deps.nowUtc, transactionId);
  }
  if (platform === 'apple') {
    const caller = deps.appleCaller ?? makeNakamaHttpCaller(nk);
    return verifyApple(caller, {
      receiptData,
      expectedProductId,
      transactionId,
      nowUtc: deps.nowUtc,
      config: cfg,
    }, deps.logger).result;
  }
  const caller = deps.googleCaller ?? makeNakamaGoogleCaller(nk, deps.logger);
  return verifyGoogle(caller, {
    receiptData,
    expectedProductId,
    transactionId,
    nowUtc: deps.nowUtc,
    config: cfg,
  }, deps.logger).result;
}
