// Phase 6 Chunk 5 — `reward_granter` unit tests.
//
// Covers:
//   - coins/gems grant (wallet side effect + idempotency key shape)
//   - cosmeticId grant (catalog presence + already-owned + missing garage)
//   - never throws on missing cosmetic / CAS failure / wallet replay
//   - empty reward → all-zero result

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import type { MissionReward } from '../../modules/src/missions/types';
import { grantAchievementReward } from '../../modules/src/missions/reward_granter';
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

const COSMETIC_A = 'paint_flame_red';
const COSMETIC_B = 'wheels_chrome';

const catalogPayload = {
  cars: carsJson,
  upgrades: upgradesJson,
  cosmetics: {
    version: 1,
    items: [
      ...(cosmeticsJson as { items: unknown[] }).items,
      {
        id: COSMETIC_A,
        displayName: 'Flame',
        type: 'paint',
        rarity: 'common',
        priceCoins: 100,
        compatibleClasses: ['C', 'B'],
      },
      {
        id: COSMETIC_B,
        displayName: 'Chrome',
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
  version = 'v00000001',
): void {
  fake.store.set(`${GARAGE_COLLECTION}/${userId}/${userId}`, {
    collection: GARAGE_COLLECTION,
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      cars: [],
      cosmeticsBag,
      purchasedPacks: [],
      loadout: {
        activeCarId: '',
        equipped: {},
        stats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
      },
      lastDailyWin: 0,
      dailyPrivateCount: 0,
      dailyResetAt: 0,
    },
    version,
    permissionRead: 0,
    permissionWrite: 0,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

describe('reward_granter (Phase 6 Chunk 5)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
    _resetGarageForTests();
    loadGarageCatalog(logger, catalogPayload as never);
  });

  it('grants coins to the wallet (idempotent per sourceKey)', () => {
    const reward: MissionReward = { coins: 250 };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_first_win');
    expect(r.coins).toBe(250);
    expect(r.gems).toBe(0);
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual([]);
    expect(fake.wallets.get('u1')?.coins).toBe(250);
  });

  it('grants both coins and gems in one call', () => {
    const reward: MissionReward = { coins: 100, gems: 50 };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_500_races');
    expect(r.coins).toBe(100);
    expect(r.gems).toBe(50);
    expect(fake.wallets.get('u1')).toEqual({ coins: 100, gems: 50 });
  });

  it('does not double-pay on a re-grant (idempotency key collision)', () => {
    const reward: MissionReward = { coins: 250 };
    grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_first_win');
    const before = fake.wallets.get('u1')?.coins ?? 0;
    grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_first_win');
    const after = fake.wallets.get('u1')?.coins ?? 0;
    expect(after).toBe(before);
  });

  it('grants a cosmetic when present in catalog + garage exists', () => {
    seedGarage(fake, 'u1', []);
    const reward: MissionReward = { cosmeticId: COSMETIC_A };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_flame');
    expect(r.cosmetics).toEqual([COSMETIC_A]);
    expect(r.skippedCosmetics).toEqual([]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toContain(COSMETIC_A);
  });

  it('skips cosmetic missing from catalog (NEVER throws)', () => {
    seedGarage(fake, 'u1', []);
    const reward: MissionReward = { cosmeticId: 'does_not_exist' };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_x');
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual(['does_not_exist']);
    // Garage still has no entries.
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toEqual([]);
  });

  it('does not double-add a cosmetic already in the bag (idempotent)', () => {
    seedGarage(fake, 'u1', [COSMETIC_A]);
    const reward: MissionReward = { cosmeticId: COSMETIC_A };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_flame');
    expect(r.cosmetics).toEqual([]);
    // Already-owned counts as skipped (not added) — no-op is required.
    expect(r.skippedCosmetics).toEqual([COSMETIC_A]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored!.value.cosmeticsBag).toEqual([COSMETIC_A]);
  });

  it('lazy-creates the garage when only cosmetic reward is granted and no garage exists', () => {
    // No seedGarage call → readGarageObject returns null.
    const reward: MissionReward = { cosmeticId: COSMETIC_A };
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'ach_flame');
    expect(r.cosmetics).toEqual([COSMETIC_A]);
    const stored = readGarageObject(fake.nakama, 'u1');
    expect(stored).not.toBeNull();
    expect(stored!.value.cosmeticsBag).toContain(COSMETIC_A);
  });

  it('returns all-zero result for an empty reward', () => {
    const reward: MissionReward = {};
    const r = grantAchievementReward(fake.nakama, logger, 'u1', reward, 'achievement', 'noop');
    expect(r.coins).toBe(0);
    expect(r.gems).toBe(0);
    expect(r.cosmetics).toEqual([]);
    expect(r.skippedCosmetics).toEqual([]);
    // No wallet entry created.
    expect(fake.wallets.get('u1')).toBeUndefined();
  });
});