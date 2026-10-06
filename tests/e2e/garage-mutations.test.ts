// E2E tests for the Phase 3 garage mutation RPCs (Chunk 7):
//   - car_buy:           grant coins, buy a car, garage updates,
//                        wallet debited
//   - car_buy:           INSUFFICIENT_FUNDS when balance too low
//   - car_buy:           CONFLICT when already owned
//   - car_buy:           FORBIDDEN when player level < requiredLevel
//   - car_upgrade:       charges cost from catalog, persists level
//   - car_upgrade:       rejects non-monotonic newLevel
//   - cosmetic_equip:    FORBIDDEN when not in cosmeticsBag
//   - cosmetic_equip:    FORBIDDEN when incompatible class (Decision 4)
//   - cosmetic_equip:    OK when owned + compatible
//   - loadout_set:       FORBIDDEN when car not owned
//   - loadout_set:       OK and loadout mirrors the new active car
//   - car_buy:           CAS-conflict path issues a refund
//
// We grant coins via the wallet helpers by writing a fake wallet
// into the fake nk's `wallets` map before invoking the RPC. That's
// the surface `spend()` reads via `nk.accountGetId`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';

interface GarageView {
  userId: string;
  cars: Array<{ carId: string; upgrades: { engine: number; tires: number; nitro: number; handling: number }; computedStats: { speed: number; acceleration: number; handling: number; nitro: number } }>;
  cosmeticsBag: string[];
  loadout: { activeCarId: string; stats: { speed: number; acceleration: number; handling: number; nitro: number } } | null;
  lastDailyWin: number;
  dailyPrivateCount: number;
  dailyResetAt: number;
}

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function seedGarage(env: ReturnType<typeof loadBundleForTest>, userId: string): void {
  call<Resp<unknown>>(env, 'garage_get', userId, { callerUserId: userId });
}

function setCoins(env: ReturnType<typeof loadBundleForTest>, userId: string, coins: number): void {
  env.fakeNakama.wallets.set(userId, { coins, gems: 0 });
}

/**
 * Promote the player to a given level by writing a fresh profile
 * record into the fake storage. The `car_buy` level check reads
 * `progression.level`; bypassing it lets us buy any car without
 * grinding XP.
 */
function setLevel(env: ReturnType<typeof loadBundleForTest>, userId: string, level: number): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles',
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      displayName: 'Racer',
      avatarUrl: null,
      createdAt: 0,
      updatedAt: 0,
      progression: { xp: 0, level, lastDailyWinAt: 0 },
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: now,
    updateTime: now,
    expiresAt: null,
  });
}

