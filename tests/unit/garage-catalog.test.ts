// Unit tests for the Phase 3 garage catalog (cars / upgrades / cosmetics).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadGarageCatalog,
  validateCars,
  validateUpgrades,
  validateCosmetics,
  _resetGarageForTests,
  getCarsCatalog,
  getUpgradesCatalog,
  getCosmeticsCatalog,
} from '../../modules/src/garage/catalog';
import type { ILogger, INakama } from '../../modules/src/nkruntime';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const VALID_CARS = {
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
      id: 'civic_r',
      displayName: 'Civic R',
      classId: 'D',
      baseStats: { speed: 55, acceleration: 52, handling: 55, nitro: 48 },
      maxStats: { speed: 75, acceleration: 72, handling: 75, nitro: 70 },
      priceCoins: 8000,
      requiredLevel: 6,
      isStarter: false,
    },
  ],
};

const VALID_UPGRADES = {
  version: 1,
  lines: ['engine', 'tires', 'nitro', 'handling'],
  maxLevel: 5,
  perCarClass: {
    D: {
      engine: [
        { level: 1, cost: 500, delta: { speed: 2 } },
        { level: 2, cost: 800, delta: { speed: 4 } },
        { level: 3, cost: 1200, delta: { speed: 6 } },
        { level: 4, cost: 1800, delta: { speed: 8 } },
        { level: 5, cost: 2500, delta: { speed: 10 } },
      ],
      tires: [
        { level: 1, cost: 400, delta: { handling: 2 } },
        { level: 2, cost: 700, delta: { handling: 4 } },
        { level: 3, cost: 1100, delta: { handling: 6 } },
        { level: 4, cost: 1600, delta: { handling: 8 } },
        { level: 5, cost: 2200, delta: { handling: 10 } },
      ],
      nitro: [
        { level: 1, cost: 400, delta: { nitro: 2 } },
        { level: 2, cost: 700, delta: { nitro: 4 } },
        { level: 3, cost: 1100, delta: { nitro: 6 } },
        { level: 4, cost: 1600, delta: { nitro: 8 } },
        { level: 5, cost: 2200, delta: { nitro: 10 } },
      ],
      handling: [
        { level: 1, cost: 400, delta: { acceleration: 2 } },
        { level: 2, cost: 700, delta: { acceleration: 4 } },
        { level: 3, cost: 1100, delta: { acceleration: 6 } },
        { level: 4, cost: 1600, delta: { acceleration: 8 } },
        { level: 5, cost: 2200, delta: { acceleration: 10 } },
      ],
    },
    C: {
      engine: [
        { level: 1, cost: 900, delta: { speed: 2 } },
        { level: 2, cost: 1400, delta: { speed: 5 } },
        { level: 3, cost: 2200, delta: { speed: 8 } },
        { level: 4, cost: 3000, delta: { speed: 11 } },
        { level: 5, cost: 4200, delta: { speed: 14 } },
      ],
      tires: [
        { level: 1, cost: 800, delta: { handling: 2 } },
        { level: 2, cost: 1200, delta: { handling: 5 } },
        { level: 3, cost: 1900, delta: { handling: 8 } },
        { level: 4, cost: 2700, delta: { handling: 11 } },
        { level: 5, cost: 3800, delta: { handling: 14 } },
      ],
      nitro: [
        { level: 1, cost: 800, delta: { nitro: 2 } },
        { level: 2, cost: 1200, delta: { nitro: 5 } },
        { level: 3, cost: 1900, delta: { nitro: 8 } },
        { level: 4, cost: 2700, delta: { nitro: 11 } },
        { level: 5, cost: 3800, delta: { nitro: 14 } },
      ],
      handling: [
        { level: 1, cost: 800, delta: { acceleration: 2 } },
        { level: 2, cost: 1200, delta: { acceleration: 5 } },
        { level: 3, cost: 1900, delta: { acceleration: 8 } },
        { level: 4, cost: 2700, delta: { acceleration: 11 } },
        { level: 5, cost: 3800, delta: { acceleration: 14 } },
      ],
    },
    B: {
      engine: [
        { level: 1, cost: 1500, delta: { speed: 3 } },
        { level: 2, cost: 2400, delta: { speed: 6 } },
        { level: 3, cost: 3600, delta: { speed: 10 } },
        { level: 4, cost: 5000, delta: { speed: 14 } },
        { level: 5, cost: 7000, delta: { speed: 18 } },
      ],
      tires: [
        { level: 1, cost: 1300, delta: { handling: 3 } },
        { level: 2, cost: 2200, delta: { handling: 6 } },
        { level: 3, cost: 3300, delta: { handling: 10 } },
        { level: 4, cost: 4600, delta: { handling: 14 } },
        { level: 5, cost: 6400, delta: { handling: 18 } },
      ],
      nitro: [
        { level: 1, cost: 1300, delta: { nitro: 3 } },
        { level: 2, cost: 2200, delta: { nitro: 6 } },
        { level: 3, cost: 3300, delta: { nitro: 10 } },
        { level: 4, cost: 4600, delta: { nitro: 14 } },
        { level: 5, cost: 6400, delta: { nitro: 18 } },
      ],
      handling: [
        { level: 1, cost: 1300, delta: { acceleration: 3 } },
        { level: 2, cost: 2200, delta: { acceleration: 6 } },
        { level: 3, cost: 3300, delta: { acceleration: 10 } },
        { level: 4, cost: 4600, delta: { acceleration: 14 } },
        { level: 5, cost: 6400, delta: { acceleration: 18 } },
      ],
    },
    A: {
      engine: [
        { level: 1, cost: 2500, delta: { speed: 4 } },
        { level: 2, cost: 4000, delta: { speed: 8 } },
        { level: 3, cost: 6000, delta: { speed: 13 } },
        { level: 4, cost: 8500, delta: { speed: 18 } },
        { level: 5, cost: 12000, delta: { speed: 23 } },
      ],
      tires: [
        { level: 1, cost: 2200, delta: { handling: 4 } },
        { level: 2, cost: 3600, delta: { handling: 8 } },
        { level: 3, cost: 5400, delta: { handling: 13 } },
        { level: 4, cost: 7700, delta: { handling: 18 } },
        { level: 5, cost: 10800, delta: { handling: 23 } },
      ],
      nitro: [
        { level: 1, cost: 2200, delta: { nitro: 4 } },
        { level: 2, cost: 3600, delta: { nitro: 8 } },
        { level: 3, cost: 5400, delta: { nitro: 13 } },
        { level: 4, cost: 7700, delta: { nitro: 18 } },
        { level: 5, cost: 10800, delta: { nitro: 23 } },
      ],
      handling: [
        { level: 1, cost: 2200, delta: { acceleration: 4 } },
        { level: 2, cost: 3600, delta: { acceleration: 8 } },
        { level: 3, cost: 5400, delta: { acceleration: 13 } },
        { level: 4, cost: 7700, delta: { acceleration: 18 } },
        { level: 5, cost: 10800, delta: { acceleration: 23 } },
      ],
    },
    S: {
      engine: [
        { level: 1, cost: 4000, delta: { speed: 5 } },
        { level: 2, cost: 6500, delta: { speed: 10 } },
        { level: 3, cost: 10000, delta: { speed: 16 } },
        { level: 4, cost: 14000, delta: { speed: 22 } },
        { level: 5, cost: 20000, delta: { speed: 28 } },
      ],
      tires: [
        { level: 1, cost: 3500, delta: { handling: 5 } },
        { level: 2, cost: 5800, delta: { handling: 10 } },
        { level: 3, cost: 9000, delta: { handling: 16 } },
        { level: 4, cost: 13000, delta: { handling: 22 } },
        { level: 5, cost: 18000, delta: { handling: 28 } },
      ],
      nitro: [
        { level: 1, cost: 3500, delta: { nitro: 5 } },
        { level: 2, cost: 5800, delta: { nitro: 10 } },
        { level: 3, cost: 9000, delta: { nitro: 16 } },
        { level: 4, cost: 13000, delta: { nitro: 22 } },
        { level: 5, cost: 18000, delta: { nitro: 28 } },
      ],
      handling: [
        { level: 1, cost: 3500, delta: { acceleration: 5 } },
        { level: 2, cost: 5800, delta: { acceleration: 10 } },
        { level: 3, cost: 9000, delta: { acceleration: 16 } },
        { level: 4, cost: 13000, delta: { acceleration: 22 } },
        { level: 5, cost: 18000, delta: { acceleration: 28 } },
      ],
    },
  },
};

