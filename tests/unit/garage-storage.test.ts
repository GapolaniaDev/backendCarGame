// Unit tests for the Phase 3 garage storage helpers. Pure logic —
// `defaultGarage`, `findStarterCar`, `ownedCarFor`. Storage I/O is
// exercised in the e2e harness.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultGarage,
  findStarterCar,
  ownedCarFor,
  addCarToGarage,
  applyUpgrade,
  equipCosmetic,
  setActiveCar,
  ensureCarNotOwned,
  EMPTY_OWNED_COSMETICS,
} from '../../modules/src/garage/storage';
import {
  _resetGarageForTests,
  loadGarageCatalog,
  getGarageCatalog,
} from '../../modules/src/garage/catalog';
import type { ILogger } from '../../modules/src/nkruntime';
import type { RawGarageFiles } from '../../modules/src/garage/catalog';
import type { UpgradeLevels } from '../../modules/src/garage/types';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const RAW: RawGarageFiles = {
  cars: {
    version: 1,
    cars: [
      {
        id: 'starter_viper',
        displayName: 'Viper inicial',
        classId: 'D',
        baseStats: { speed: 50, acceleration: 50, handling: 50, nitro: 50 },
        maxStats: { speed: 70, acceleration: 70, handling: 70, nitro: 70 },
        priceCoins: 0,
        priceGems: 0,
        requiredLevel: 1,
        isStarter: true,
      },
      {
        id: 'civic_r',
        displayName: 'Civic R',
        classId: 'D',
        baseStats: { speed: 55, acceleration: 52, handling: 55, nitro: 48 },
        maxStats: { speed: 75, acceleration: 72, handling: 75, nitro: 70 },
        priceCoins: 5000,
        requiredLevel: 1,
        isStarter: false,
      },
    ],
  },
  upgrades: {
    version: 1,
    lines: ['engine', 'tires', 'nitro', 'handling'],
    maxLevel: 5,
    perCarClass: {
      D: makeClassTable(2),
      C: makeClassTable(2.5),
      B: makeClassTable(3),
      A: makeClassTable(3.5),
      S: makeClassTable(4),
    },
  },
  cosmetics: { version: 1, items: [] },
};

describe('garage/storage — defaultGarage', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(SILENT_LOGGER, RAW, { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2]);
  });

  it('grants the starter car active in the loadout with zero upgrades', () => {
    const g = defaultGarage('u-1', 1700000000000);
    expect(g.userId).toBe('u-1');
    expect(g.cars).toHaveLength(1);
    expect(g.cars[0]?.carId).toBe('starter_viper');
    expect(g.cars[0]?.upgrades).toEqual({ engine: 0, tires: 0, nitro: 0, handling: 0 });
    expect(g.cars[0]?.cosmetics).toEqual(EMPTY_OWNED_COSMETICS);
    expect(g.loadout).not.toBeNull();
    expect(g.loadout?.activeCarId).toBe('starter_viper');
    expect(g.loadout?.equipped).toEqual({});
    expect(g.lastDailyWin).toBe(0);
    expect(g.dailyPrivateCount).toBe(0);
    expect(g.dailyResetAt).toBe(1700000000000);
  });

  it('computes stats equal to baseStats when upgrades are zero', () => {
    const g = defaultGarage('u-1', 1700000000000);
    // starter_viper baseStats all 50; maxStats all 70; zero upgrades → 50.
    expect(g.loadout?.stats).toEqual({
      speed: 50,
      acceleration: 50,
      handling: 50,
      nitro: 50,
    });
    expect(g.cars[0]?.computedStats).toEqual({
      speed: 50,
      acceleration: 50,
      handling: 50,
      nitro: 50,
    });
  });

  it('loadout stats mirror the active car\'s computedStats', () => {
    const g = defaultGarage('u-1', 1700000000000);
    expect(g.loadout?.stats).toEqual(g.cars[0]?.computedStats);
  });
});

describe('garage/storage — findStarterCar', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(SILENT_LOGGER, RAW, { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2]);
  });

  it('returns the catalog entry flagged isStarter', () => {
    const c = findStarterCar();
    expect(c.id).toBe('starter_viper');
    expect(c.isStarter).toBe(true);
  });
});

