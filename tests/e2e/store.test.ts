// E2E tests for the Phase 3 store RPCs (Chunk 8):
//   - store_get: filters out owned cars/cosmetics/packs, hides
//     level-gated offers, anchors the daily rotation to a UTC day
//   - store_buy:  INSUFFICIENT_FUNDS when balance too low
//                 CONFLICT when the car/cosmetic/pack is already owned
//                 FORBIDDEN when the player level is too low
//                 NOT_FOUND when the offer id is unknown
//                 car delivery: garage.cars gains the car
//                 cosmetic delivery: garage.cosmeticsBag gains the id
//                 pack delivery: wallet credited + garage.purchasedPacks
//                 compensating refund on CAS conflict (D3 caveat)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';

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
  // Inject liveops gate bypass (clientVersion/platform) into object payloads
  // so the Phase 5 Chunk 2 UPGRADE_REQUIRED doesn't trip every legacy test.
  const body = typeof payload === 'string'
    ? payload
    : JSON.stringify({ clientVersion: '1.0.0', platform: 'ios', ...(payload as Record<string, unknown>) });
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function setCoins(env: ReturnType<typeof loadBundleForTest>, userId: string, coins: number, gems = 0): void {
  env.fakeNakama.wallets.set(userId, { coins, gems });
}

function setLevel(env: ReturnType<typeof loadBundleForTest>, userId: string, level: number): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles', key: userId, userId,
    value: { schemaVersion: 1, userId, displayName: 'Racer', avatarUrl: null, createdAt: 0, updatedAt: 0, progression: { xp: 0, level, lastDailyWinAt: 0 } },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0, createTime: now, updateTime: now, expiresAt: null,
  } as never);
}

function seedGarage(env: ReturnType<typeof loadBundleForTest>, userId: string): void {
  call<Resp<unknown>>(env, 'garage_get', userId, { callerUserId: userId });
}

