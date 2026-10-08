// Phase 9 Chunk 1 — Unit tests for the ad rewards catalog loader.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadAdRewardsCatalog,
  getAdRewardsCatalog,
  findAdRewardTier,
  _resetAdRewardsCatalogForTests,
} from '../../modules/src/ads/catalog';
import { validateAdRewardsFile } from '../../modules/src/ads/types';
import type { ILogger } from '../../modules/src/nkruntime';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

const GOOD_FILE = [
  { tier: 'small',  coins: 5,  cooldownSeconds: 300 },
  { tier: 'medium', coins: 15, cooldownSeconds: 900 },
  { tier: 'large',  coins: 30, cooldownSeconds: 1800 },
  { tier: 'xlarge', coins: 60, cooldownSeconds: 3600 },
];

describe('ad_rewards catalog (Phase 9 Chunk 1)', () => {
  beforeEach(() => {
    _resetAdRewardsCatalogForTests();
  });

  it('loadAdRewardsCatalog returns 4 tiers in canonical order', () => {
    const tiers = loadAdRewardsCatalog(mkLogger(), GOOD_FILE);
    expect(tiers).toHaveLength(4);
    expect(tiers.map((t) => t.tier)).toEqual(['small', 'medium', 'large', 'xlarge']);
  });

  it('getAdRewardsCatalog throws before the boot loader runs', () => {
    expect(() => getAdRewardsCatalog()).toThrow(/not loaded/);
  });

  it('loadAdRewardsCatalog throws on a non-array', () => {
    expect(() => loadAdRewardsCatalog(mkLogger(), { not: 'array' })).toThrow(/expected an array/);
  });

  it('loadAdRewardsCatalog throws on an empty array', () => {
    expect(() => loadAdRewardsCatalog(mkLogger(), [])).toThrow(/at least 1/);
  });

  it('loadAdRewardsCatalog throws on an unknown tier name', () => {
    const bad = [{ tier: 'huge', coins: 100, cooldownSeconds: 600 }];
    expect(() => loadAdRewardsCatalog(mkLogger(), bad)).toThrow(/tier/);
  });

  it('loadAdRewardsCatalog throws on duplicate tiers', () => {
    const bad = [
      { tier: 'small', coins: 5, cooldownSeconds: 300 },
      { tier: 'small', coins: 7, cooldownSeconds: 600 },
    ];
    expect(() => loadAdRewardsCatalog(mkLogger(), bad)).toThrow(/duplicate/);
  });

  it('loadAdRewardsCatalog throws on negative coins', () => {
    const bad = [{ tier: 'small', coins: -1, cooldownSeconds: 300 }];
    expect(() => loadAdRewardsCatalog(mkLogger(), bad)).toThrow(/coins/);
  });

  it('loadAdRewardsCatalog throws on cooldown < 60s (anti-spam D64)', () => {
    const bad = [{ tier: 'small', coins: 5, cooldownSeconds: 30 }];
    expect(() => loadAdRewardsCatalog(mkLogger(), bad)).toThrow(/cooldownSeconds/);
  });

  it('findAdRewardTier returns the matching tier', () => {
    loadAdRewardsCatalog(mkLogger(), GOOD_FILE);
    const t = findAdRewardTier('large');
    expect(t).toBeDefined();
    expect(t!.coins).toBe(30);
    expect(t!.cooldownSeconds).toBe(1800);
  });

  it('findAdRewardTier returns undefined for an unknown tier', () => {
    loadAdRewardsCatalog(mkLogger(), GOOD_FILE);
    expect(findAdRewardTier('huge' as never)).toBeUndefined();
  });

  it('validateAdRewardsFile accepts the bundled file shape', () => {
    const r = validateAdRewardsFile(GOOD_FILE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(4);
  });
});
