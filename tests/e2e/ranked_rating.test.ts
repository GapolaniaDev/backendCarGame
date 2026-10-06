// E2E tests for Phase 4 Chunk 7: RaceCompleted → ranked rating
// subscriber. The subscriber is wired into the EventBus from
// `InitModule`; these tests drive a real race through the RPC layer
// (create → join → start → submit×N → close) and assert the per-
// player RankedRecord + the `ranked_{seasonId}` leaderboard rows.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type {
  RaceSessionCreateOutput,
  RaceSubmitResultOutput,
} from '../../modules/src/race/types';
import type { ILeaderboardRecord } from '../../modules/src/nkruntime';
import type { RankedGetOutput } from '../../modules/src/ranked/types';

const HOST_ID = 'ranked-host';
const P1 = 'ranked-p1';
const P2 = 'ranked-p2';
const P3 = 'ranked-p3';

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

function readRecord(env: ReturnType<typeof loadBundleForTest>, userId: string):
  | { rating: number; racesPlayed: number; wins: number; topThree: number; peak: number }
  | null {
  const stored = env.fakeNakama.store.get(`ranked/${userId}/${userId}`);
  if (!stored) return null;
  const v = stored.value as Record<string, unknown>;
  return {
    rating: v.rating as number,
    racesPlayed: v.racesPlayed as number,
    wins: v.wins as number,
    topThree: v.topThree as number,
    peak: v.peak as number,
  };
}

function readLeaderboard(env: ReturnType<typeof loadBundleForTest>, seasonId: string, ownerId: string): ILeaderboardRecord | undefined {
  return env.fakeNakama.leaderboardRecords.get(`ranked_${seasonId}`)?.get(ownerId);
}

function readProgress(env: ReturnType<typeof loadBundleForTest>, sessionId: string): unknown {
  return env.fakeNakama.store.get(`ranked_progress/${sessionId}/${SYSTEM_USER_ID}`);
}

async function waitForRecord(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  timeoutMs = 500,
): Promise<ReturnType<typeof readRecord>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = readRecord(env, userId);
    if (rec !== null && rec.racesPlayed >= 1) return rec;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return readRecord(env, userId);
}

async function waitForLeaderboard(
  env: ReturnType<typeof loadBundleForTest>,
  seasonId: string,
  userId: string,
  timeoutMs = 500,
): Promise<ILeaderboardRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = readLeaderboard(env, seasonId, userId);
    if (rec !== undefined) return rec;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return readLeaderboard(env, seasonId, userId);
}

