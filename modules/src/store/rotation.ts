// Phase 3 store daily rotation. Decision 4: the daily section
// surfaces a deterministic subset of its `daily` pool each UTC day.
// Two clients see the same offers on the same day because the
// rotation is driven by `Math.floor(Date.now() / 86400000)` (UTC
// day index), not by a per-user RNG.
//
// Implementation: take the first `poolSize` offers from the catalog's
// `daily` section after sorting them by a stable hash of
// `offerId + dayIndex`. That way the offer visible on day-N is a
// function of the catalog, not the order it was loaded.

import type { StoreCatalog, StoreOffer, StoreSection } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYYMMDD UTC key for the supplied epoch-ms. */
export function dayKeyUtc(nowMs: number): string {
  const dayIndex = Math.floor(nowMs / DAY_MS);
  return dayIndex.toString(36);
}

/** Numeric day index for the supplied epoch-ms (UTC). */
export function dayIndexUtc(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

/**
 * Deterministic 32-bit hash of `input`. Used only for offer
 * shuffling — NOT for security. MurmurHash3 would be overkill; a
 * FNV-1a variant is enough.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned.
  return h >>> 0;
}

/**
 * Resolve the daily rotation for the supplied UTC day index.
 * Returns the catalog's `daily` section with its `offers` array
 * reordered such that the first `poolSize` entries are the
 * deterministic winners.
 *
 * If the pool has fewer offers than `poolSize`, every offer is
 * returned (in the rotated order).
 */
export function resolveDailyRotation(
  catalog: StoreCatalog,
  nowMs: number,
): StoreOffer[] {
  const day = dayIndexUtc(nowMs);
  const dailySection = catalog.sections.find((s) => s.id === 'daily');
  if (!dailySection) return [];
  const pool = dailySection.offers;
  if (pool.length === 0) return [];

  // Stable sort by hash(offerId + day) so the rotation is
  // deterministic but changes every day.
  const sorted = pool.slice().sort((a, b) => {
    const ha = fnv1a(`${a.offerId}:${day}`);
    const hb = fnv1a(`${b.offerId}:${day}`);
    return ha - hb;
  });

  const size = Math.min(catalog.dailyRotationPoolSize, sorted.length);
  return sorted.slice(0, size);
}

/**
 * Return the section with the offers array replaced by the daily
 * rotation. Other sections pass through unchanged. Sections with
 * `id !== 'daily'` are returned as-is so callers can fan out the
 * whole catalog in a single pass.
 */
export function withDailyRotation(
  catalog: StoreCatalog,
  nowMs: number,
): ReadonlyArray<StoreSection> {
  const rotated = resolveDailyRotation(catalog, nowMs);
  return catalog.sections.map((s) => (s.id === 'daily' ? { ...s, offers: rotated } : s));
}