// Unit tests for the Phase 3 garage stats helpers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGarageCatalog,
  _resetGarageForTests,
  getCarsCatalog,
  getUpgradesCatalog,
} from '../../modules/src/garage/catalog';
import {
  computeStats,
  computeStatsForRanked,
  computeStatsWithLoadedCatalog,
  cumulativeDelta,
} from '../../modules/src/garage/stats';
import type { ILogger } from '../../modules/src/nkruntime';
import type { RawGarageFiles } from '../../modules/src/garage/catalog';
import type {
  CarCatalogEntry,
  UpgradeLevels,
  UpgradesCatalog,
} from '../../modules/src/garage/types';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const CARS: RawGarageFiles['cars'] = {
  version: 1,
  cars: [
    {
      id: 'starter_viper',
      displayName: 'Viper inicial',
      classId: 'D',
      baseStats: { speed: 50, acceleration: 50, handling: 50, nitro: 50 },
      maxStats: { speed: 70, acceleration: 70, handling: 70, nitro: 70 },
      priceCoins: 0,
      requiredLevel: 1,
      isStarter: true,
    },
    {
      id: 'phantom_rsx',
      displayName: 'Phantom RSX',
      classId: 'B',
      baseStats: { speed: 60, acceleration: 60, handling: 60, nitro: 60 },
      maxStats: { speed: 100, acceleration: 100, handling: 100, nitro: 100 },
      priceCoins: 25000,
      requiredLevel: 12,
      isStarter: false,
    },
  ],
};

