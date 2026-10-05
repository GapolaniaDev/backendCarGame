// Idempotency helper: caches the response of an RPC keyed by
// (scope, key) and returns the cached response on subsequent calls
// within the TTL window.
//
// Backed by Nakama's per-process `localcache` — survives within a single
// Nakama process lifetime but not across restarts. This is intentional:
// clients retry with the same key on transient failures, and restarts
// should reset the cache.

import type { INakama } from '../nkruntime';
import type { Resp } from './response';

export interface IdempotencyOptions {
  /** Logical scope, e.g. "race_submit_result". */
  scope: string;
  /** Client-supplied (or derived) unique key. */
  key: string;
  /** TTL in milliseconds. Default 60_000 (1 minute). */
  ttlMs?: number;
}

/** Cached response payload — carries a flag so callers can log/diagnose. */
export interface IdempotencyResult<T> {
  replayed: boolean;
  result: Resp<T>;
}

/**
 * Wraps an RPC handler body so it runs at most once per `(scope, key)`
 * within the TTL window. Subsequent invocations get `{ replayed: true }`.
 *
 * If `fn()` throws synchronously, the exception propagates and nothing
 * is cached. If `fn()` returns a `Resp<T>`, that response is cached.
 */
export async function withIdempotency<T>(
  nk: INakama,
  opts: IdempotencyOptions,
  fn: () => Promise<Resp<T>> | Resp<T>,
): Promise<IdempotencyResult<T>> {
  const ttlSec = Math.max(1, Math.ceil((opts.ttlMs ?? 60_000) / 1000));
  const cacheKey = `idemp:${opts.scope}:${opts.key}`;

  const cached = nk.localcacheGet<IdempotencyResult<T>>(cacheKey);
  if (cached !== null) {
    cached.replayed = true;
    return cached;
  }

  const fresh = await fn();
  const wrapped: IdempotencyResult<T> = { replayed: false, result: fresh };
  nk.localcachePut(cacheKey, wrapped, ttlSec);
  return wrapped;
}