describe('store_get (Chunk 8)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    seedGarage(env, HOST_ID);
    setLevel(env, HOST_ID, 50);
  });

  it('returns the three sections anchored to a UTC daySeed', () => {
    const r = call<Resp<{ dailySeed: string; sections: ReadonlyArray<{ section: { id: string } }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data.dailySeed).toBe('string');
    expect(r.data.dailySeed.length).toBeGreaterThan(0);
    const ids = r.data.sections.map((s) => s.section.id);
    expect(ids).toEqual(expect.arrayContaining(['permanent', 'daily', 'level_gated']));
  });

  it('hides level-gated offers when the player is below the required level', () => {
    setLevel(env, HOST_ID, 1);
    const r = call<Resp<{ sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lg = r.data.sections.find((s) => s.section.id === 'level_gated');
    expect(lg?.offers).toEqual([]);
  });

  it('hides already-owned cars from the level_gated section', () => {
    setCoins(env, HOST_ID, 100000);
    // Buy civic_r via the direct RPC.
    const buy = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
    expect(buy.ok).toBe(true);
    const r = call<Resp<{ sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lg = r.data.sections.find((s) => s.section.id === 'level_gated');
    const civicOffer = lg?.offers.find((o) => o.offer.offerId === 'lg_civic_r');
    expect(civicOffer).toBeUndefined();
  });

  it('hides already-owned cosmetics from the permanent section', () => {
    setCoins(env, HOST_ID, 100000);
    // Manually add the cosmetic to the bag so it's "owned".
    const stored = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
    if (!stored) throw new Error('seed garage missing');
    stored.value = { ...stored.value, cosmeticsBag: ['paint_matte_black'] };
    env.fakeNakama.store.set(`garage/${HOST_ID}/${HOST_ID}`, stored);
    const r = call<Resp<{ sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const perm = r.data.sections.find((s) => s.section.id === 'permanent');
    const owned = perm?.offers.find((o) => o.offer.offerId === 'perm_paint_matte_black');
    expect(owned).toBeUndefined();
  });

  it('hides already-purchased packs from the permanent section', () => {
    setCoins(env, HOST_ID, 100000);
    const r1 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(r1.ok).toBe(true);
    const r = call<Resp<{ sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const perm = r.data.sections.find((s) => s.section.id === 'permanent');
    const bought = perm?.offers.find((o) => o.offer.offerId === 'perm_starter_pack');
    expect(bought).toBeUndefined();
  });
});

describe('store_buy (Chunk 8)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    seedGarage(env, HOST_ID);
    setLevel(env, HOST_ID, 50);
  });

  it('buys a car and adds it to the garage', () => {
    setCoins(env, HOST_ID, 100000);
    const r = call<Resp<{ delivery: { kind: string; refId: string } }>>(
      env, 'store_buy', HOST_ID, { offerId: 'lg_civic_r', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.delivery).toEqual({ kind: 'car', refId: 'civic_r' });
    // Garage now has both starter_viper and civic_r.
    const stored = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
    const cars = (stored?.value as { cars: Array<{ carId: string }> }).cars;
    expect(cars.map((c) => c.carId)).toContain('civic_r');
  });

  it('buys a cosmetic and adds it to the bag', () => {
    setCoins(env, HOST_ID, 100000);
    const r = call<Resp<{ delivery: { kind: string; refId: string } }>>(
      env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.delivery).toEqual({ kind: 'cosmetic', refId: 'paint_matte_black' });
    const stored = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
    const bag = (stored?.value as { cosmeticsBag: string[] }).cosmeticsBag;
    expect(bag).toContain('paint_matte_black');
  });

  it('buys a pack, marks it as purchased, and credits the wallet', () => {
    setCoins(env, HOST_ID, 100000);
    const r = call<Resp<{ delivery: { kind: string; refId: string; changeset: { coins?: number; gems?: number } }; newBalance: { coins: number; gems: number } }>>(
      env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.delivery.kind).toBe('pack');
    expect(r.data.delivery.refId).toBe('starter_pack');
    const stored = env.fakeNakama.store.get(`garage/${HOST_ID}/${HOST_ID}`);
    const purchased = (stored?.value as { purchasedPacks: string[] }).purchasedPacks;
    expect(purchased).toContain('starter_pack');
    // Pack grants 5000 coins + 50 gems on top of the spend (2500 coins).
    // 100000 - 2500 + 5000 = 102500
    expect(r.data.newBalance.coins).toBe(102500);
    expect(r.data.newBalance.gems).toBe(50);
  });

  it('returns INSUFFICIENT_FUNDS when balance is too low', () => {
    setCoins(env, HOST_ID, 100);
    const r = call<Resp<unknown>>(
      env, 'store_buy', HOST_ID, { offerId: 'lg_civic_r', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('returns CONFLICT when the car is already owned', () => {
    setCoins(env, HOST_ID, 100000);
    const r1 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'lg_civic_r', callerUserId: HOST_ID });
    expect(r1.ok).toBe(true);
    const r2 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'lg_civic_r', callerUserId: HOST_ID });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('CONFLICT');
  });

  it('returns CONFLICT when the cosmetic is already owned', () => {
    setCoins(env, HOST_ID, 100000);
    const r1 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID });
    expect(r1.ok).toBe(true);
    const r2 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('CONFLICT');
  });

  it('returns CONFLICT when the pack is already purchased', () => {
    setCoins(env, HOST_ID, 100000);
    const r1 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(r1.ok).toBe(true);
    const r2 = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('CONFLICT');
  });

  it('returns FORBIDDEN when the player level is below requiredLevel', () => {
    setLevel(env, HOST_ID, 1);
    setCoins(env, HOST_ID, 100000);
    const r = call<Resp<unknown>>(
      env, 'store_buy', HOST_ID, { offerId: 'lg_civic_r', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('returns NOT_FOUND for an unknown offer', () => {
    setCoins(env, HOST_ID, 100000);
    const r = call<Resp<unknown>>(
      env, 'store_buy', HOST_ID, { offerId: 'phantom_offer', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });
});