const UPGRADES: RawGarageFiles['upgrades'] = {
  version: 1,
  lines: ['engine', 'tires', 'nitro', 'handling'],
  maxLevel: 5,
  perCarClass: {
    D: {
      engine: [
        { level: 1, cost: 100, delta: { speed: 2 } },
        { level: 2, cost: 200, delta: { speed: 4 } },
        { level: 3, cost: 300, delta: { speed: 6 } },
        { level: 4, cost: 400, delta: { speed: 8 } },
        { level: 5, cost: 500, delta: { speed: 10 } },
      ],
      tires: [
        { level: 1, cost: 100, delta: { handling: 2 } },
        { level: 2, cost: 200, delta: { handling: 4 } },
        { level: 3, cost: 300, delta: { handling: 6 } },
        { level: 4, cost: 400, delta: { handling: 8 } },
        { level: 5, cost: 500, delta: { handling: 10 } },
      ],
      nitro: [
        { level: 1, cost: 100, delta: { nitro: 2 } },
        { level: 2, cost: 200, delta: { nitro: 4 } },
        { level: 3, cost: 300, delta: { nitro: 6 } },
        { level: 4, cost: 400, delta: { nitro: 8 } },
        { level: 5, cost: 500, delta: { nitro: 10 } },
      ],
      handling: [
        { level: 1, cost: 100, delta: { acceleration: 2 } },
        { level: 2, cost: 200, delta: { acceleration: 4 } },
        { level: 3, cost: 300, delta: { acceleration: 6 } },
        { level: 4, cost: 400, delta: { acceleration: 8 } },
        { level: 5, cost: 500, delta: { acceleration: 10 } },
      ],
    },
    B: {
      engine: [
        { level: 1, cost: 200, delta: { speed: 3 } },
        { level: 2, cost: 400, delta: { speed: 6 } },
        { level: 3, cost: 600, delta: { speed: 10 } },
        { level: 4, cost: 800, delta: { speed: 14 } },
        { level: 5, cost: 1000, delta: { speed: 18 } },
      ],
      tires: [
        { level: 1, cost: 200, delta: { handling: 3 } },
        { level: 2, cost: 400, delta: { handling: 6 } },
        { level: 3, cost: 600, delta: { handling: 10 } },
        { level: 4, cost: 400, delta: { handling: 14 } },
        { level: 5, cost: 1000, delta: { handling: 18 } },
      ],
      nitro: [
        { level: 1, cost: 200, delta: { nitro: 3 } },
        { level: 2, cost: 400, delta: { nitro: 6 } },
        { level: 3, cost: 600, delta: { nitro: 10 } },
        { level: 4, cost: 400, delta: { nitro: 14 } },
        { level: 5, cost: 1000, delta: { nitro: 18 } },
      ],
      handling: [
        { level: 1, cost: 200, delta: { acceleration: 3 } },
        { level: 2, cost: 400, delta: { acceleration: 6 } },
        { level: 3, cost: 600, delta: { acceleration: 10 } },
        { level: 4, cost: 400, delta: { acceleration: 14 } },
        { level: 5, cost: 1000, delta: { acceleration: 18 } },
      ],
    },
    A: {
      engine: [
        { level: 1, cost: 300, delta: { speed: 4 } },
        { level: 2, cost: 600, delta: { speed: 8 } },
        { level: 3, cost: 900, delta: { speed: 13 } },
        { level: 4, cost: 1200, delta: { speed: 18 } },
        { level: 5, cost: 1500, delta: { speed: 23 } },
      ],
      tires: [
        { level: 1, cost: 300, delta: { handling: 4 } },
        { level: 2, cost: 600, delta: { handling: 8 } },
        { level: 3, cost: 900, delta: { handling: 13 } },
        { level: 4, cost: 1200, delta: { handling: 18 } },
        { level: 5, cost: 1500, delta: { handling: 23 } },
      ],
      nitro: [
        { level: 1, cost: 300, delta: { nitro: 4 } },
        { level: 2, cost: 600, delta: { nitro: 8 } },
        { level: 3, cost: 900, delta: { nitro: 13 } },
        { level: 4, cost: 1200, delta: { nitro: 18 } },
        { level: 5, cost: 1500, delta: { nitro: 23 } },
      ],
      handling: [
        { level: 1, cost: 300, delta: { acceleration: 4 } },
        { level: 2, cost: 600, delta: { acceleration: 8 } },
        { level: 3, cost: 900, delta: { acceleration: 13 } },
        { level: 4, cost: 1200, delta: { acceleration: 18 } },
        { level: 5, cost: 1500, delta: { acceleration: 23 } },
      ],
    },
    S: {
      engine: [
        { level: 1, cost: 400, delta: { speed: 5 } },
        { level: 2, cost: 800, delta: { speed: 10 } },
        { level: 3, cost: 1200, delta: { speed: 16 } },
        { level: 4, cost: 1600, delta: { speed: 22 } },
        { level: 5, cost: 2000, delta: { speed: 28 } },
      ],
      tires: [
        { level: 1, cost: 400, delta: { handling: 5 } },
        { level: 2, cost: 800, delta: { handling: 10 } },
        { level: 3, cost: 1200, delta: { handling: 16 } },
        { level: 4, cost: 1600, delta: { handling: 22 } },
        { level: 5, cost: 2000, delta: { handling: 28 } },
      ],
      nitro: [
        { level: 1, cost: 400, delta: { nitro: 5 } },
        { level: 2, cost: 800, delta: { nitro: 6 } },
        { level: 3, cost: 1200, delta: { nitro: 16 } },
        { level: 4, cost: 1600, delta: { nitro: 22 } },
        { level: 5, cost: 2000, delta: { nitro: 28 } },
      ],
      handling: [
        { level: 1, cost: 400, delta: { acceleration: 5 } },
        { level: 2, cost: 800, delta: { acceleration: 10 } },
        { level: 3, cost: 1200, delta: { acceleration: 16 } },
        { level: 4, cost: 1600, delta: { acceleration: 22 } },
        { level: 5, cost: 2000, delta: { acceleration: 28 } },
      ],
    },
    C: {
      engine: [
        { level: 1, cost: 150, delta: { speed: 2 } },
        { level: 2, cost: 300, delta: { speed: 5 } },
        { level: 3, cost: 450, delta: { speed: 8 } },
        { level: 4, cost: 600, delta: { speed: 11 } },
        { level: 5, cost: 750, delta: { speed: 14 } },
      ],
      tires: [
        { level: 1, cost: 150, delta: { handling: 2 } },
        { level: 2, cost: 300, delta: { handling: 5 } },
        { level: 3, cost: 450, delta: { handling: 8 } },
        { level: 4, cost: 600, delta: { handling: 11 } },
        { level: 5, cost: 750, delta: { handling: 14 } },
      ],
      nitro: [
        { level: 1, cost: 150, delta: { nitro: 2 } },
        { level: 2, cost: 300, delta: { nitro: 5 } },
        { level: 3, cost: 450, delta: { nitro: 8 } },
        { level: 4, cost: 600, delta: { nitro: 11 } },
        { level: 5, cost: 750, delta: { nitro: 14 } },
      ],
      handling: [
        { level: 1, cost: 150, delta: { acceleration: 2 } },
        { level: 2, cost: 300, delta: { acceleration: 5 } },
        { level: 3, cost: 450, delta: { acceleration: 8 } },
        { level: 4, cost: 600, delta: { acceleration: 11 } },
        { level: 5, cost: 750, delta: { acceleration: 14 } },
      ],
    },
  },
};

