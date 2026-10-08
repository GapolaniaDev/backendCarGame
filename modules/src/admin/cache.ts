// Phase 8 Chunk 9 — 60s in-memory cache for the admin dashboard RPCs.
//
// Each cache entry is `{ts, value}` — a successful get returns the
// cached `value` when the entry is younger than `DASHBOARD_CACHE_TTL_MS`.
// The cache is keyed by RPC name + a JSON-stable signature of the
// request (e.g. `fromDate/toDate` for stats, `q` for search). Manual
// mutations (anti-cheat confirm/dismiss/sanction, wallet grant) call
// `invalidateDashboardCache` to drop matching entries so the next
// read sees the freshest data.
//
// The cache is intentionally NOT shared across workers — each goja
// VM has its own. For our use-case (5–16 workers, hot admin tool
// path) the worst-case duplication is 16x, which is still cheap.

/** TTL for every dashboard cache entry. */
export const DASHBOARD_CACHE_TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  ts: number;
  value: T;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

/**
 * Look up a cached value. Returns the stored `value` when the entry
 * is younger than `DASHBOARD_CACHE_TTL_MS`, otherwise `null`.
 */
export function getCached<T>(key: string, nowMs: number): T | null {
  const e = CACHE.get(key) as CacheEntry<T> | undefined;
  if (e === undefined) return null;
  if (nowMs - e.ts > DASHBOARD_CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return e.value;
}

/** Store a value in the cache. The timestamp is `nowMs`. */
export function setCached<T>(key: string, value: T, nowMs: number): void {
  CACHE.set(key, { ts: nowMs, value });
}

/**
 * Drop all cache entries whose key starts with `prefix`. The anti-cheat
 * mutation RPCs pass the `'anti_cheat_dashboard:'` prefix; the wallet
 * grant passes `'overview:'` to ensure the overview card refreshes
 * after a balance change.
 */
export function invalidateDashboardCache(prefix: string): void {
  for (const k of CACHE.keys()) {
    if (k.startsWith(prefix)) CACHE.delete(k);
  }
}

/** Drop the whole cache. Test hook. */
export function clearDashboardCache(): void {
  CACHE.clear();
}

/**
 * Build a deterministic cache key. The helper joins the supplied
 * parts with `|` and uses `JSON.stringify` on objects so the order
 * of keys doesn't matter.
 */
export function buildCacheKey(parts: ReadonlyArray<unknown>): string {
  return parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join('|');
}
