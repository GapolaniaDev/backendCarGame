// E2E tests for the Phase 2 RaceCompleted → leaderboard writer
// (subscribed via the in-process EventBus at InitModule). These run a
// full race lifecycle through the bundle: create → join → start →
// submit×N → close → assert the subscriber wrote the right records
// to the right tables.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type {
  RaceSubmitResultOutput,
  RaceSessionCreateOutput,
} from '../../modules/src/race/types';
import type { ILeaderboardRecord } from '../../modules/src/nkruntime';

const HOST_ID = 'user-host';
const P1 = 'user-p1';
const P2 = 'user-p2';
const P3 = 'user-p3';

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): { ok: true; data: T } | { ok: false; error: { code: string; message: string } } {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
}

describe('leaderboards RaceCompleted writer (Chunk 12)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  function setupFourPlayerSession(): { sid: string } {
    const createEnv = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'match-1',
      mode: 'quick',
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
      if (!joinEnv.ok) throw new Error(`join ${userId} failed`);
    }
    const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!startEnv.ok) throw new Error('start failed');
    // Backdate startedAt so the clock check tolerates our 120_000 ms
    // totalMs at default Date.now().
    const storeKey = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(storeKey);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;
    return { sid };
  }

  function submitReport(
    sid: string,
    userId: string,
    totalMs: number,
    opts: { isBot?: boolean } = {},
  ): { ok: true; data: RaceSubmitResultOutput } | { ok: false; error: { code: string; message: string } } {
    const caller = opts.isBot ? HOST_ID : userId;
    return call<RaceSubmitResultOutput>(env, 'race_submit_result', caller, {
      sessionId: sid,
      callerUserId: caller,
      report: {
        userId,
        totalMs,
        laps: [40_000, 40_000, totalMs - 80_000],
        isBotReport: opts.isBot ?? false,
      },
    });
  }

  function getRecord(tableId: string, ownerId: string): ILeaderboardRecord | undefined {
    return env.fakeNakama.leaderboardRecords.get(tableId)?.get(ownerId);
  }

  /**
   * The EventBus `publish` is fire-and-forget from `tryCloseAndPublish`,
   * which means the leaderboard-writer subscriber may not have run yet
   * when the last submit_result returns. Poll for a specific record
   * with a short timeout so the test stabilizes.
   */
  async function waitForRecord(
    tableId: string,
    ownerId: string,
    timeoutMs = 500,
  ): Promise<ILeaderboardRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rec = getRecord(tableId, ownerId);
      if (rec !== undefined) return rec;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return getRecord(tableId, ownerId);
  }

  it('writes tt_all / tt_week / lap_all records for every human finisher on quorum close', async () => {
    const { sid } = setupFourPlayerSession();
    for (const r of [
      submitReport(sid, HOST_ID, 120_000),
      submitReport(sid, P1, 130_000),
      submitReport(sid, P2, 140_000),
      submitReport(sid, P3, 150_000),
    ]) expect(r.ok).toBe(true);

    // Wait for the fire-and-forget leaderboard writer to land.
    const ttAll = await waitForRecord('tt_neon_blvd_B_all', HOST_ID);
    expect(ttAll).toBeDefined();
    expect(ttAll?.score).toBe(120_000);

    // tt_week for HOST
    expect(getRecord('tt_neon_blvd_B_week', HOST_ID)?.score).toBe(120_000);

    // lap_all for HOST (best lap = 40_000 ms)
    expect(getRecord('lap_neon_blvd_B_all', HOST_ID)?.score).toBe(40_000);

    // wins_week for HOST (rank-1 in quick mode, +1)
    await waitForRecord('wins_week', HOST_ID);
    expect(getRecord('wins_week', HOST_ID)?.score).toBe(1);

    // P1 (rank 2) does NOT win → wins_week not written for them.
    expect(getRecord('wins_week', P1)).toBeUndefined();

    // All 4 humans entered the time + lap tables.
    for (const u of [HOST_ID, P1, P2, P3]) {
      expect(getRecord('tt_neon_blvd_B_all', u)).toBeDefined();
      expect(getRecord('lap_neon_blvd_B_all', u)).toBeDefined();
    }
  });

  it('does not replace a better score (best operator is honored)', async () => {
    const { sid } = setupFourPlayerSession();
    submitReport(sid, HOST_ID, 120_000);
    submitReport(sid, P1, 130_000);
    submitReport(sid, P2, 140_000);
    submitReport(sid, P3, 150_000);
    await waitForRecord('tt_neon_blvd_B_all', HOST_ID);

    const before = getRecord('tt_neon_blvd_B_all', HOST_ID)?.score;
    expect(before).toBe(120_000);

    // Worse time attempt: should NOT replace the better score.
    env.nak.leaderboardRecordWrite(
      'tt_neon_blvd_B_all',
      HOST_ID,
      '',
      200_000,
      Date.now(),
      {},
      undefined,
    );
    expect(getRecord('tt_neon_blvd_B_all', HOST_ID)?.score).toBe(120_000);
  });

  it('increments wins_week only for the rank-1 finisher', async () => {
    const { sid } = setupFourPlayerSession();
    submitReport(sid, HOST_ID, 120_000);
    submitReport(sid, P1, 130_000);
    submitReport(sid, P2, 140_000);
    submitReport(sid, P3, 150_000);
    await waitForRecord('wins_week', HOST_ID);

    expect(getRecord('wins_week', HOST_ID)?.score).toBe(1);
    expect(getRecord('wins_week', P1)).toBeUndefined();
    expect(getRecord('wins_week', P2)).toBeUndefined();
    expect(getRecord('wins_week', P3)).toBeUndefined();
  });

  it('stamps every record with the server token + sessionId + confidence', async () => {
    const { sid } = setupFourPlayerSession();
    submitReport(sid, HOST_ID, 120_000);
    submitReport(sid, P1, 130_000);
    submitReport(sid, P2, 140_000);
    submitReport(sid, P3, 150_000);

    const rec = await waitForRecord('tt_neon_blvd_B_all', HOST_ID);
    expect(rec).toBeDefined();
    const meta = rec?.metadata as Record<string, unknown>;
    expect(meta['__server_token__']).toBe('phase2');
    expect(meta['sessionId']).toBe(sid);
    expect(meta['mode']).toBe('quick');
    expect(meta['confidence']).toBe('quorum');
    expect(meta['isBot']).toBe(false);
    expect(meta['car']).toBe('coupe');
  });

  it('does not increment wins_week in time_trial mode (ranked/quick only)', async () => {
    // Solo time_trial: HOST is the only finisher. Wins_week must NOT
    // be incremented because time_trial is not a wins-counted mode.
    const createEnv = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'match-tt',
      mode: 'time_trial',
      trackId: 'neon_blvd',
      size: 1,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    if (!createEnv.ok) throw new Error(`create failed: ${JSON.stringify(createEnv)}`);
    const sid = createEnv.data.sessionId;
    const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!startEnv.ok) throw new Error('start failed');
    const storeKey = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(storeKey);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;
    // time_trial mode on neon_blvd = 1 lap; totalMs=40_000.
    const ttResp = call<RaceSubmitResultOutput>(env, 'race_submit_result', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
      report: {
        userId: HOST_ID,
        totalMs: 40_000,
        laps: [40_000],
        isBotReport: false,
      },
    });
    if (!ttResp.ok) throw new Error(`time_trial submit failed: ${JSON.stringify(ttResp)}`);

    // time-trial table IS written.
    await waitForRecord('tt_neon_blvd_B_all', HOST_ID);
    expect(getRecord('tt_neon_blvd_B_all', HOST_ID)).toBeDefined();
    expect(getRecord('tt_neon_blvd_B_all', HOST_ID)?.score).toBe(40_000);
    // wins_week is NOT written for time_trial mode.
    expect(getRecord('wins_week', HOST_ID)).toBeUndefined();
  });
});