// Refund safety of the money RPCs (plan T-11; audit 05 f11, f12, f14;
// HT-73). The charge and the delivery share ONE `nk.multiUpdate`: when
// the garage write loses its CAS nothing is charged, nothing is
// delivered, and the retry charges normally. Balances are compared as
// snapshots (the stub stores a new wallet object per update), so the
// assertions are exact.
//
//   1. car_buy / car_upgrade / store_buy (pack) with a lost garage CAS
//      leave the wallet and the garage exactly as they were.
//   2. The retry charges once (HT-73: never a free re-delivery).
//   3. Ten store_buy calls racing on the same offer charge once.
//   4. pass_buy_premium whose flag write keeps failing is refunded with
//      the compensating movement, and the next attempt charges again.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };
type Env = ReturnType<typeof loadBundleForTest>;
type AnyFn = (...args: unknown[]) => unknown;

function call<T>(env: Env, rpc: string, caller: string, payload: unknown): T {
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

function setCoins(env: Env, userId: string, coins: number, gems = 0): void {
  env.fakeNakama.wallets.set(userId, { coins, gems });
}

function setLevel(env: Env, userId: string, level: number): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles', key: userId, userId,
    value: { schemaVersion: 1, userId, displayName: 'Racer', avatarUrl: null, createdAt: 0, updatedAt: 0, progression: { xp: 0, level, lastDailyWinAt: 0 } },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0, createTime: now, updateTime: now, expiresAt: null,
  } as never);
}

function seedGarage(env: Env, userId: string): void {
  call<Resp<unknown>>(env, 'garage_get', userId, { callerUserId: userId });
}

function balance(env: Env, userId: string): { coins: number; gems: number } {
  const w = env.fakeNakama.wallets.get(userId) ?? {};
  return { coins: w['coins'] ?? 0, gems: w['gems'] ?? 0 };
}

function garageValue(env: Env, userId: string): { cars: Array<{ carId: string; upgrades: Record<string, number> }>; cosmeticsBag: string[]; purchasedPacks: string[] } {
  return env.fakeNakama.store.get(`garage/${userId}/${userId}`)?.value as never;
}

/** Wrap one INakama method; returns the restore function. */
function wrap(env: Env, name: string, make: (original: AnyFn) => AnyFn): () => void {
  const nak = env.nak as unknown as Record<string, AnyFn>;
  const original = nak[name] as AnyFn;
  nak[name] = make((...args: unknown[]) => original.apply(env.nak, args));
  return () => { nak[name] = original; };
}

/**
 * The next multiUpdate that writes the garage loses its CAS: a
 * "concurrent" garage write lands between the RPC's read and its commit.
 */
function concurrentGarageWrite(env: Env): void {
  let armed = true;
  wrap(env, 'multiUpdate', (original) => (...args: unknown[]) => {
    const writes = (args[1] as Array<{ collection: string; userId: string }> | undefined) ?? [];
    const garage = writes.find((w) => w.collection === 'garage');
    if (armed && garage) {
      armed = false;
      const cur = env.fakeNakama.store.get(`garage/${garage.userId}/${garage.userId}`);
      env.nak.storageWrite([{ ...(cur as never), version: undefined } as never]);
    }
    return original(...args);
  });
}

