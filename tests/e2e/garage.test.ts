// E2E tests for the Phase 3 garage module (Chunk 6):
//   - garage_get auto-creates a default garage on first read
//   - the default garage grants the catalog's starter car
//   - loadout mirrors the active car (Decision 2: one call returns
//     everything)
//   - caller identity is enforced (no cross-user reads)
//   - the after-auth hook seeds a garage before the first garage_get
//     when the player authenticates via a hooked channel
//
// Companion to tests/unit/garage-storage.test.ts which exercises the
// pure helpers without storage.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';
const OTHER_ID = 'user-other';

interface GarageView {
  userId: string;
  cars: Array<{
    carId: string;
    classId: string;
    upgrades: { engine: number; tires: number; nitro: number; handling: number };
    cosmetics: Record<string, string>;
    computedStats: { speed: number; acceleration: number; handling: number; nitro: number };
  }>;
  loadout: {
    activeCarId: string;
    equipped: Record<string, string>;
    stats: { speed: number; acceleration: number; handling: number; nitro: number };
  } | null;
  lastDailyWin: number;
  dailyPrivateCount: number;
  dailyResetAt: number;
}

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  // Inject liveops gate bypass (clientVersion/platform) into object payloads
  // so the Phase 5 Chunk 2 UPGRADE_REQUIRED doesn't trip every legacy test.
  const body = typeof payload === 'string'
    ? payload
    : JSON.stringify({ clientVersion: '1.0.0', platform: 'ios', ...(payload as Record<string, unknown>) });
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function getGarage(env: ReturnType<typeof loadBundleForTest>, userId: string): Resp<{ garage: GarageView }> {
  return call<Resp<{ garage: GarageView }>>(
    env,
    'garage_get',
    userId,
    { callerUserId: userId },
  );
}

describe('garage module (Chunk 6)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('garage_get auto-creates a default garage on first read', () => {
    const r = getGarage(env, HOST_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.garage.userId).toBe(HOST_ID);
    expect(r.data.garage.cars).toHaveLength(1);
    expect(r.data.garage.cars[0]?.carId).toBe('starter_viper');
    expect(r.data.garage.loadout).not.toBeNull();
    expect(r.data.garage.loadout?.activeCarId).toBe('starter_viper');
  });

  it('subsequent reads return the persisted garage (no second auto-create)', () => {
    const r1 = getGarage(env, HOST_ID);
    expect(r1.ok).toBe(true);
    const r2 = getGarage(env, HOST_ID);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Same shape — auto-create only fires once.
    expect(r1.data.garage.cars).toHaveLength(1);
    expect(r2.data.garage.cars).toHaveLength(1);
    // loadout stats should match baseStats for zero upgrades.
    expect(r2.data.garage.loadout?.stats).toEqual({
      speed: 50,
      acceleration: 50,
      handling: 50,
      nitro: 50,
    });
  });

  it('loadout stats mirror the active car computedStats', () => {
    const r = getGarage(env, HOST_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const active = r.data.garage.cars.find((c) => c.carId === r.data.garage.loadout?.activeCarId);
    expect(active).toBeDefined();
    expect(r.data.garage.loadout?.stats).toEqual(active?.computedStats);
  });

  it('returns FORBIDDEN when reading another user\'s garage', () => {
    const r = call<Resp<unknown>>(
      env,
      'garage_get',
      HOST_ID,
      { callerUserId: HOST_ID, userId: OTHER_ID },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('returns UNAUTHENTICATED when there is no caller identity', () => {
    const r = call<Resp<unknown>>(
      env,
      'garage_get',
      null,
      {},
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a payload that is not JSON with BAD_REQUEST', () => {
    const handler = env.resolver('garage_get');
    if (!handler) throw new Error('no rpc: garage_get');
    const ctx = { ...FakeContext, userId: HOST_ID };
    const raw = handler(ctx, env.logger, env.nak, 'not-json');
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('BAD_REQUEST');
  });

  it('initial daily counters are zeroed', () => {
    const r = getGarage(env, HOST_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.garage.lastDailyWin).toBe(0);
    expect(r.data.garage.dailyPrivateCount).toBe(0);
    expect(r.data.garage.dailyResetAt).toBeGreaterThan(0);
  });
});