const COSMETICS: RawGarageFiles['cosmetics'] = {
  version: 1,
  items: [],
};

function findCar(id: string): CarCatalogEntry {
  const c = getCarsCatalog().cars.find((x) => x.id === id);
  if (!c) throw new Error(`no car: ${id}`);
  return c;
}

function getUpgrades(): UpgradesCatalog {
  // Loaded catalog is wrapped in Object.freeze + per-class freeze;
  // we read via accessor so test assertions stay declarative.
  return getUpgradesCatalog();
}

const ZERO_LEVELS: UpgradeLevels = { engine: 0, tires: 0, nitro: 0, handling: 0 };
const MAX_LEVELS: UpgradeLevels = { engine: 5, tires: 5, nitro: 5, handling: 5 };

describe('garage/stats — computeStats (normal)', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(
      SILENT_LOGGER,
      { cars: CARS, upgrades: UPGRADES, cosmetics: COSMETICS },
      { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2],
    );
  });

  it('returns baseStats when no upgrades owned', () => {
    const car = findCar('starter_viper');
    const stats = computeStats(car, getUpgrades(), ZERO_LEVELS);
    expect(stats).toEqual({ speed: 50, acceleration: 50, handling: 50, nitro: 50 });
  });

  it('sums deltas from all four lines at max upgrade', () => {
    const car = findCar('starter_viper');
    const stats = computeStats(car, getUpgrades(), MAX_LEVELS);
    // base 50 + cumulative engine 2+4+6+8+10 = 30 → speed capped at 70
    // base 50 + tires 2+4+6+8+10 = 30 → handling capped at 70
    // base 50 + nitro 2+4+6+8+10 = 30 → nitro capped at 70
    // base 50 + handling 2+4+6+8+10 = 30 → acceleration capped at 70
    expect(stats).toEqual({ speed: 70, acceleration: 70, handling: 70, nitro: 70 });
  });

  it('partial upgrades yield partial deltas', () => {
    const car = findCar('starter_viper');
    const levels: UpgradeLevels = { engine: 2, tires: 0, nitro: 3, handling: 1 };
    const stats = computeStats(car, getUpgrades(), levels);
    // engine 2: 2+4 = 6 → speed = 50 + 6 = 56
    // tires 0: → handling = 50
    // nitro 3: 2+4+6 = 12 → nitro = 50 + 12 = 62
    // handling 1: 2 → acceleration = 50 + 2 = 52
    expect(stats).toEqual({ speed: 56, acceleration: 52, handling: 50, nitro: 62 });
  });

  it('caps at maxStats even when deltas would overflow', () => {
    const car = findCar('phantom_rsx');
    const stats = computeStats(car, getUpgrades(), MAX_LEVELS);
    // base 60, deltas would be speed +18 +18 = ... wait, class B deltas sum to:
    // engine: 3+6+10+14+18 = 51 → speed 60+51 = 111, capped at 100
    // tires: 3+6+10+14+18 = 51 → handling 60+51 = 111, capped at 100
    // nitro: 3+6+10+14+18 = 51 → nitro 60+51 = 111, capped at 100
    // handling: 3+6+10+14+18 = 51 → acceleration 60+51 = 111, capped at 100
    expect(stats).toEqual({ speed: 100, acceleration: 100, handling: 100, nitro: 100 });
  });

  it('treats invalid upgrade levels as zero (no NaN)', () => {
    const car = findCar('starter_viper');
    const stats = computeStats(car, getUpgrades(), {
      engine: -1,
      tires: Number.NaN as unknown as number,
      nitro: 99,
      handling: 1.5 as unknown as number,
    });
    // engine -1 → 0 (clamped)
    // tires NaN → 0 (Number.isInteger rejects)
    // nitro 99 → clamped to 5 → delta 30 → nitro capped at 70
    // handling 1.5 → 0 (not integer) → acceleration stays at base 50
    expect(stats).toEqual({ speed: 50, acceleration: 50, handling: 50, nitro: 70 });
  });
});

