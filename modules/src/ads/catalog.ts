// Phase 9 Chunk 1 — Ad reward catalog loader.

import type { ILogger } from '../nkruntime';
import {
  validateAdRewardsFile,
  type AdRewardTier,
  type AdTier,
} from './types';

let CACHED: ReadonlyArray<AdRewardTier> | null = null;

const TIER_ORDER: ReadonlyArray<AdTier> = ['small', 'medium', 'large', 'xlarge'];

/**
 * Validate and cache the ad reward tiers at boot. Public for the
 * main.ts boot path. Idempotent.
 */
export function loadAdRewardsCatalog(
  logger: ILogger,
  raw: unknown,
): ReadonlyArray<AdRewardTier> {
  const v = validateAdRewardsFile(raw);
  if (!v.ok) {
    throw new Error(`ad_rewards catalog invalid: ${v.reason}`);
  }
  // Sort by the canonical TIER_ORDER so the RPC returns a stable order
  // regardless of JSON file ordering.
  const sorted = v.value.slice().sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
  );
  CACHED = Object.freeze(sorted.map((t) => Object.freeze({ ...t })));
  logger.info('ad_rewards catalog loaded: tiers=%d', CACHED.length);
  return CACHED;
}

/** Throws if the boot loader hasn't run yet. */
export function getAdRewardsCatalog(): ReadonlyArray<AdRewardTier> {
  if (CACHED === null) {
    throw new Error(
      'ad_rewards catalog not loaded — call loadAdRewardsCatalog at boot',
    );
  }
  return CACHED;
}

/** Find a tier by its `tier` discriminator. */
export function findAdRewardTier(tier: AdTier): AdRewardTier | undefined {
  if (CACHED === null) return undefined;
  return CACHED.find((t) => t.tier === tier);
}

/** Test hook: wipes the cached tiers. */
export function _resetAdRewardsCatalogForTests(): void {
  CACHED = null;
}