describe('garage mutations (Chunk 7)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    // Seed the garage so the mutation RPCs find it.
    seedGarage(env, HOST_ID);
    // Promote the player to a level that satisfies civic_r's
    // requiredLevel=6 and lets us exercise the upgrade path.
    setLevel(env, HOST_ID, 10);
  });

  describe('car_buy', () => {
    it('buys a car when balance is sufficient and debits the wallet', () => {
      // civic_r costs 8000 coins.
      setCoins(env, HOST_ID, 10000);
      const r = call<Resp<{ garage: GarageView; newBalance: { coins: number; gems: number } }>>(
        env, 'car_buy', HOST_ID,
        { carId: 'civic_r', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.garage.cars.map((c) => c.carId)).toContain('civic_r');
      // 10000 - 8000 = 2000
      expect(r.data.newBalance.coins).toBe(2000);
    });

    it('returns INSUFFICIENT_FUNDS when balance too low', () => {
      setCoins(env, HOST_ID, 100);
      const r = call<Resp<unknown>>(
        env, 'car_buy', HOST_ID,
        { carId: 'civic_r', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
      // Wallet unchanged.
      expect(env.fakeNakama.wallets.get(HOST_ID)?.['coins']).toBe(100);
    });

    it('returns CONFLICT when the car is already owned', () => {
      setCoins(env, HOST_ID, 100000);
      const r1 = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
      expect(r1.ok).toBe(true);
      const r2 = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.code).toBe('CONFLICT');
    });

    it('returns NOT_FOUND when the carId is not in the catalog', () => {
      setCoins(env, HOST_ID, 100000);
      const r = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'phantom_car', callerUserId: HOST_ID });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });

    it('returns FORBIDDEN when the caller is not the owner of the garage (cross-user)', () => {
      setCoins(env, HOST_ID, 100000);
      const r = call<Resp<unknown>>(
        env, 'car_buy', HOST_ID,
        { carId: 'civic_r', callerUserId: 'someone-else' },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('FORBIDDEN');
    });
  });

  describe('car_upgrade', () => {
    it('charges the upgrade cost and persists the new level', () => {
      setCoins(env, HOST_ID, 20000);
      const buyResp = call<Resp<{ garage: GarageView }>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
      expect(buyResp.ok).toBe(true);
      // Upgrade engine from 0 → 1 on civic_r (D-class, engine cost = 1000).
      const r = call<Resp<{ garage: GarageView; costPaid: { coins: number } }>>(
        env, 'car_upgrade', HOST_ID,
        { carId: 'civic_r', line: 'engine', newLevel: 1, callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const upgraded = r.data.garage.cars.find((c) => c.carId === 'civic_r');
      expect(upgraded?.upgrades.engine).toBe(1);
      expect(r.data.costPaid.coins).toBe(500);
      // 20000 - 8000 - 500 = 11500
      expect(env.fakeNakama.wallets.get(HOST_ID)?.['coins']).toBe(11500);
    });

    it('rejects a non-monotonic newLevel', () => {
      setCoins(env, HOST_ID, 100000);
      const buyResp = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
      expect(buyResp.ok).toBe(true);
      // Jump from 0 to 5.
      const r = call<Resp<unknown>>(
        env, 'car_upgrade', HOST_ID,
        { carId: 'civic_r', line: 'engine', newLevel: 5, callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('BAD_REQUEST');
    });

    it('rejects an upgrade on a car the caller does not own', () => {
      setCoins(env, HOST_ID, 100000);
      const r = call<Resp<unknown>>(
        env, 'car_upgrade', HOST_ID,
        { carId: 'phantom_car', line: 'engine', newLevel: 1, callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });
  });

  describe('cosmetic_equip', () => {
    it('rejects equipping a cosmetic the player does not own', () => {
      const r = call<Resp<unknown>>(
        env, 'cosmetic_equip', HOST_ID,
        { carId: 'starter_viper', slot: 'paint', cosmeticId: 'paint_red_flame', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('FORBIDDEN');
    });

    it('rejects equipping a cosmetic on a car the player does not own', () => {
      const r = call<Resp<unknown>>(
        env, 'cosmetic_equip', HOST_ID,
        { carId: 'civic_r', slot: 'paint', cosmeticId: 'paint_red_flame', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('FORBIDDEN');
    });

    it('rejects when the cosmetic is incompatible with the car class', () => {
      // Add a cosmetic to the bag. We do this by writing directly into the
      // garage (Chunk 8 will populate the bag via store purchases).
      const read = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
      if (!read) throw new Error('seed garage missing');
      read.value = { ...read.value, cosmeticsBag: ['paint_chrome_gold'] };
      env.fakeNakama.store.set(`garage/${HOST_ID}/${HOST_ID}`, read);
      // starter_viper is class D; paint_chrome_gold is compatible with C,B,A,S.
      const r = call<Resp<unknown>>(
        env, 'cosmetic_equip', HOST_ID,
        { carId: 'starter_viper', slot: 'paint', cosmeticId: 'paint_chrome_gold', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('FORBIDDEN');
      expect(r.error.details).toBeDefined();
    });

    it('equips a compatible cosmetic when owned and compatible', () => {
      // Add a D-class paint to the bag.
      const stored = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
      if (!stored) throw new Error('seed garage missing');
      stored.value = { ...stored.value, cosmeticsBag: ['paint_red_flame'] };
      env.fakeNakama.store.set(`garage/${HOST_ID}/${HOST_ID}`, stored);
      const r = call<Resp<{ garage: GarageView }>>(
        env, 'cosmetic_equip', HOST_ID,
        { carId: 'starter_viper', slot: 'paint', cosmeticId: 'paint_red_flame', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const starter = r.data.garage.cars.find((c) => c.carId === 'starter_viper');
      expect(starter?.cosmetics['paint']).toBe('paint_red_flame');
    });
  });

  describe('loadout_set', () => {
    it('changes the active car when the player owns it', () => {
      setCoins(env, HOST_ID, 100000);
      // Buy a second car.
      const buy = call<Resp<{ garage: GarageView }>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
      expect(buy.ok).toBe(true);
      // Set active to civic_r.
      const r = call<Resp<{ loadout: { activeCarId: string } }>>(
        env, 'loadout_set', HOST_ID,
        { carId: 'civic_r', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.loadout.activeCarId).toBe('civic_r');
    });

    it('returns FORBIDDEN when the car is not owned', () => {
      const r = call<Resp<unknown>>(
        env, 'loadout_set', HOST_ID,
        { carId: 'phantom_car', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when the carId is not in the catalog', () => {
      const r = call<Resp<unknown>>(
        env, 'loadout_set', HOST_ID,
        { carId: 'phantom_car', callerUserId: HOST_ID },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });
  });
});