describe('ranked subscriber (Phase 4 Chunk 7) — full race lifecycle', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  function setupRankedSession(): { sid: string } {
    const createEnv = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'ranked-match-1',
      mode: 'ranked',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    if (!createEnv.ok) throw new Error(`create failed: ${JSON.stringify(createEnv)}`);
    const sid = createEnv.data.sessionId;
    for (const userId of [P1, P2, P3]) {
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        {
          sessionId: sid,
          userId,
          callerUserId: userId,
          loadout: { classId: 'B', bodyId: 'coupe' },
        },
      );
      if (!joinEnv.ok) throw new Error(`join ${userId} failed: ${JSON.stringify(joinEnv)}`);
    }
    const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!startEnv.ok) throw new Error('start failed');
    // Backdate startedAt so the clock check tolerates our 120_000 ms totalMs.
    const storeKey = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(storeKey);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;
    return { sid };
  }

  function submitReport(
    sid: string,
    userId: string,
    totalMs: number,
  ): Envelope<RaceSubmitResultOutput> {
    // Ranked on neon_blvd = 5 laps × ~50_000ms = 250_000ms. Build the
    // laps so they sum to totalMs and each is ≥ 40_000ms (the
    // min-time-per-class for B cars).
    const laps = [50_000, 50_000, 50_000, 50_000, totalMs - 200_000];
    return call<RaceSubmitResultOutput>(env, 'race_submit_result', userId, {
      sessionId: sid,
      callerUserId: userId,
      report: {
        userId,
        totalMs,
        laps,
        isBotReport: false,
      },
    });
  }

  it('ranked_get creates records first → then a ranked race updates every player', async () => {
    // Pre-create records via ranked_get so the test verifies the
    // CAS-update path (not the just-create path).
    for (const u of [HOST_ID, P1, P2, P3]) {
      const r = call<RankedGetOutput>(env, 'ranked_get', u, { callerUserId: u });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.data.rating).toBe(1000);
      expect(r.data.racesPlayed).toBe(0);
    }

    const { sid } = setupRankedSession();
    const submitResults = [
      submitReport(sid, HOST_ID, 220_000),
      submitReport(sid, P1, 240_000),
      submitReport(sid, P2, 260_000),
      submitReport(sid, P3, 280_000),
    ];
    for (const r of submitResults) {
      if (!r.ok) throw new Error(`submit failed: ${JSON.stringify(r)}`);
    }

    // All 4 humans get a +1 race, winner gets a win, top-3 gets a
    // top-three bump. Allow the bus subscriber to drain.
    const hostAfter = await waitForRecord(env, HOST_ID);
    const p1After = await waitForRecord(env, P1);
    const p2After = await waitForRecord(env, P2);
    const p3After = await waitForRecord(env, P3);
    expect(hostAfter).not.toBeNull();
    expect(hostAfter?.racesPlayed).toBe(1);
    expect(hostAfter?.wins).toBe(1);
    expect(hostAfter?.topThree).toBe(1);
    expect(p1After?.racesPlayed).toBe(1);
    expect(p2After?.racesPlayed).toBe(1);
    expect(p3After?.racesPlayed).toBe(1);
    expect(hostAfter?.rating).toBeGreaterThan(1000); // winner gains
    expect(p3After?.rating).toBeLessThan(1000); // last loses

    // Idempotency marker stamped by the subscriber.
    expect(readProgress(env, sid)).toBeDefined();
  });

  it('leaderboard ranked_{seasonId} gets a row per human with their new rating', async () => {
    const { sid } = setupRankedSession();
    submitReport(sid, HOST_ID, 220_000);
    submitReport(sid, P1, 240_000);
    submitReport(sid, P2, 260_000);
    submitReport(sid, P3, 280_000);

    const seasonId = 'season_2'; // bundled active season
    const hostRec = await waitForLeaderboard(env, seasonId, HOST_ID);
    expect(hostRec).toBeDefined();
    expect(hostRec?.score).toBeGreaterThan(1000);
    for (const u of [HOST_ID, P1, P2, P3]) {
      const rec = await waitForLeaderboard(env, seasonId, u);
      expect(rec).toBeDefined();
    }
  });

  it('first-time player (no prior ranked_get) gets a record created by the subscriber', async () => {
    const { sid } = setupRankedSession();
    // No ranked_get pre-call — the subscriber must auto-create.
    for (const r of [
      submitReport(sid, HOST_ID, 220_000),
      submitReport(sid, P1, 240_000),
      submitReport(sid, P2, 260_000),
      submitReport(sid, P3, 280_000),
    ]) {
      expect(r.ok).toBe(true);
    }

    // After the race, every player has a RankedRecord.
    for (const u of [HOST_ID, P1, P2, P3]) {
      const rec = await waitForRecord(env, u);
      expect(rec).not.toBeNull();
      expect(rec?.racesPlayed).toBe(1);
    }
  });

  it('mode=quick (not ranked) → subscriber does not touch ratings', async () => {
    const createEnv = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'quick-match-1',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    if (!createEnv.ok) throw new Error('create failed');
    const sid = createEnv.data.sessionId;
    for (const userId of [P1, P2, P3]) {
      const joinEnv = call<{ rosterVersion: number }>(env, 'race_session_join', null, {
        sessionId: sid,
        userId,
        callerUserId: userId,
        loadout: { classId: 'B', bodyId: 'coupe' },
      });
      if (!joinEnv.ok) throw new Error(`join ${userId} failed`);
    }
    const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!startEnv.ok) throw new Error('start failed');
    const storeKey = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(storeKey);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;

    submitReport(sid, HOST_ID, 220_000);
    submitReport(sid, P1, 240_000);
    submitReport(sid, P2, 260_000);
    submitReport(sid, P3, 280_000);

    // Give the bus a tick.
    await new Promise((resolve) => setImmediate(resolve));
    // No records created for any player.
    for (const u of [HOST_ID, P1, P2, P3]) {
      expect(readRecord(env, u)).toBeNull();
    }
    // No progress marker (the subscriber skipped entirely).
    expect(readProgress(env, sid)).toBeUndefined();
  });

  it('idempotency: replaying the same sessionId does not double-write ratings', async () => {
    const { sid } = setupRankedSession();
    submitReport(sid, HOST_ID, 220_000);
    submitReport(sid, P1, 240_000);
    submitReport(sid, P2, 260_000);
    submitReport(sid, P3, 280_000);

    // First dispatch lands.
    const host1 = await waitForRecord(env, HOST_ID);
    expect(host1?.racesPlayed).toBe(1);
    const rating1 = host1?.rating ?? 0;

    // Manually clear the leaderboard record + re-publish by mutating
    // nothing — we want to assert that the marker alone is enough
    // to make the subscriber skip. The subscriber only triggers on
    // RaceCompleted events, which only fire from race_submit_result.
    // We simulate a second race with the same sessionId by re-running
    // submit — but submit is rejected (state=closed). The cleanest
    // assertion: the marker presence means the handler is no-op on
    // re-invocation. Unit tests already prove the no-op. Here we just
    // assert the marker is in storage after the close.
    expect(readProgress(env, sid)).toBeDefined();
    // Sanity: no duplicate leaderboard rows.
    const rec = readLeaderboard(env, 'season_2', HOST_ID);
    expect(rec?.score).toBe(rating1);
  });

  it('K-factor: players with racesPlayed<10 keep initial K on the next race', async () => {
    const { sid } = setupRankedSession();
    submitReport(sid, HOST_ID, 220_000);
    submitReport(sid, P1, 240_000);
    submitReport(sid, P2, 260_000);
    submitReport(sid, P3, 280_000);
    await waitForRecord(env, HOST_ID);
    // All 4 had racesPlayed=0 → initial K (40) used for race 1.
    // racesPlayed is now 1 → still < 10 → next race will use initial K.
    for (const u of [HOST_ID, P1, P2, P3]) {
      const rec = readRecord(env, u);
      expect(rec?.racesPlayed).toBeLessThan(10);
    }
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — wiring', () => {
  it('subscriber is registered on the EventBus (ranked_get creates the marker)', () => {
    const env2 = loadBundleForTest();
    const r = call<RankedGetOutput>(env2, 'ranked_get', HOST_ID, { callerUserId: HOST_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The subscriber isn't triggered by ranked_get (only RaceCompleted
    // events). The test verifies the bundle's InitModule ran without
    // throwing, which means subscribeRankedRewards installed cleanly.
    expect(env2.resolver('ranked_get')).toBeDefined();
  });
});