describe('refund safety: charge and delivery in one transaction (T-11)', () => {
  let env: Env;

  beforeEach(() => {
    env = loadBundleForTest();
    seedGarage(env, HOST_ID);
    setLevel(env, HOST_ID, 50);
  });

  it('car_buy with a lost garage CAS charges nothing; the retry charges once', () => {
    setCoins(env, HOST_ID, 100000);
    concurrentGarageWrite(env);

    const r = call<Resp<unknown>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000, gems: 0 });
    expect(garageValue(env, HOST_ID).cars.map((c) => c.carId)).not.toContain('civic_r');

    const retry = call<Resp<{ newBalance: { coins: number } }>>(env, 'car_buy', HOST_ID, { carId: 'civic_r', callerUserId: HOST_ID });
    expect(retry.ok).toBe(true);
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000 - 8000, gems: 0 });
    if (retry.ok) expect(retry.data.newBalance.coins).toBe(92000);
    expect(garageValue(env, HOST_ID).cars.map((c) => c.carId)).toContain('civic_r');
  });

  it('car_upgrade with a lost garage CAS charges nothing; the retry charges once', () => {
    setCoins(env, HOST_ID, 100000);
    concurrentGarageWrite(env);
    const payload = { carId: 'starter_viper', line: 'engine', newLevel: 1, callerUserId: HOST_ID };

    const r = call<Resp<unknown>>(env, 'car_upgrade', HOST_ID, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000, gems: 0 });

    const retry = call<Resp<{ costPaid: { coins: number } }>>(env, 'car_upgrade', HOST_ID, payload);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.costPaid.coins).toBeGreaterThan(0);
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000 - retry.data.costPaid.coins, gems: 0 });
    expect(garageValue(env, HOST_ID).cars.find((c) => c.carId === 'starter_viper')?.upgrades['engine']).toBe(1);
  });

  it('store_buy of a pack with a lost garage CAS keeps neither the price nor the pack (audit 05 f12)', () => {
    setCoins(env, HOST_ID, 100000);
    concurrentGarageWrite(env);

    const r = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000, gems: 0 });
    expect(garageValue(env, HOST_ID).purchasedPacks).not.toContain('starter_pack');

    // Price 2500 coins; the pack holds 5000 coins + 50 gems.
    const retry = call<Resp<{ newBalance: { coins: number; gems: number } }>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(retry.ok).toBe(true);
    expect(balance(env, HOST_ID)).toEqual({ coins: 100000 - 2500 + 5000, gems: 50 });
    if (retry.ok) expect(retry.data.newBalance).toEqual({ coins: 102500, gems: 50 });
    expect(garageValue(env, HOST_ID).purchasedPacks).toContain('starter_pack');
  });

  it('store_buy after a failed delivery charges the rebuy (HT-73)', () => {
    setCoins(env, HOST_ID, 10000);
    concurrentGarageWrite(env);
    const first = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID });
    expect(first.ok).toBe(false);
    const rebuy = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID });
    expect(rebuy.ok).toBe(true);
    expect(balance(env, HOST_ID)).toEqual({ coins: 10000 - 1500, gems: 0 });
    expect(garageValue(env, HOST_ID).cosmeticsBag).toContain('paint_matte_black');
  });

  it('ten store_buy calls racing on the same offer charge once', () => {
    setCoins(env, HOST_ID, 10000);
    // Each call's commit is preceded by the next call (all ten read the
    // same garage and balance before any of them commits).
    let depth = 0;
    const answers: Array<Resp<{ newBalance: { coins: number } }>> = [];
    wrap(env, 'multiUpdate', (original) => (...args: unknown[]) => {
      const writes = (args[1] as Array<{ collection: string }> | undefined) ?? [];
      if (writes.some((w) => w.collection === 'garage') && depth < 9) {
        depth += 1;
        answers.push(call(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID }));
      }
      return original(...args);
    });
    answers.push(call(env, 'store_buy', HOST_ID, { offerId: 'perm_paint_matte_black', callerUserId: HOST_ID }));
    expect(answers).toHaveLength(10);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(balance(env, HOST_ID)).toEqual({ coins: 10000 - 1500, gems: 0 });
    const ledger = (env.fakeNakama.ledger.get(HOST_ID) ?? []).filter((l) => (l['changeset'] as Record<string, number>)['coins'] === -1500);
    expect(ledger).toHaveLength(1);
  });

  it('pass_buy_premium whose flag write keeps failing is refunded, and the retry charges again', () => {
    setCoins(env, HOST_ID, 0, 5000);
    call<Resp<unknown>>(env, 'pass_get', HOST_ID, { callerUserId: HOST_ID });
    let failures = 3;
    const restore = wrap(env, 'storageWrite', (original) => (...args: unknown[]) => {
      const objs = (args[0] as Array<{ collection: string }> | undefined) ?? [];
      if (failures > 0 && objs.some((o) => o.collection === 'pass')) {
        failures -= 1;
        throw new Error('Storage write rejected - version check failed.');
      }
      return original(...args);
    });
    const r = call<Resp<unknown>>(env, 'pass_buy_premium', HOST_ID, { callerUserId: HOST_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    expect(balance(env, HOST_ID)).toEqual({ coins: 0, gems: 5000 });
    restore();

    const retry = call<Resp<{ priceGems: number; premiumPurchased: boolean }>>(env, 'pass_buy_premium', HOST_ID, { callerUserId: HOST_ID });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.premiumPurchased).toBe(true);
    expect(balance(env, HOST_ID)).toEqual({ coins: 0, gems: 5000 - retry.data.priceGems });
  });
});
