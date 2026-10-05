// E2E tests for the weekly leaderboard reset path (Phase 2 §2.5 —
// "Weekly reset simulated: weekly table empty + historical intact").
//
// The Go runtime exposes `nk.leaderboardReset(id)` to clear every
// record on a scheduled-reset table. Our FakeNakama stub mirrors that
// contract (clears the records map for the given id, throws on unknown
// ids). These tests drive a full race through the bundle, then invoke
// the reset on the *week* table only, and assert:
//   1. records on the *week* table are gone
//   2. records on the *all-time* table (which has no reset schedule)
//      are still present
//   3. the leaderboard definition itself is left in place — a new
//      race after the reset writes fresh records to the week table
//   4. resetting an unknown leaderboard throws

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

const HOST_ID = 'user-host';
const P1 = 'user-p1';

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

async function waitForRecord(
  env: ReturnType<typeof loadBundleForTest>,
  tableId: string,
  ownerId: string,
  timeoutMs = 500,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = env.fakeNakama.leaderboardRecords.get(tableId)?.get(ownerId);
    if (rec !== undefined) return rec;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return env.fakeNakama.leaderboardRecords.get(tableId)?.get(ownerId);
}

describe('leaderboards weekly reset (Phase 2 §2.5)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  function setupQuick(): string {
    const createEnv = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'match-reset',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 2,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    if (!createEnv.ok) throw new Error(`create failed: ${JSON.stringify(createEnv)}`);
    const sid = createEnv.data.sessionId;
    const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
      env,
      'race_session_join',
      null,
      {
        sessionId: sid,
        userId: P1,
        callerUserId: P1,
        loadout: { classId: 'B', bodyId: 'coupe' },
      },
    );
    if (!joinEnv.ok) throw new Error(`join failed: ${JSON.stringify(joinEnv)}`);
    const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!startEnv.ok) throw new Error('start failed');
    // Backdate so the clock check tolerates our 120_000 ms totalMs.
    const storeKey = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(storeKey);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;
    return sid;
  }

  function submit(sid: string, userId: string, totalMs: number) {
    const r = call<RaceSubmitResultOutput>(env, 'race_submit_result', userId, {
      sessionId: sid,
      callerUserId: userId,
      report: {
        userId,
        totalMs,
        laps: [40_000, 40_000, totalMs - 80_000],
        isBotReport: false,
      },
    });
    if (!r.ok) throw new Error(`submit failed: ${JSON.stringify(r)}`);
  }

  it('clears only the week table — all-time records remain intact', async () => {
    const sid = setupQuick();
    submit(sid, HOST_ID, 120_000);
    submit(sid, P1, 130_000);

    // Wait for the fire-and-forget writer to land on the week table.
    const weekRec = await waitForRecord(env, 'tt_neon_blvd_B_week', HOST_ID);
    expect(weekRec).toBeDefined();

    // Both week and all-time are populated before the reset.
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_week')?.size ?? 0).toBe(2);
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_all')?.size ?? 0).toBe(2);
    expect(env.fakeNakama.leaderboardRecords.get('wins_week')?.get(HOST_ID)?.score).toBe(1);

    // Fire the reset.
    env.nak.leaderboardReset('tt_neon_blvd_B_week');

    // Week table: empty. All-time: intact. wins_week: NOT touched
    // (it has its own resetSchedule — the explicit reset clears the
    // single named id, not all scheduled-reset tables).
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_week')).toBeUndefined();
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_all')?.size ?? 0).toBe(2);
    expect(env.fakeNakama.leaderboardRecords.get('wins_week')?.get(HOST_ID)?.score).toBe(1);

    // Leaderboard definitions still exist — reset clears records, not
    // the leaderboard metadata.
    expect(env.fakeNakama.leaderboards.has('tt_neon_blvd_B_week')).toBe(true);
    expect(env.fakeNakama.leaderboards.has('tt_neon_blvd_B_all')).toBe(true);
  });

  it('a new race after the reset writes fresh records to the week table', async () => {
    const sid1 = setupQuick();
    submit(sid1, HOST_ID, 120_000);
    submit(sid1, P1, 130_000);
    await waitForRecord(env, 'tt_neon_blvd_B_week', HOST_ID);

    env.nak.leaderboardReset('tt_neon_blvd_B_week');
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_week')).toBeUndefined();

    // Run a second race on the same track/class.
    const sid2 = setupQuick();
    submit(sid2, HOST_ID, 130_000);
    submit(sid2, P1, 140_000);

    const weekRec = await waitForRecord(env, 'tt_neon_blvd_B_week', HOST_ID);
    expect(weekRec).toBeDefined();
    // Fresh score on the week table.
    expect((weekRec as { score: number }).score).toBe(130_000);
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_week')?.size ?? 0).toBe(2);
  });

  it('throws when resetting an unknown leaderboard id', () => {
    expect(() => env.nak.leaderboardReset('does_not_exist')).toThrow(/unknown leaderboard/);
  });

  it('does not affect tables that share the same suffix but are not the named id', async () => {
    const sid = setupQuick();
    submit(sid, HOST_ID, 120_000);
    submit(sid, P1, 130_000);
    await waitForRecord(env, 'tt_neon_blvd_B_week', HOST_ID);

    // wins_week has its own resetSchedule but is NOT named here — it
    // must be untouched.
    const winsBefore = env.fakeNakama.leaderboardRecords.get('wins_week')?.get(HOST_ID)?.score;
    expect(winsBefore).toBe(1);

    env.nak.leaderboardReset('tt_neon_blvd_B_week');

    // The named id is cleared.
    expect(env.fakeNakama.leaderboardRecords.get('tt_neon_blvd_B_week')).toBeUndefined();
    // wins_week stays untouched.
    expect(env.fakeNakama.leaderboardRecords.get('wins_week')?.get(HOST_ID)?.score).toBe(1);
  });
});