const VALID_COSMETICS = {
  version: 1,
  items: [
    {
      id: 'paint_red_flame',
      displayName: 'Llama roja',
      type: 'paint',
      rarity: 'common',
      priceCoins: 500,
      compatibleClasses: ['D', 'C', 'B'],
    },
    {
      id: 'horn_pedro_scream',
      displayName: 'Grito de Pedro',
      type: 'horn',
      rarity: 'epic',
      priceGems: 25,
      compatibleClasses: ['D', 'C', 'B', 'A', 'S'],
    },
  ],
};

describe('garage/catalog — cars validator (Chunk 1)', () => {
  beforeEach(() => _resetGarageForTests());

  it('accepts the canonical shape', () => {
    expect(() => validateCars(VALID_CARS)).not.toThrow();
  });

  it('rejects duplicate car ids', () => {
    expect(() =>
      validateCars({
        ...VALID_CARS,
        cars: [VALID_CARS.cars[0], VALID_CARS.cars[0]],
      }),
    ).toThrow(/duplicate car id/);
  });

  it('requires exactly one starter car', () => {
    expect(() =>
      validateCars({
        ...VALID_CARS,
        cars: [
          { ...VALID_CARS.cars[0], isStarter: false },
          { ...VALID_CARS.cars[1], isStarter: false },
        ],
      }),
    ).toThrow(/isStarter/);
  });

  it('rejects maxStats < baseStats', () => {
    expect(() =>
      validateCars({
        ...VALID_CARS,
        cars: [
          {
            ...VALID_CARS.cars[0],
            baseStats: { speed: 80, acceleration: 50, handling: 50, nitro: 50 },
            maxStats: { speed: 70, acceleration: 70, handling: 70, nitro: 70 },
          },
        ],
      }),
    ).toThrow(/maxStats\.speed/);
  });

  it('rejects unknown classId', () => {
    expect(() =>
      validateCars({
        ...VALID_CARS,
        cars: [{ ...VALID_CARS.cars[0], classId: 'X' as 'D' }],
      }),
    ).toThrow(/classId/);
  });

  it('rejects requiredLevel outside 1..50', () => {
    expect(() =>
      validateCars({
        ...VALID_CARS,
        cars: [{ ...VALID_CARS.cars[0], requiredLevel: 51 }],
      }),
    ).toThrow(/requiredLevel/);
  });
});

