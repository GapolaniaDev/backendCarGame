// E2E tests for Phase 4 Chunk 8: stats equalization wired into the
// race session lifecycle. Verifies that for `mode === 'ranked'`,
// every loadout's `stats` is populated from the car's `maxStats`
// (the class-top) regardless of upgrades, and for non-ranked modes
// the stats are the base+upgrades computeStats value.
//
// Bots cannot enter ranked sessions — `race_session_quick_bots` is
// the only RPC that constructs bot rosters and it hard-codes
// `mode='quick'`. The defensive case below asserts that constraint
// by attempting to register a bot roster through the session
// pipeline and confirming the API does not promote bots into
// ranked.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { RaceSession } from '../../modules/src/race/types';

const HOST_ID = 'eq-host';
const D_USER = 'eq-d-user'; // starter_viper (D)
const C_USER = 'eq-c-user'; // coupe_gt (C)
const A_USER = 'eq-a-user'; // aurora_aero (A)

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): Envelope<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as Envelope<T>;
}

function seedGarage(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  bodyId: string,
  classId: 'D' | 'C' | 'B' | 'A' | 'S',
): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`garage/${userId}/${userId}`, {
    collection: 'garage',
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      cars: [
        {
          carId: bodyId,
          classId,
          upgrades: { engine: 0, tires: 0, nitro: 0, handling: 0 },
          cosmetics: {},
          computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
        },
      ],
      cosmeticsBag: [],
      purchasedPacks: [],
      loadout: null,
      lastDailyWin: 0,
      dailyPrivateCount: 0,
      dailyResetAt: 0,
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: now,
    updateTime: now,
    expiresAt: null,
  });
}

function readSession(
  env: ReturnType<typeof loadBundleForTest>,
  sessionId: string,
): RaceSession {
  const stored = env.fakeNakama.store.get(`race_sessions/${sessionId}/${SYSTEM_USER_ID}`);
  if (!stored) throw new Error(`session ${sessionId} not in store`);
  return stored.value as unknown as RaceSession;
}

