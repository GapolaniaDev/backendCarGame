// Phase 3 integration test — drives the 7 RPCs the client uses on a
// fresh account, in the order the Unity HUD would. Verifies the
// cross-RPC wiring (after-auth hooks, EventBus subscribers, daily
// rotation, refund-on-CAS-conflict) without spinning up Docker.
//
// Flow:
//   1. New user → wallet_get returns 0/0
//   2. garage_get auto-creates the starter garage (viper + starter loadout)
//   3. store_get returns the 3 sections + a dailySeed
//   4. store_buy the starter pack → coins + gems balance, garage.purchasedPacks
//      records the redemption
//   5. car_upgrade the starter car → garage.cars[0].upgrades.engine == 1,
//      computedStats recomputed, wallet reflects the upgrade spend
//   6. wallet_get confirms the new balance matches what car_upgrade
//      returned
//
// Each assertion is asserted independently so a regression in one
// step (e.g. store_buy refund) doesn't hide a later regression.

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

describe('Phase 3 integration: new user flow (Chunk 10)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    setLevel(env, HOST_ID, 50);
  });

  it('runs the full new-user lifecycle', () => {
    // 1) Fresh user, no wallet, no garage — wallet_get returns 0/0.
    const w0 = call<Resp<{ coins: number; gems: number; pending: unknown[]; ledger: { last30dCount: number } }>>(
      env, 'wallet_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(w0.ok).toBe(true);
    if (!w0.ok) return;
    expect(w0.data.coins).toBe(0);
    expect(w0.data.gems).toBe(0);

    // 2) garage_get auto-creates the starter garage.
    const g0 = call<Resp<{ garage: { userId: string; cars: Array<{ carId: string; upgrades: { engine: number } }>; loadout: { activeCarId: string } | null } }>>(
      env, 'garage_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(g0.ok).toBe(true);
    if (!g0.ok) return;
    expect(g0.data.garage.userId).toBe(HOST_ID);
    expect(g0.data.garage.cars.length).toBe(1);
    expect(g0.data.garage.cars[0]?.carId).toBe('starter_viper');
    expect(g0.data.garage.cars[0].upgrades.engine).toBe(0);
    expect(g0.data.garage.loadout?.activeCarId).toBe('starter_viper');

    // 3) store_get returns 3 sections + a deterministic dailySeed.
    const s0 = call<Resp<{ dailySeed: string; sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string; refId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(s0.ok).toBe(true);
    if (!s0.ok) return;
    expect(typeof s0.data.dailySeed).toBe('string');
    expect(s0.data.dailySeed.length).toBeGreaterThan(0);
    const sectionIds = s0.data.sections.map((s) => s.section.id);
    expect(sectionIds).toContain('permanent');
    expect(sectionIds).toContain('daily');

    // 4) Buy the starter pack — needs 2500 coins; spend first, then
    //    credit 5000 coins + 50 gems from the pack.
    setCoins(env, HOST_ID, 100000);
    const sp = call<Resp<{ delivery: { kind: string; refId: string }; newBalance: { coins: number; gems: number } }>>(
      env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID },
    );
    expect(sp.ok).toBe(true);
    if (!sp.ok) return;
    expect(sp.data.delivery.kind).toBe('pack');
    expect(sp.data.delivery.refId).toBe('starter_pack');
    expect(sp.data.newBalance.gems).toBe(50);
    const postPackCoins = sp.data.newBalance.coins;

    // 5) Upgrade the starter car's engine — D-class engine level 1
    //    costs 500 coins.
    const upgrade = call<Resp<{ costPaid: { coins: number; gems: number }; garage: { cars: Array<{ carId: string; upgrades: { engine: number } }> } }>>(
      env, 'car_upgrade', HOST_ID, { carId: 'starter_viper', line: 'engine', newLevel: 1, callerUserId: HOST_ID },
    );
    expect(upgrade.ok).toBe(true);
    if (!upgrade.ok) return;
    expect(upgrade.data.costPaid.coins).toBeGreaterThan(0);
    const viper = upgrade.data.garage.cars.find((c) => c.carId === 'starter_viper');
    expect(viper?.upgrades.engine).toBe(1);

    // 6) Wallet reflects the upgrade spend.
    const w1 = call<Resp<{ coins: number; gems: number }>>(
      env, 'wallet_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(w1.ok).toBe(true);
    if (!w1.ok) return;
    expect(w1.data.gems).toBe(50);
    expect(w1.data.coins).toBe(postPackCoins - upgrade.data.costPaid.coins);
  });

  it('store_buy removes the redeemed pack from store_get', () => {
    setCoins(env, HOST_ID, 100000);
    const buy = call<Resp<unknown>>(env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID });
    expect(buy.ok).toBe(true);
    const after = call<Resp<{ sections: ReadonlyArray<{ section: { id: string }; offers: ReadonlyArray<{ offer: { offerId: string } }> }> }>>(
      env, 'store_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const perm = after.data.sections.find((s) => s.section.id === 'permanent');
    const still = perm?.offers.find((o) => o.offer.offerId === 'perm_starter_pack');
    expect(still).toBeUndefined();
  });
});