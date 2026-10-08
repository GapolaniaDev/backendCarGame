// Phase 8 Chunk 6 — Tournament lifecycle e2e tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type { RaceSubmitResultOutput } from '../../modules/src/race/types';
import { TOURNAMENT_LEADERBOARD_SYSTEM_USER } from '../../modules/src/tournaments/leaderboard';

const HOST = 'user-host';
const P1 = 'user-p1';
const P2 = 'user-p2';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body) as string) as Resp<T>;
}

async function waitFor<T>(
  fetch: () => T | undefined,
  pred: (t: T) => boolean,
  timeoutMs = 1000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fetch();
    if (v !== undefined && pred(v)) return v;
    await new Promise((r) => setImmediate(r));
  }
  return fetch();
}

function seedProfile(env: ReturnType<typeof loadBundleForTest>, userId: string, level: number): void {
  const profile = {
    schemaVersion: 1,
    userId,
    displayName: `user-${userId}`,
    avatarUrl: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    progression: { xp: 0, level, lastDailyWinAt: 0 },
  };
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles', key: userId, userId,
    value: profile as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

function setupSession(env: ReturnType<typeof loadBundleForTest>, size: 2 | 4 | 6 = 2, trackId = 'neon_blvd'): string {
  const create = call<{ sessionId: string }>(env, 'race_session_create', null, {
    matchId: 'm-t-' + Math.random().toString(36).slice(2, 8),
    mode: 'quick',
    trackId,
    size,
    hostLoadout: { classId: 'B', bodyId: 'coupe' },
    hostUserId: HOST,
  });
  if (!create.ok) throw new Error(`create failed: ${JSON.stringify(create)}`);
  const sid = create.data.sessionId;
  for (const userId of [P1, P2].slice(0, size - 1)) {
    const j = call<unknown>(env, 'race_session_join', null, {
      sessionId: sid,
      userId,
      callerUserId: userId,
      loadout: { classId: 'B', bodyId: 'coupe' },
    });
    if (!j.ok) throw new Error(`join ${userId} failed: ${JSON.stringify(j)}`);
  }
  const s = call<unknown>(env, 'race_session_start', HOST, {
    sessionId: sid,
    callerUserId: HOST,
  });
  if (!s.ok) throw new Error('start failed: ' + JSON.stringify(s));
  // Backdate startedAt so submit (with default 120_000 ms) passes clock.
  const obj = env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`);
  if (obj) {
    const sess = obj.value as { startedAt: number; results: unknown[]; state: string; version: number };
    sess.startedAt = Date.now() - 300_000;
    env.fakeNakama.store.set(`race_sessions/${sid}/${SYSTEM_USER_ID}`, {
      ...obj,
      value: sess as unknown as Record<string, unknown>,
    });
  }
  return sid;
}

function submit(
  env: ReturnType<typeof loadBundleForTest>,
  sid: string,
  userId: string,
  totalMs: number,
  tournamentId?: string,
  laps: number[] = [40_000, 40_000, totalMs - 80_000],
): Resp<RaceSubmitResultOutput> {
  return call<RaceSubmitResultOutput>(env, 'race_submit_result', userId, {
    sessionId: sid,
    callerUserId: userId,
    report: {
      userId,
      totalMs,
      laps,
      isBotReport: false,
    },
    ...(tournamentId !== undefined ? { tournamentId } : {}),
  });
}

describe('tournaments lifecycle e2e (Phase 8 Chunk 6)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('happy path: race_submit_result with tournamentId updates entry + leaderboard', async () => {
    const list = call<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number; maxAttempts: number; trackId: string }> }>(
      env, 'tournament_list', HOST, { status: 'open' },
    );
    if (!list.ok) throw new Error('list failed: ' + JSON.stringify(list.error));
    const target = list.data.tournaments.find((t) => t.entryFee === 0 && t.minLevel <= 10 && t.maxAttempts >= 3);
    if (!target) throw new Error('no suitable free tournament in catalog');
    const tid = target.id;
    const trackId = target.trackId;

    // Seed profiles + wallets.
    seedProfile(env, HOST, target.minLevel + 1);
    seedProfile(env, P1, target.minLevel + 1);
    for (const u of [HOST, P1]) {
      const w = env.fakeNakama.wallets.get(u);
      env.fakeNakama.wallets.set(u, { coins: 1000, gems: 0, ...(w ?? {}) });
      const j = call<unknown>(env, 'tournament_join', u, { tournamentId: tid });
      if (!j.ok) throw new Error(`join ${u} failed: ` + JSON.stringify(j));
    }
    const sid = setupSession(env, 2, trackId);
    // 4 laps × 45_000 = 180_000 min total for mountain_pass class B.
    expect(submit(env, sid, HOST, 200_000, tid, [50_000, 50_000, 50_000, 50_000]).ok).toBe(true);
    expect(submit(env, sid, P1, 220_000, tid, [55_000, 55_000, 55_000, 55_000]).ok).toBe(true);

    const lbKey = `tournament_leaderboard/${tid}/${TOURNAMENT_LEADERBOARD_SYSTEM_USER}`;
    const lb = await waitFor(
      () => env.fakeNakama.store.get(lbKey),
      (v) => (v.value as { entries: unknown[] }).entries.length === 2,
    );
    const entries = (lb?.value as { entries: Array<{ userId: string; bestTimeMs: number }> }).entries;
    expect(entries.map((e) => e.userId)).toEqual([HOST, P1]);
  });

  it('multiple attempts: bestTimeMs is the minimum', async () => {
    const list = call<{ tournaments: Array<{ id: string; entryFee: number; minLevel: number; maxAttempts: number; trackId: string }> }>(
      env, 'tournament_list', HOST, { status: 'open' },
    );
    if (!list.ok) throw new Error('list failed: ' + JSON.stringify(list.error));
    const target = list.data.tournaments.find((t) => t.entryFee === 0 && t.minLevel <= 10 && t.maxAttempts >= 3);
    if (!target) throw new Error('no suitable tournament');
    const tid = target.id;
    const trackId = target.trackId;
    seedProfile(env, HOST, target.minLevel + 1);
    env.fakeNakama.wallets.set(HOST, { coins: 1000, gems: 0 });
    expect(call<unknown>(env, 'tournament_join', HOST, { tournamentId: tid }).ok).toBe(true);

    // 3 separate sessions, each with HOST + P1 in a size=2 race.
    for (const totalMs of [200_000, 190_000, 210_000]) {
      const sid = setupSession(env, 2, trackId);
      const laps = [totalMs / 4, totalMs / 4, totalMs / 4, totalMs / 4];
      const r1 = submit(env, sid, HOST, totalMs, tid, laps);
      if (!r1.ok) throw new Error('host submit failed: ' + JSON.stringify(r1));
      const p1Laps = [60_000, 60_000, 60_000, 60_000];
      const r2 = submit(env, sid, P1, 240_000, undefined, p1Laps);
      if (!r2.ok) throw new Error('p1 submit failed: ' + JSON.stringify(r2));
    }
    const lbKey = `tournament_leaderboard/${tid}/${TOURNAMENT_LEADERBOARD_SYSTEM_USER}`;
    const lb = await waitFor(
      () => env.fakeNakama.store.get(lbKey),
      (v) => (v.value as { entries: Array<{ bestTimeMs: number }> }).entries[0]?.bestTimeMs === 190_000,
    );
    expect((lb?.value as { entries: Array<{ bestTimeMs: number }> }).entries[0]?.bestTimeMs).toBe(190_000);
  });
});
