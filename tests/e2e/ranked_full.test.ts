// E2E tests for Phase 4 Chunk 10: full ranked lifecycle integration.
// Covers the flow from a fresh bronze player through to a recorded
// rated race, season roll, and stats equalization across mixed-class
// rosters. Subscriber-driven rating changes are exercised in
// `rating_subscriber.test.ts`; this file focuses on the consumer-side
// path (ranked_get) and the storage invariants.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type { RankedGetOutput } from '../../modules/src/ranked/types';
import type { RaceSession } from '../../modules/src/race/types';

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
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

const HOST_ID = 'ranked-host';
const P1 = 'ranked-p1';
const P2 = 'ranked-p2';
const P3 = 'ranked-p3';

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

function readRanked(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
): Resp<RankedGetOutput> {
  return call(env, 'ranked_get', userId, { callerUserId: userId });
}

function readSeasonMeta(
  env: ReturnType<typeof loadBundleForTest>,
  seasonId: string,
): { status: string; rewardsDistributed: boolean } | null {
  const stored = env.fakeNakama.store.get(
    `ranked_seasons_meta/${seasonId}/${SYSTEM_USER_ID}`,
  );
  if (!stored) return null;
  const v = stored.value as { status: string; rewardsDistributed: boolean };
  return { status: v.status, rewardsDistributed: v.rewardsDistributed };
}

describe('ranked full lifecycle (Phase 4 Chunk 10)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
    seedGarage(env, HOST_ID, 'phantom_rsx', 'B');
    seedGarage(env, P1, 'coupe_gt', 'C');
    seedGarage(env, P2, 'aurora_aero', 'A');
    seedGarage(env, P3, 'starter_viper', 'D');
  });

  it('4 humans queue ranked → ranked_get returns bronze defaults for each', () => {
    for (const uid of [HOST_ID, P1, P2, P3]) {
      const r = readRanked(env, uid);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.data.rating).toBe(1000);
      expect(r.data.division).toBe('plata');
      expect(r.data.racesPlayed).toBe(0);
    }
  });

  it('stats equalization: ranked session with mixed classes every roster entry has class-max stats', () => {
    const create = call<Resp<{ sessionId: string }>>(env, 'race_session_create', null, {
      matchId: 'ranked-full-1',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'phantom_rsx' },
      hostUserId: HOST_ID,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const sid = create.data.sessionId;

    for (const [uid, bodyId, classId, expectedSpeed] of [
      [P1, 'coupe_gt', 'C', 82],
      [P2, 'aurora_aero', 'A', 95],
      [P3, 'starter_viper', 'D', 70],
    ] as const) {
      const join = call<Resp<{ rosterVersion: number }>>(env, 'race_session_join', null, {
        sessionId: sid,
        userId: uid,
        callerUserId: uid,
        loadout: { classId, bodyId },
      });
      expect(join.ok).toBe(true);
    }

    const stored = env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`);
    const session = stored?.value as RaceSession;
    for (const entry of session.roster) {
      const expected = {
        [HOST_ID]: 88, // phantom_rsx (B)
        [P1]: 82,      // coupe_gt (C)
        [P2]: 95,      // aurora_aero (A)
        [P3]: 70,      // starter_viper (D)
      } as const;
      expect(entry.loadout.stats?.speed).toBe(expected[entry.userId as keyof typeof expected]);
    }
  });

  it('season roll: lazy-close fires, new season created, racesPlayed=0, rating carried', () => {
    // The bundled `seasons.json` ships `season_2` active (Oct 2025 → Dec 2028).
    // Patch the meta with an already-expired `endsAt` so the next
    // `ranked_get` sees a stale season and runs the lazy close.
    const now = Date.now();
    const oldSeasonId = 'season_2';
    env.fakeNakama.store.set(
      `ranked_seasons_meta/${oldSeasonId}/${SYSTEM_USER_ID}`,
      {
        collection: 'ranked_seasons_meta',
        key: oldSeasonId,
        userId: SYSTEM_USER_ID,
        value: {
          schemaVersion: 1,
          seasonId: oldSeasonId,
          startedAt: now - 30 * 86_400_000,
          endsAt: now - 1,
          status: 'active',
          rewardsDistributed: false,
        },
        version: 'v00000001',
        permissionRead: 0,
        permissionWrite: 0,
        createTime: new Date(now).toISOString(),
        updateTime: new Date(now).toISOString(),
        expiresAt: null,
      },
    );
    // Pre-create the new season's leaderboard so the close can read
    // its standings (empty so no rewards).
    env.nak.leaderboardCreate(
      `ranked_season_${oldSeasonId}`,
      true,
      'asc',
      'best',
      '',
      {},
      true,
    );

    // Re-fetch — the lazy close fires and we get the new season.
    const after = readRanked(env, HOST_ID);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.seasonId).not.toBe(oldSeasonId);
    expect(after.data.racesPlayed).toBe(0);
    expect(after.data.rating).toBe(1000);

    // Old season flipped to closed.
    const closed = readSeasonMeta(env, oldSeasonId);
    expect(closed).not.toBeNull();
    expect(closed?.status).toBe('closed');
    expect(closed?.rewardsDistributed).toBe(true);

    // New season is active.
    const newMeta = readSeasonMeta(env, after.data.seasonId);
    expect(newMeta).not.toBeNull();
    expect(newMeta?.status).toBe('active');
  });

  it('ranked storage record is publicly readable (D11 — ownerRead perm 2)', () => {
    readRanked(env, HOST_ID);
    const stored = env.fakeNakama.store.get(`ranked/${HOST_ID}/${HOST_ID}`);
    expect(stored).toBeDefined();
    expect(stored?.permissionRead).toBe(2);
  });

  it('rate limit: 31 ranked_get calls in a window → RATE_LIMITED on 31st', () => {
    // Rate limit is 30/60s. 30 succeed, 31st fails.
    for (let i = 0; i < 30; i += 1) {
      const r = readRanked(env, 'rl-ranked');
      expect(r.ok).toBe(true);
    }
    const r31 = readRanked(env, 'rl-ranked');
    expect(r31.ok).toBe(false);
    if (r31.ok) return;
    expect(r31.error.code).toBe('RATE_LIMITED');
  });
});
