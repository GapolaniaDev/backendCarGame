// Unit tests for the Phase 3 store rotation + filter helpers.
// Pure functions — no storage, no Nakama.

import { describe, it, expect } from 'vitest';
import {
  dayKeyUtc,
  dayIndexUtc,
  resolveDailyRotation,
  withDailyRotation,
} from '../../modules/src/store/rotation';
import {
  filterOffersForSection,
  filterCatalog,
  ownershipFromGarage,
  type FilterContext,
} from '../../modules/src/store/filter';
import { resolvePackDelivery, listKnownPackIds } from '../../modules/src/store/packs';
import type { StoreCatalog, StoreOffer, StoreSection } from '../../modules/src/store/types';

const CATALOG: StoreCatalog = {
  version: 1,
  dailyRotationPoolSize: 3,
  sections: [
    {
      id: 'permanent',
      displayName: 'Tienda permanente',
      offers: [
        mk('perm_paint_matte_black', 'cosmetic', 'paint_matte_black', { priceCoins: 1500 }),
        mk('perm_wheels_neon_rim', 'cosmetic', 'wheels_neon_rim', { priceCoins: 5000 }),
      ],
    },
    {
      id: 'daily',
      displayName: 'Oferta del día',
      offers: [
        mk('d1', 'cosmetic', 'paint_red_flame', { priceCoins: 250 }),
        mk('d2', 'cosmetic', 'paint_neon_green', { priceCoins: 750 }),
        mk('d3', 'cosmetic', 'wheels_chrome_spoke', { priceCoins: 400 }),
        mk('d4', 'cosmetic', 'decal_thunder_skull', { priceCoins: 350 }),
        mk('d5', 'cosmetic', 'trail_red_fire', { priceCoins: 300 }),
      ],
    },
    {
      id: 'level_gated',
      displayName: 'Por nivel',
      offers: [
        mk('lg_civic_r', 'car', 'civic_r', { priceCoins: 8000, requiredLevel: 6 }),
        mk('lg_trail_gold_sparks', 'cosmetic', 'trail_gold_sparks', { priceCoins: 4500, requiredLevel: 8 }),
      ],
    },
  ],
};

describe('store/rotation', () => {
  it('dayKeyUtc is base36 of the day index', () => {
    const now = 24 * 60 * 60 * 1000; // day 1
    expect(dayKeyUtc(now)).toBe('1');
    expect(dayIndexUtc(now)).toBe(1);
  });

  it('resolveDailyRotation is deterministic per UTC day', () => {
    const now = Date.UTC(2026, 9, 6, 0, 0, 0);
    const r1 = resolveDailyRotation(CATALOG, now);
    const r2 = resolveDailyRotation(CATALOG, now);
    expect(r1.map((o) => o.offerId)).toEqual(r2.map((o) => o.offerId));
  });

  it('resolveDailyRotation changes between days (skip rare collisions)', () => {
    // The hash-driven rotation can occasionally produce the same
    // 3-item slice on adjacent days; this test loops over a few
    // days to assert the *eventual* change, not the immediate one.
    const start = Date.UTC(2026, 9, 6, 0, 0, 0);
    const base = resolveDailyRotation(CATALOG, start);
    const baseIds = new Set(base.map((o) => o.offerId));
    let sawDifferent = false;
    for (let i = 1; i < 60; i += 1) {
      const next = resolveDailyRotation(CATALOG, start + i * 24 * 60 * 60 * 1000);
      const nextIds = new Set(next.map((o) => o.offerId));
      // Sets differ in at least one element.
      let differs = false;
      for (const id of nextIds) if (!baseIds.has(id)) { differs = true; break; }
      for (const id of baseIds) if (!nextIds.has(id)) { differs = true; break; }
      if (differs) { sawDifferent = true; break; }
    }
    expect(sawDifferent).toBe(true);
  });

  it('resolveDailyRotation respects poolSize cap', () => {
    const now = Date.UTC(2026, 9, 6, 0, 0, 0);
    const r = resolveDailyRotation(CATALOG, now);
    expect(r.length).toBeLessThanOrEqual(CATALOG.dailyRotationPoolSize);
    expect(r.length).toBeGreaterThan(0);
  });

  it('withDailyRotation returns all sections, daily section has the rotated offers', () => {
    const now = Date.UTC(2026, 9, 6, 0, 0, 0);
    const out = withDailyRotation(CATALOG, now);
    expect(out).toHaveLength(3);
    const daily = out.find((s) => s.id === 'daily');
    expect(daily?.offers.length).toBe(CATALOG.dailyRotationPoolSize);
    const perm = out.find((s) => s.id === 'permanent');
    expect(perm?.offers).toEqual(CATALOG.sections[0]?.offers);
  });
});

