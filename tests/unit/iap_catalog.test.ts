// Phase 9 Chunk 1 — Unit tests for the IAP packs catalog loader.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadIapPacksCatalog,
  getIapPacksCatalog,
  findIapPack,
  findIapPackByProductId,
  _resetIapPacksCatalogForTests,
} from '../../modules/src/iap/catalog';
import {
  validateIapPacksFile,
} from '../../modules/src/iap/types';
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
  {
    id: 'coins_100', kind: 'consumable', displayName: '100 Coins',
    baseCoins: 100, firstTimeBonus: 50,
    appleProductId: 'com.cvg.coins100', googleProductId: 'coins_100',
    sortOrder: 1,
  },
  {
    id: 'gem_pack_500', kind: 'non_consumable', displayName: '500 Gems',
    cosmeticId: 'gem_pack_500',
    appleProductId: 'com.cvg.gempack500', googleProductId: 'gem_pack_500',
    sortOrder: 2,
  },
  {
    id: 'monthly_pass', kind: 'subscription', displayName: 'Monthly Pass',
    durationDays: 30, monthlyCoins: 500, monthlyCosmeticId: 'pass_exclusive_01',
    appleProductId: 'com.cvg.monthlypass', googleProductId: 'monthly_pass',
    sortOrder: 3,
  },
];

describe('iap_packs catalog (Phase 9 Chunk 1)', () => {
  beforeEach(() => {
    _resetIapPacksCatalogForTests();
  });

  it('loadIapPacksCatalog returns packs sorted by sortOrder asc', () => {
    const packs = loadIapPacksCatalog(mkLogger(), GOOD_FILE);
    expect(packs).toHaveLength(3);
    expect(packs[0]!.id).toBe('coins_100');
    expect(packs[1]!.id).toBe('gem_pack_500');
    expect(packs[2]!.id).toBe('monthly_pass');
  });

  it('getIapPacksCatalog throws before the boot loader runs', () => {
    expect(() => getIapPacksCatalog()).toThrow(/not loaded/);
  });

  it('loadIapPacksCatalog throws on a non-array', () => {
    expect(() => loadIapPacksCatalog(mkLogger(), { not: 'array' })).toThrow(/expected an array/);
  });

  it('loadIapPacksCatalog throws on an empty array', () => {
    expect(() => loadIapPacksCatalog(mkLogger(), [])).toThrow(/at least 1/);
  });

  it('loadIapPacksCatalog throws when a required field is missing', () => {
    const bad = [{ id: 'x', kind: 'consumable', displayName: 'X', baseCoins: 1, firstTimeBonus: 0 }];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/appleProductId/);
  });

  it('loadIapPacksCatalog throws on duplicate ids', () => {
    const bad = [
      { ...GOOD_FILE[0] },
      { ...GOOD_FILE[0], sortOrder: 99 },
    ];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/duplicate/);
  });

  it('loadIapPacksCatalog throws when firstTimeBonus > baseCoins', () => {
    const bad = [{
      id: 'x', kind: 'consumable', displayName: 'X',
      baseCoins: 50, firstTimeBonus: 100,
      appleProductId: 'a', googleProductId: 'g', sortOrder: 1,
    }];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/firstTimeBonus.*exceed/);
  });

  it('loadIapPacksCatalog throws when an unknown kind is supplied', () => {
    const bad = [{
      id: 'x', kind: 'subscription_box', displayName: 'X',
      appleProductId: 'a', googleProductId: 'g', sortOrder: 1,
    }];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/kind/);
  });

  it('loadIapPacksCatalog throws when a subscription is missing durationDays', () => {
    const bad = [{
      id: 'x', kind: 'subscription', displayName: 'X',
      monthlyCoins: 100, monthlyCosmeticId: 'c',
      appleProductId: 'a', googleProductId: 'g', sortOrder: 1,
    }];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/durationDays/);
  });

  it('loadIapPacksCatalog throws when a non_consumable is missing cosmeticId', () => {
    const bad = [{
      id: 'x', kind: 'non_consumable', displayName: 'X',
      appleProductId: 'a', googleProductId: 'g', sortOrder: 1,
    }];
    expect(() => loadIapPacksCatalog(mkLogger(), bad)).toThrow(/cosmeticId/);
  });

  it('findIapPack returns the matching pack by id', () => {
    loadIapPacksCatalog(mkLogger(), GOOD_FILE);
    const p = findIapPack('monthly_pass');
    expect(p).toBeDefined();
    expect(p!.kind).toBe('subscription');
  });

  it('findIapPack returns undefined for an unknown id', () => {
    loadIapPacksCatalog(mkLogger(), GOOD_FILE);
    expect(findIapPack('nope')).toBeUndefined();
  });

  it('findIapPackByProductId resolves apple and google ids', () => {
    loadIapPacksCatalog(mkLogger(), GOOD_FILE);
    const a = findIapPackByProductId('apple', 'com.cvg.coins100');
    const g = findIapPackByProductId('google', 'coins_100');
    expect(a!.id).toBe('coins_100');
    expect(g!.id).toBe('coins_100');
  });

  it('findIapPackByProductId returns undefined for an unknown product', () => {
    loadIapPacksCatalog(mkLogger(), GOOD_FILE);
    expect(findIapPackByProductId('apple', 'com.cvg.unknown')).toBeUndefined();
  });

  it('validateIapPacksFile accepts a valid file', () => {
    const r = validateIapPacksFile(GOOD_FILE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
  });
});