describe('garage/stats — computeStatsForRanked', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(
      SILENT_LOGGER,
      { cars: CARS, upgrades: UPGRADES, cosmetics: COSMETICS },
      { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2],
    );
  });

  it('returns baseStats clamped to maxStats for a brand new car', () => {
    const car = findCar('starter_viper');
    const stats = computeStatsForRanked(car, getUpgrades(), ZERO_LEVELS);
    // base 50 ≤ max 70 → identity
    expect(stats).toEqual({ speed: 50, acceleration: 50, handling: 50, nitro: 50 });
  });

  it('caps to maxStats even when fully upgraded', () => {
    const car = findCar('phantom_rsx');
    const stats = computeStatsForRanked(car, getUpgrades(), MAX_LEVELS);
    // fully upgraded phantom_rsx would be 111 → clamped to 100 (the class cap)
    expect(stats).toEqual({ speed: 100, acceleration: 100, handling: 100, nitro: 100 });
  });

  it('agrees with computeStats when baseStats already at maxStats', () => {
    // Phantom max is 100, base is 60. With MAX upgrades regular returns 100.
    // The two helpers should agree.
    const car = findCar('phantom_rsx');
    const regular = computeStats(car, getUpgrades(), MAX_LEVELS);
    const ranked = computeStatsForRanked(car, getUpgrades(), MAX_LEVELS);
    expect(regular).toEqual(ranked);
  });
});

describe('garage/stats — cumulativeDelta', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(
      SILENT_LOGGER,
      { cars: CARS, upgrades: UPGRADES, cosmetics: COSMETICS },
      { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2],
    );
  });

  it('returns an empty object for zero levels', () => {
    expect(cumulativeDelta(getUpgrades(), 'D', ZERO_LEVELS)).toEqual({});
  });

  it('only includes stats that actually accumulated a delta', () => {
    const d = cumulativeDelta(getUpgrades(), 'D', { engine: 2, tires: 0, nitro: 1, handling: 0 });
    expect(d).toEqual({ speed: 6, nitro: 2 });
  });
});

describe('garage/stats — computeStatsWithLoadedCatalog convenience', () => {
  beforeEach(() => {
    _resetGarageForTests();
    loadGarageCatalog(
      SILENT_LOGGER,
      { cars: CARS, upgrades: UPGRADES, cosmetics: COSMETICS },
      { localcachePut: () => {} } as unknown as Parameters<typeof loadGarageCatalog>[2],
    );
  });

  it('defaults to normal mode', () => {
    const car = findCar('starter_viper');
    expect(computeStatsWithLoadedCatalog(car, ZERO_LEVELS)).toEqual({
      speed: 50,
      acceleration: 50,
      handling: 50,
      nitro: 50,
    });
  });

  it('mode="ranked" caps at maxStats', () => {
    const car = findCar('phantom_rsx');
    expect(computeStatsWithLoadedCatalog(car, MAX_LEVELS, 'ranked')).toEqual({
      speed: 100,
      acceleration: 100,
      handling: 100,
      nitro: 100,
    });
  });
});