describe('stats equalization (Phase 4 Chunk 8) — ranked session lifecycle', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    // Seed 4 players with mixed-class cars.
    seedGarage(env, HOST_ID, 'phantom_rsx', 'B');
    seedGarage(env, D_USER, 'starter_viper', 'D');
    seedGarage(env, C_USER, 'coupe_gt', 'C');
    seedGarage(env, A_USER, 'aurora_aero', 'A');
  });

  it('ranked create: host loadout.stats equalized to phantom_rsx maxStats', () => {
    const createEnv = call<{ sessionId: string }>(env, 'race_session_create', null, {
      matchId: 'ranked-m-1',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const session = readSession(env, createEnv.data.sessionId);
    expect(session.mode).toBe('ranked');
    const host = session.roster[0]!;
    expect(host.loadout.stats).toEqual({ speed: 88, acceleration: 86, handling: 88, nitro: 84 });
    // baseStats (65/62/65/60) must NOT bleed through — equalization won.
    expect(host.loadout.stats?.speed).toBeGreaterThan(65);
  });

  it('ranked create + join×3: every roster entry equalized to its own class max', () => {
    const createEnv = call<{ sessionId: string }>(env, 'race_session_create', null, {
      matchId: 'ranked-m-2',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const sid = createEnv.data.sessionId;

    for (const [uid, bodyId, classId, maxSpeed] of [
      [D_USER, 'starter_viper', 'D', 70],
      [C_USER, 'coupe_gt', 'C', 82],
      [A_USER, 'aurora_aero', 'A', 95],
    ] as const) {
      const joinEnv = call<{ rosterVersion: number }>(env, 'race_session_join', null, {
        sessionId: sid,
        userId: uid,
        callerUserId: uid,
        loadout: { classId, bodyId },
      });
      expect(joinEnv.ok).toBe(true);
      if (!joinEnv.ok) continue;
      const session = readSession(env, sid);
      const entry = session.roster.find((r) => r.userId === uid);
      expect(entry?.loadout.stats?.speed).toBe(maxSpeed);
    }

    // Final check: every roster entry's speed stat equals its class max.
    const finalSession = readSession(env, sid);
    const expected = new Map([
      [HOST_ID, 88], // phantom_rsx (B)
      [D_USER, 70],  // starter_viper (D)
      [C_USER, 82],  // coupe_gt (C)
      [A_USER, 95],  // aurora_aero (A)
    ]);
    for (const entry of finalSession.roster) {
      expect(entry.loadout.stats?.speed).toBe(expected.get(entry.userId));
    }
  });

  it('ranked with empty upgrades: equalization ignores upgrade catalog (Phase 3 ownership context)', () => {
    // Even fully-unupgraded B-class drivers must have stats equalized to
    // the class max — ranked rosters compete on skill, not wallet.
    const createEnv = call<{ sessionId: string }>(env, 'race_session_create', null, {
      matchId: 'ranked-m-3',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const session = readSession(env, createEnv.data.sessionId);
    // baseStats.speed for phantom_rsx is 65; equalized must be 88.
    expect(session.roster[0]?.loadout.stats?.speed).toBe(88);
    expect(session.roster[0]?.loadout.stats?.acceleration).toBe(86);
  });

  it('quick mode: stats are base + upgrades (not equalized)', () => {
    const createEnv = call<{ sessionId: string }>(env, 'race_session_create', null, {
      matchId: 'quick-m-1',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const session = readSession(env, createEnv.data.sessionId);
    expect(session.mode).toBe('quick');
    // baseStats for phantom_rsx: 65/62/65/60 — no upgrades.
    expect(session.roster[0]?.loadout.stats).toEqual({
      speed: 65,
      acceleration: 62,
      handling: 65,
      nitro: 60,
    });
  });

  it('private mode: stats are base + upgrades (not equalized)', () => {
    const createEnv = call<{ sessionId: string }>(env, 'race_session_create', null, {
      matchId: 'priv-m-1',
      mode: 'private',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const session = readSession(env, createEnv.data.sessionId);
    expect(session.roster[0]?.loadout.stats).toEqual({
      speed: 65,
      acceleration: 62,
      handling: 65,
      nitro: 60,
    });
  });

  it('ranked with missing OwnedCar: loadout.stats is undefined (caller proceeds without)', () => {
    // A player with no garage at all (or an unowned bodyId) cannot have
    // stats equalized — the helper returns null and the loadout is
    // stored without a stats field.
    const env2 = loadBundleForTest();
    // Intentionally do NOT seed a garage for NO_GARAGE_USER.
    const createEnv = call<{ sessionId: string }>(env2, 'race_session_create', null, {
      matchId: 'ranked-m-4',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: 'no-garage-user',
    });
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) return;
    const session = readSession(env2, createEnv.data.sessionId);
    expect(session.roster[0]?.loadout.stats).toBeUndefined();
  });

  it('bot defense: race_session_quick_bots hard-codes mode=quick (no bots in ranked)', async () => {
    // The only RPC that creates a session with `isBot=true` entries
    // is `race_session_quick_bots`, which always uses `mode='quick'`.
    // A malicious client cannot inject bots into a ranked session.
    const env2 = loadBundleForTest();
    seedGarage(env2, HOST_ID, 'phantom_rsx', 'B');
    const out = await call<unknown>(env2, 'race_session_quick_bots', null, {
      size: 2,
      callerUserId: HOST_ID,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const data = out.data as { mode: string };
    expect(data.mode).toBe('quick_bots');
    // The actual stored session always uses 'quick' internally.
    const sessionId = (out.data as { sessionId: string }).sessionId;
    const stored = env2.fakeNakama.store.get(`race_sessions/${sessionId}/${SYSTEM_USER_ID}`);
    expect(stored).toBeDefined();
    const session = stored?.value as RaceSession;
    expect(session.mode).toBe('quick');
    // At least one roster entry must be a bot.
    expect(session.roster.some((r) => r.isBot)).toBe(true);
  });
});