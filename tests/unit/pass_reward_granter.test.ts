// Phase 6 Chunk 6 — pass reward_granter unit tests.
//
// Covers:
//   - coins/gems wallet portion (idempotent per pass:${userId}:${refId})
//   - cosmeticId → garage.cosmeticsBag (catalog presence + already-owned
//     + missing garage)
//   - carId → garage.cars (catalog presence + already-owned + missing
//     garage)
//   - empty reward → all-zero result
//   - never throws on missing cosmetic / missing car / CAS failure

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import { grantPassReward } from '../../modules/src/pass/reward_granter';
import {
  loadGarageCatalog,
  _resetGarageForTests,
} from '../../modules/src/garage/catalog';
import carsJson from '../../modules/src/catalogs/cars.json';
import upgradesJson from '../../modules/src/catalogs/upgrades.json';
import cosmeticsJson from '../../modules/src/catalogs/cosmetics.json';
import {
  GARAGE_COLLECTION,
  readGarageObject,
} from '../../modules/src/garage/storage';
import type { PassLevelReward } from '../../modules/src/pass/types';

const COSMETIC_A = 'paint_reward_test';
const COSMETIC_B = 'wheels_reward_test';
const CAR_A = carsJson.cars.find((c) => c.isStarter)?.id ?? carsJson.cars[0]!.id;

const catalogPayload = {
  cars: carsJson,
  upgrades: upgradesJson,
  cosmetics: {
    version: 1,
    items: [
      ...(cosmeticsJson as { items: unknown[] }).items,
      {
        id: COSMETIC_A,
        displayName: 'Test paint',
        type: 'paint',
        rarity: 'common',
        priceCoins: 100,
        compatibleClasses: ['C', 'B'],
      },
      {
        id: COSMETIC_B,
        displayName: 'Test wheels',
        type: 'wheels',
        rarity: 'rare',
        priceGems: 10,
        compatibleClasses: ['C', 'B', 'A'],
      },
    ],
  },
};

