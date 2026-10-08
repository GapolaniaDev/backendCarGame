// Phase 9 Chunk 5 — Mock ad verifier.
//
// Pure: no I/O. Validates the input from `ad_watched` and returns a
// success or a structured error. Real AdMob / Unity Ads integration
// would replace this with a server-to-server callback flow (D68
// deferred). The 60s clock-skew tolerance matches the receipt
// verifier (Phase 9 Chunk 2) — Apple's servers frequently report
// `watchedAt` a few seconds ahead of the device's clock, so a small
// forward window is essential to avoid spurious INVALID_RECEIPT-style
// errors.

import type { AdProvider } from './types';

export type AdVerifyError = 'INVALID_PROVIDER' | 'INVALID_IMPRESSION_ID' | 'FUTURE_WATCHED_AT';

export interface AdVerifyResult {
  valid: boolean;
  error?: AdVerifyError;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export function verifyAdMock(
  provider: AdProvider,
  adUnitId: string,
  impressionId: string,
  watchedAtUtc: number,
  nowUtc: number,
): AdVerifyResult {
  if (provider !== 'mock') {
    return { valid: false, error: 'INVALID_PROVIDER' };
  }
  if (typeof adUnitId !== 'string' || adUnitId.length === 0) {
    return { valid: false, error: 'INVALID_IMPRESSION_ID' };
  }
  if (typeof impressionId !== 'string' || !UUID_V4_RE.test(impressionId)) {
    return { valid: false, error: 'INVALID_IMPRESSION_ID' };
  }
  if (typeof watchedAtUtc !== 'number' || !Number.isFinite(watchedAtUtc)) {
    return { valid: false, error: 'FUTURE_WATCHED_AT' };
  }
  if (watchedAtUtc > nowUtc + CLOCK_SKEW_TOLERANCE_MS) {
    return { valid: false, error: 'FUTURE_WATCHED_AT' };
  }
  return { valid: true };
}