describe('store/filter', () => {
  const baseCtx: FilterContext = {
    nowMs: Date.UTC(2026, 9, 6, 0, 0, 0),
    playerLevel: 50,
    ownedCarIds: new Set<string>(),
    ownedCosmeticIds: new Set<string>(),
    purchasedPackIds: new Set<string>(),
  };

  it('drops expired offers', () => {
    const section: StoreSection = {
      id: 'permanent',
      displayName: 't',
      offers: [
        mk('expired', 'cosmetic', 'paint_x', { priceCoins: 100, expiresAt: 1 }),
        mk('live', 'cosmetic', 'paint_y', { priceCoins: 100, expiresAt: null }),
      ],
    };
    const { visible, hidden } = filterOffersForSection(section, baseCtx);
    expect(visible.map((v) => v.offer.offerId)).toEqual(['live']);
    expect(hidden[0]?.reason).toBe('expired');
  });

  it('drops offers that require a higher level than the player', () => {
    const section: StoreSection = {
      id: 'level_gated',
      displayName: 't',
      offers: [
        mk('lg_civic_r', 'car', 'civic_r', { priceCoins: 8000, requiredLevel: 6 }),
      ],
    };
    const { visible, hidden } = filterOffersForSection(section, { ...baseCtx, playerLevel: 5 });
    expect(visible).toEqual([]);
    expect(hidden[0]?.reason).toBe('level_low');
  });

  it('drops cars already in the player\'s garage', () => {
    const section: StoreSection = {
      id: 'level_gated',
      displayName: 't',
      offers: [mk('lg_civic_r', 'car', 'civic_r', { priceCoins: 8000, requiredLevel: 6 })],
    };
    const { visible, hidden } = filterOffersForSection(section, {
      ...baseCtx, ownedCarIds: new Set(['civic_r']),
    });
    expect(visible).toEqual([]);
    expect(hidden[0]?.reason).toBe('already_owned');
  });

  it('drops cosmetics already in the bag', () => {
    const section: StoreSection = {
      id: 'permanent',
      displayName: 't',
      offers: [mk('p1', 'cosmetic', 'paint_matte_black', { priceCoins: 1500 })],
    };
    const { visible, hidden } = filterOffersForSection(section, {
      ...baseCtx, ownedCosmeticIds: new Set(['paint_matte_black']),
    });
    expect(visible).toEqual([]);
    expect(hidden[0]?.reason).toBe('already_owned');
  });

  it('drops packs already purchased', () => {
    const section: StoreSection = {
      id: 'permanent',
      displayName: 't',
      offers: [mk('perm_starter_pack', 'pack', 'starter_pack', { priceCoins: 2500 })],
    };
    const { visible, hidden } = filterOffersForSection(section, {
      ...baseCtx, purchasedPackIds: new Set(['starter_pack']),
    });
    expect(visible).toEqual([]);
    expect(hidden[0]?.reason).toBe('already_owned');
  });

  it('flags daily offers as isDailyOffer=true', () => {
    const section: StoreSection = {
      id: 'daily',
      displayName: 't',
      offers: [mk('d1', 'cosmetic', 'paint_red_flame', { priceCoins: 250 })],
    };
    const { visible } = filterOffersForSection(section, baseCtx);
    expect(visible[0]?.isDailyOffer).toBe(true);
  });

  it('ownershipFromGarage extracts car + cosmetic ids', () => {
    const garage = {
      schemaVersion: 1 as const,
      userId: 'u-1',
      cars: [{ carId: 'starter_viper' } as unknown as never],
      cosmeticsBag: ['paint_red_flame', 'wheels_neon_rim'],
      purchasedPacks: [],
      loadout: null,
      lastDailyWin: 0,
      dailyPrivateCount: 0,
      dailyResetAt: 0,
    };
    const { ownedCarIds, ownedCosmeticIds } = ownershipFromGarage(garage);
    expect([...ownedCarIds]).toEqual(['starter_viper']);
    expect([...ownedCosmeticIds].sort()).toEqual(['paint_red_flame', 'wheels_neon_rim']);
  });

  it('filterCatalog returns visible offers per section', () => {
    const out = filterCatalog(CATALOG, baseCtx);
    expect(out).toHaveLength(3);
    const daily = out.find((s) => s.section.id === 'daily');
    expect(daily?.visible.length).toBeGreaterThan(0);
    const lg = out.find((s) => s.section.id === 'level_gated');
    expect(lg?.visible.length).toBe(2);
  });
});

describe('store/packs', () => {
  it('resolves a known pack', () => {
    const d = resolvePackDelivery('coin_sack_small');
    expect(d?.changeset.coins).toBe(1000);
  });

  it('returns null for an unknown pack', () => {
    expect(resolvePackDelivery('phantom_pack')).toBeNull();
  });

  it('listKnownPackIds lists the seeded packs', () => {
    const ids = listKnownPackIds();
    expect(ids).toContain('starter_pack');
    expect(ids).toContain('coin_sack_small');
    expect(ids).toContain('coin_sack_large');
  });
});

function mk(
  offerId: string,
  kind: 'car' | 'cosmetic' | 'pack',
  refId: string,
  opts: { priceCoins?: number; priceGems?: number; requiredLevel?: number; expiresAt?: number | null } = {},
): StoreOffer {
  return {
    offerId,
    kind,
    refId,
    displayName: offerId,
    ...(opts.priceCoins !== undefined ? { priceCoins: opts.priceCoins } : {}),
    ...(opts.priceGems !== undefined ? { priceGems: opts.priceGems } : {}),
    ...(opts.requiredLevel !== undefined ? { requiredLevel: opts.requiredLevel } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
}