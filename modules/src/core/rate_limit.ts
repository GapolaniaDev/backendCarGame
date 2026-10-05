// Per-user, per-RPC rate limiter.
//
// Nakama 3.27 has no built-in per-user/per-RPC rate limit binding —
// verified against the v3.27.0 source. We implement a sliding-window
// counter backed by the in-process localcache.
//
// Key shape: `${userId}:${rpcName}:${floor(nowSec / windowSec)}`
// Value:     integer counter (monotonic across requests in the same window).
//
// The window is a "fixed" window — simple, fast, and good enough for
// game RPCs where the goal is to absorb bursty misbehaviour, not to be
// perfectly fair across boundaries.

import type { INakama } from '../nkruntime';

export interface RateLimitOptions {
  rpcName: string;
  userId: string;
  /** Maximum requests allowed in the window. */
  maxPerWindow: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** How many calls have been counted in the current window (including this one). */
  count: number;
  /** Limit applied for diagnostics. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Increments the counter for `${userId}:${rpcName}:${windowId}` and
 * returns whether the caller is under the configured limit.
 *
 * Call this BEFORE doing work in an RPC handler.
 */
export function checkRateLimit(
  nk: INakama,
  opts: RateLimitOptions,
): RateLimitVerdict {
  const windowSec = Math.max(1, opts.windowSec);
  const nowSec = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(nowSec / windowSec);
  const key = `rate:${opts.userId}:${opts.rpcName}:${windowId}`;
  const previous = nk.localcacheGet<number>(key) ?? 0;
  const next = previous + 1;
  nk.localcachePut(key, next, windowSec);
  return {
    allowed: next <= opts.maxPerWindow,
    count: next,
    limit: opts.maxPerWindow,
    windowSec,
  };
}