describe('garage/catalog — upgrades validator (Chunk 1)', () => {
  beforeEach(() => _resetGarageForTests());

  it('accepts the canonical shape', () => {
    expect(() => validateUpgrades(VALID_UPGRADES)).not.toThrow();
  });

  it('rejects wrong line count', () => {
    expect(() =>
      validateUpgrades({ ...VALID_UPGRADES, lines: ['engine'] }),
    ).toThrow(/lines must be a 4-entry array/);
  });

  it('rejects unknown line name', () => {
    expect(() =>
      validateUpgrades({ ...VALID_UPGRADES, lines: ['engine', 'tires', 'nitro', 'wheels'] }),
    ).toThrow(/invalid upgrade line/);
  });

  it('rejects per-class table missing a class', () => {
    const bad = JSON.parse(JSON.stringify(VALID_UPGRADES));
    delete bad.perCarClass.A;
    expect(() => validateUpgrades(bad)).toThrow(/perCarClass\.A/);
  });

  it('rejects upgrade levels with mismatched level numbers', () => {
    const bad = JSON.parse(JSON.stringify(VALID_UPGRADES));
    bad.perCarClass.D.engine[2].level = 4;
    expect(() => validateUpgrades(bad)).toThrow(/level must equal/);
  });
});

describe('garage/catalog — cosmetics validator (Chunk 1)', () => {
  beforeEach(() => _resetGarageForTests());

  it('accepts the canonical shape', () => {
    expect(() => validateCosmetics(VALID_COSMETICS)).not.toThrow();
  });

  it('rejects cosmetic without price', () => {
    expect(() =>
      validateCosmetics({
        ...VALID_COSMETICS,
        items: [
          {
            ...VALID_COSMETICS.items[0],
            priceCoins: undefined,
            priceGems: undefined,
          } as unknown as typeof VALID_COSMETICS.items[number],
        ],
      }),
    ).toThrow(/must declare at least priceCoins or priceGems/);
  });

  it('rejects unknown slot', () => {
    expect(() =>
      validateCosmetics({
        ...VALID_COSMETICS,
        items: [{ ...VALID_COSMETICS.items[0], type: 'spoiler' as 'paint' }],
      }),
    ).toThrow(/type must be one of/);
  });

  it('rejects empty compatibleClasses', () => {
    expect(() =>
      validateCosmetics({
        ...VALID_COSMETICS,
        items: [{ ...VALID_COSMETICS.items[0], compatibleClasses: [] }],
      }),
    ).toThrow(/non-empty array/);
  });

  it('rejects unknown class in compatibleClasses', () => {
    expect(() =>
      validateCosmetics({
        ...VALID_COSMETICS,
        items: [{ ...VALID_COSMETICS.items[0], compatibleClasses: ['D', 'X' as 'D'] }],
      }),
    ).toThrow(/compatibleClasses/);
  });
});

describe('garage/catalog loader (Chunk 1)', () => {
  beforeEach(() => _resetGarageForTests());

  it('loadGarageCatalog freezes the runtime state and exposes all three', () => {
    const fakeNk = { localcachePut: () => {} } as unknown as INakama;
    loadGarageCatalog(
      SILENT_LOGGER,
      {
        cars: VALID_CARS,
        upgrades: VALID_UPGRADES,
        cosmetics: VALID_COSMETICS,
      },
      fakeNk,
    );
    expect(getCarsCatalog().cars.length).toBe(2);
    expect(getUpgradesCatalog().lines.length).toBe(4);
    expect(getCosmeticsCatalog().items.length).toBe(2);
  });

  it('getCarsCatalog throws before load', () => {
    expect(() => getCarsCatalog()).toThrow(/not loaded/);
  });
});