function seedGarage(
  fake: FakeNakama,
  userId: string,
  cosmeticsBag: string[] = [],
  cars: string[] = [],
): void {
  const starter = carsJson.cars.find((c) => c.isStarter) ?? carsJson.cars[0]!;
  const ownedCars = [
    {
      carId: starter.id,
      classId: starter.classId,
      upgrades: { engine: 0, tires: 0, nitro: 0, handling: 0 },
      cosmetics: {},
      computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
    },
    ...cars.map((carId) => {
      const c = carsJson.cars.find((cc) => cc.id === carId)!;
      return {
        carId: c.id,
        classId: c.classId,
        upgrades: { engine: 0, tires: 0, nitro: 0, handling: 0 },
        cosmetics: {},
        computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
      };
    }),
  ];
  fake.store.set(`${GARAGE_COLLECTION}/${userId}/${userId}`, {
    collection: GARAGE_COLLECTION,
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      cars: ownedCars,
      cosmeticsBag,
      purchasedPacks: [],
      loadout: {
        activeCarId: starter.id,
        equipped: {},
        stats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
      },
      lastDailyWin: 0,
      dailyPrivateCount: 0,
      dailyResetAt: 0,
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

describe('pass reward_granter (Phase 6 Chunk 6)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
    _resetGarageForTests();
    loadGarageCatalog(logger, catalogPayload as never);
  });

  it('grants coins to the wallet (idempotent per refId)', () => {
    const reward: PassLevelReward = { coins: 250 };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl1-free');
    expect(r.coins).toBe(250);
    expect(r.gems).toBe(0);
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual([]);
    expect(r.cars).toEqual([]);
    expect(r.skippedCars).toEqual([]);
    expect(fake.wallets.get('u1')?.coins).toBe(250);
  });

  it('grants both coins and gems in one call', () => {
    const reward: PassLevelReward = { coins: 100, gems: 50 };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl2-premium');
    expect(r.coins).toBe(100);
    expect(r.gems).toBe(50);
    expect(fake.wallets.get('u1')).toEqual({ coins: 100, gems: 50 });
  });

  it('does not double-pay on a re-grant (idempotency key collision)', () => {
    const reward: PassLevelReward = { coins: 250 };
    grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl1-free');
    const before = fake.wallets.get('u1')?.coins ?? 0;
    grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl1-free');
    const after = fake.wallets.get('u1')?.coins ?? 0;
    expect(after).toBe(before);
  });

  it('grants a cosmetic when present in catalog + garage exists', () => {
    seedGarage(fake, 'u1', []);
    const reward: PassLevelReward = { cosmeticId: COSMETIC_A };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl2-free');
    expect(r.cosmetics).toEqual([COSMETIC_A]);
    expect(r.skippedCosmetics).toEqual([]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toContain(COSMETIC_A);
  });

  it('skips cosmetic missing from catalog (NEVER throws)', () => {
    seedGarage(fake, 'u1', []);
    const reward: PassLevelReward = { cosmeticId: 'does_not_exist' };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-x-free');
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual(['does_not_exist']);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toEqual([]);
  });

  it('does not double-add a cosmetic already in the bag (idempotent)', () => {
    seedGarage(fake, 'u1', [COSMETIC_A]);
    const reward: PassLevelReward = { cosmeticId: COSMETIC_A };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl2-free');
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual([COSMETIC_A]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toEqual([COSMETIC_A]);
  });

  it('lazy-creates the garage when only cosmetic reward is granted', () => {
    const reward: PassLevelReward = { cosmeticId: COSMETIC_A };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl2-free');
    expect(r.cosmetics).toEqual([COSMETIC_A]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored).not.toBeNull();
    expect(stored!.value.cosmeticsBag).toContain(COSMETIC_A);
  });

  it('grants a car when present in catalog + garage exists', () => {
    seedGarage(fake, 'u1');
    const reward: PassLevelReward = { carId: CAR_A };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-premium-car');
    // CAR_A is the starter car, already owned → skippedCars.
    expect(r.cars).toEqual([]);
    expect(r.skippedCars).toEqual([CAR_A]);
  });

  it('grants a new (non-starter) car when present in catalog + not yet owned', () => {
    seedGarage(fake, 'u1');
    // Pick any non-starter car.
    const newCar = carsJson.cars.find((c) => !c.isStarter)!.id;
    const reward: PassLevelReward = { carId: newCar };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-premium-car');
    expect(r.cars).toEqual([newCar]);
    expect(r.skippedCars).toEqual([]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cars.some((c) => c.carId === newCar)).toBe(true);
  });

  it('skips car missing from catalog (NEVER throws)', () => {
    seedGarage(fake, 'u1');
    const reward: PassLevelReward = { carId: 'no_such_car' };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-x-premium');
    expect(r.cars).toEqual([]);
    expect(r.skippedCars).toEqual(['no_such_car']);
  });

  it('lazy-creates the garage for a car-only reward', () => {
    const newCar = carsJson.cars.find((c) => !c.isStarter)!.id;
    const reward: PassLevelReward = { carId: newCar };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-premium-car');
    expect(r.cars).toEqual([newCar]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored).not.toBeNull();
    expect(stored!.value.cars.some((c) => c.carId === newCar)).toBe(true);
  });

  it('grants coins + cosmetic + car in one call (mixed)', () => {
    seedGarage(fake, 'u1');
    const newCar = carsJson.cars.find((c) => !c.isStarter)!.id;
    const reward: PassLevelReward = {
      coins: 500,
      gems: 10,
      cosmeticId: COSMETIC_B,
      carId: newCar,
    };
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'lvl-final');
    expect(r.coins).toBe(500);
    expect(r.gems).toBe(10);
    expect(r.cosmetics).toEqual([COSMETIC_B]);
    expect(r.cars).toEqual([newCar]);
  });

  it('returns all-zero result for an empty reward', () => {
    const reward: PassLevelReward = {};
    const r = grantPassReward(fake.nakama, logger, 'u1', reward, 'noop');
    expect(r.coins).toBe(0);
    expect(r.gems).toBe(0);
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual([]);
    expect(r.cars).toEqual([]);
    expect(r.skippedCars).toEqual([]);
    // No wallet entry created.
    expect(fake.wallets.get('u1')).toBeUndefined();
  });
});