describe('garage/storage — ownedCarFor', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(SILENT_LOGGER, RAW, { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2]);
  });

  it('builds an OwnedCar from a catalog entry at the given upgrade levels', () => {
    const catalog = getGarageCatalog();
    const civic = catalog.cars.cars.find((c) => c.id === 'civic_r');
    expect(civic).toBeDefined();
    if (!civic) return;
    const levels: UpgradeLevels = { engine: 3, tires: 1, nitro: 0, handling: 2 };
    const owned = ownedCarFor(civic, levels);
    expect(owned.carId).toBe('civic_r');
    expect(owned.classId).toBe('D');
    expect(owned.upgrades).toEqual(levels);
    // computedStats filled in by caller; ownedCarFor leaves it zeroed.
    expect(owned.computedStats).toEqual({
      speed: 0,
      acceleration: 0,
      handling: 0,
      nitro: 0,
    });
  });

  it('copies upgrade objects so callers can mutate without affecting the original', () => {
    const catalog = getGarageCatalog();
    const civic = catalog.cars.cars.find((c) => c.id === 'civic_r');
    if (!civic) return;
    const levels: UpgradeLevels = { engine: 1, tires: 1, nitro: 1, handling: 1 };
    const owned = ownedCarFor(civic, levels);
    owned.upgrades.engine = 99;
    expect(levels.engine).toBe(1);
  });
});

describe('garage/storage — mutations (Chunk 7)', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(SILENT_LOGGER, RAW, { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2]);
  });

  it('addCarToGarage appends a new owned car with zero upgrades + base stats', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    const catalog = getGarageCatalog();
    const civic = catalog.cars.cars.find((c) => c.id === 'civic_r');
    if (!civic) throw new Error('civic_r missing');
    const next = addCarToGarage(initial, civic);
    expect(next.cars).toHaveLength(2);
    expect(next.cars[1]?.carId).toBe('civic_r');
    expect(next.cars[1]?.upgrades).toEqual({ engine: 0, tires: 0, nitro: 0, handling: 0 });
    // civic_r baseStats all 50-ish; not zero.
    expect(next.cars[1]?.computedStats.speed).toBeGreaterThan(0);
  });

  it('ensureCarNotOwned throws when the car is already in the garage', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    expect(() => ensureCarNotOwned(initial, 'starter_viper')).toThrow(/already owned/);
    expect(() => ensureCarNotOwned(initial, 'civic_r')).not.toThrow();
  });

  it('applyUpgrade bumps the line and recomputes stats', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    const before = initial.cars[0]?.computedStats.speed ?? 0;
    const next = applyUpgrade(initial, 'starter_viper', 'engine', 1);
    const after = next.cars[0]?.computedStats.speed ?? 0;
    expect(next.cars[0]?.upgrades.engine).toBe(1);
    expect(after).toBeGreaterThan(before);
  });

  it('applyUpgrade syncs the loadout stats when the active car was upgraded', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    const before = initial.loadout?.stats.speed ?? 0;
    const next = applyUpgrade(initial, 'starter_viper', 'engine', 1);
    expect(next.loadout?.stats.speed).toBeGreaterThan(before);
  });

  it('equipCosmetic attaches a cosmetic to the right slot', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    const next = equipCosmetic(initial, 'starter_viper', 'paint', 'paint_red_flame');
    expect(next.cars[0]?.cosmetics.paint).toBe('paint_red_flame');
    expect(next.loadout?.equipped.paint).toBe('paint_red_flame');
  });

  it('setActiveCar rejects a car the caller does not own', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    expect(() => setActiveCar(initial, 'civic_r')).toThrow(/not owned/);
  });

  it('setActiveCar switches the loadout to a different owned car', () => {
    const initial = defaultGarage('u-1', 1700000000000);
    const catalog = getGarageCatalog();
    const civic = catalog.cars.cars.find((c) => c.id === 'civic_r');
    if (!civic) throw new Error('civic_r missing');
    const withCivic = addCarToGarage(initial, civic);
    const next = setActiveCar(withCivic, 'civic_r');
    expect(next.loadout?.activeCarId).toBe('civic_r');
    // Stats snapshot reflects civic's base stats.
    expect(next.loadout?.stats.speed).toBe(civic.baseStats.speed);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClassTable(
  deltaSize: number,
): {
  engine: Array<{ level: number; cost: number; delta: { speed: number } }>;
  tires: Array<{ level: number; cost: number; delta: { handling: number } }>;
  nitro: Array<{ level: number; cost: number; delta: { nitro: number } }>;
  handling: Array<{ level: number; cost: number; delta: { acceleration: number } }>;
} {
  const costs = [1000, 2000, 3000, 4000, 5000];
  const build = (stat: string): Array<{ level: number; cost: number; delta: Record<string, number> }> =>
    costs.map((cost, idx) => ({ level: idx + 1, cost, delta: { [stat]: deltaSize } }));
  return {
    engine: build('speed') as Array<{ level: number; cost: number; delta: { speed: number } }>,
    tires: build('handling') as Array<{ level: number; cost: number; delta: { handling: number } }>,
    nitro: build('nitro') as Array<{ level: number; cost: number; delta: { nitro: number } }>,
    handling: build('acceleration') as Array<{ level: number; cost: number; delta: { acceleration: number } }>,
  };
}