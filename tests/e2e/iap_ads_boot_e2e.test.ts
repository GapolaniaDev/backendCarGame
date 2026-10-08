// Phase 9 Chunk 1 — e2e boot test for the IAP + ad reward catalogs.
//
// Drives the full bundle boot path via `loadBundleForTest` to confirm
// `InitModule` actually loads the catalogs without error, then asserts
// the catalog API on the test-side module instance (the bundle's
// CACHED state is inside the VM sandbox, so we re-load it here for
// inspection — the bundle boot call above is the proof that the
// fixture is wired up correctly).

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import {
  loadIapPacksCatalog,
  getIapPacksCatalog,
  findIapPack,
  findIapPackByProductId,
  _resetIapPacksCatalogForTests,
} from '../../modules/src/iap/catalog';
import {
  loadAdRewardsCatalog,
  getAdRewardsCatalog,
  findAdRewardTier,
  _resetAdRewardsCatalogForTests,
} from '../../modules/src/ads/catalog';
import iapPacksJson from '../../modules/src/catalogs/iap_packs.json';
import adRewardsJson from '../../modules/src/catalogs/ad_rewards.json';
import type { ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

describe('iap + ads boot e2e (Phase 9 Chunk 1)', () => {
  beforeEach(() => {
    // First, confirm the bundle actually boots cleanly with the new
    // catalogs. InitModule's `loadIapPacksCatalog` /
    // `loadAdRewardsCatalog` calls live inside the VM sandbox; any
    // catalog-mismatch error would surface here.
    loadBundleForTest();
    // The test-side module graph has its OWN CACHED state, so we
    // re-load from the bundled JSON for the API assertions below.
    _resetIapPacksCatalogForTests();
    _resetAdRewardsCatalogForTests();
    loadIapPacksCatalog(mkLogger(), iapPacksJson);
    loadAdRewardsCatalog(mkLogger(), adRewardsJson);
  });

  // ─── IAP packs ─────────────────────────────────────────────────────────

  it('iap packs catalog is populated by the bundled fixture', () => {
    const packs = getIapPacksCatalog();
    expect(packs.length).toBeGreaterThanOrEqual(8);
    expect(packs.length).toBeLessThanOrEqual(12);
  });

  it('iap packs are sorted by sortOrder ascending', () => {
    const packs = getIapPacksCatalog();
    for (let i = 1; i < packs.length; i += 1) {
      expect(packs[i - 1]!.sortOrder).toBeLessThanOrEqual(packs[i]!.sortOrder);
    }
  });

  it('iap packs contain all three kinds', () => {
    const packs = getIapPacksCatalog();
    const kinds = new Set(packs.map((p) => p.kind));
    expect(kinds.has('consumable')).toBe(true);
    expect(kinds.has('non_consumable')).toBe(true);
    expect(kinds.has('subscription')).toBe(true);
  });

  it('findIapPack resolves the bundled consumable pack', () => {
    const p = findIapPack('coins_100');
    expect(p).toBeDefined();
    expect(p!.kind).toBe('consumable');
    if (p!.kind === 'consumable') {
      expect(p!.baseCoins).toBeGreaterThan(0);
      expect(p!.firstTimeBonus).toBeGreaterThanOrEqual(0);
      expect(p!.firstTimeBonus).toBeLessThanOrEqual(p!.baseCoins);
    }
  });

  it('findIapPackByProductId resolves the bundled apple and google ids', () => {
    const a = findIapPackByProductId('apple', 'com.cvg.coins100');
    const g = findIapPackByProductId('google', 'coins_100');
    expect(a).toBeDefined();
    expect(g).toBeDefined();
    expect(a!.id).toBe(g!.id);
  });

  it('every pack has a non-empty appleProductId and googleProductId', () => {
    const packs = getIapPacksCatalog();
    for (const p of packs) {
      expect(typeof p.appleProductId).toBe('string');
      expect(p.appleProductId.length).toBeGreaterThan(0);
      expect(typeof p.googleProductId).toBe('string');
      expect(p.googleProductId.length).toBeGreaterThan(0);
    }
  });

  it('every consumable pack satisfies firstTimeBonus <= baseCoins', () => {
    const packs = getIapPacksCatalog();
    for (const p of packs) {
      if (p.kind === 'consumable') {
        expect(p.firstTimeBonus).toBeLessThanOrEqual(p.baseCoins);
      }
    }
  });

  // ─── Ad rewards ────────────────────────────────────────────────────────

  it('ad rewards catalog is populated with the 4 tiers', () => {
    const tiers = getAdRewardsCatalog();
    expect(tiers).toHaveLength(4);
    expect(tiers.map((t) => t.tier)).toEqual(['small', 'medium', 'large', 'xlarge']);
  });

  it('every ad reward tier has cooldownSeconds >= 60 (anti-spam D64)', () => {
    const tiers = getAdRewardsCatalog();
    for (const t of tiers) {
      expect(t.cooldownSeconds).toBeGreaterThanOrEqual(60);
    }
  });

  it('ad reward coin amounts are non-decreasing across tiers', () => {
    const tiers = getAdRewardsCatalog();
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i]!.coins).toBeGreaterThanOrEqual(tiers[i - 1]!.coins);
    }
  });

  it('findAdRewardTier resolves the bundled tiers', () => {
    expect(findAdRewardTier('small')!.coins).toBe(5);
    expect(findAdRewardTier('medium')!.coins).toBe(15);
    expect(findAdRewardTier('large')!.coins).toBe(30);
    expect(findAdRewardTier('xlarge')!.coins).toBe(60);
  });
});

