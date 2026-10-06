// E2E tests for the Phase 2 `lb_get` RPC. Covers:
//   - global view (top-N)
//   - around_me view (band around a known caller)
//   - friends view (currently returns just the caller)
//   - profile enrichment batched in the same response
//   - input validation (unknown table, bad view, missing caller)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import type { RaceSessionCreateOutput } from '../../modules/src/race/types';

const HOST_ID = 'user-host';
const P1 = 'user-p1';
const P2 = 'user-p2';
const P3 = 'user-p3';

interface LbGetResponse {
  ok: true;
  data: {
    leaderboardId: string;
    view: string;
    totalCount: number;
    records: Array<{
      ownerId: string;
      rank: number;
      score: number;
      subscore: number;
      metadata: Record<string, unknown>;
    }>;
    ownerRecord: {
      ownerId: string;
      rank: number;
      score: number;
    } | null;
    profiles: Record<
      string,
      { userId: string; displayName: string; avatarUrl: string | null }
    >;
  };
}

interface ErrResponse {
  ok: false;
  error: { code: string; message: string };
}

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

describe('lb_get RPC (Chunk 13)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  /**
   * Drive a 4-player quick race to completion and return the
   * session id. After the last submit, the RaceCompleted subscriber
   * writes a record per finisher into tt_neon_blvd_B_all (and friends),
   * giving us a populated leaderboard to read from.
   */
  async function setupPopulatedRace(): Promise<string> {
    const create = call<{ ok: true; data: RaceSessionCreateOutput } | ErrResponse>(
      env,
      'race_session_create',
      null,
      {
        matchId: 'm-lbget',
        mode: 'quick',
        trackId: 'neon_blvd',
        size: 4,
        hostLoadout: { classId: 'B', bodyId: 'coupe' },
        hostUserId: HOST_ID,
      },
    );
    if (!('ok' in create) || !create.ok) {
      throw new Error(`create failed: ${JSON.stringify(create)}`);
    }
    const sid = create.data.sessionId;
    for (const u of [P1, P2, P3]) {
      const j = call<{ ok: true } | ErrResponse>(
        env,
        'race_session_join',
        null,
        {
          sessionId: sid,
          userId: u,
          callerUserId: u,
          loadout: { classId: 'B', bodyId: 'coupe' },
        },
      );
      if (!('ok' in j) || !j.ok) throw new Error(`join ${u} failed`);
    }
    const s = call<{ ok: true } | ErrResponse>(env, 'race_session_start', HOST_ID, {
      sessionId: sid,
      callerUserId: HOST_ID,
    });
    if (!('ok' in s) || !s.ok) throw new Error('start failed');
    const k = `race_sessions/${sid}/${SYSTEM_USER_ID}`;
    const obj = env.fakeNakama.store.get(k);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;

    for (const u of [HOST_ID, P1, P2, P3]) {
      const r = call<{ ok: true } | ErrResponse>(env, 'race_submit_result', u, {
        sessionId: sid,
        callerUserId: u,
        report: {
          userId: u,
          totalMs: 120_000,
          laps: [40_000, 40_000, 40_000],
          isBotReport: false,
        },
      });
      if (!('ok' in r) || !r.ok) throw new Error(`submit ${u} failed`);
    }
    // Wait for the RaceCompleted subscriber to land the writes.
    const deadline = Date.now() + 500;
    while (
      Date.now() < deadline &&
      !env.fakeNakama.leaderboardRecords.has('tt_neon_blvd_B_all')
    ) {
      await new Promise((r) => setImmediate(r));
    }
   return sid;
  }

  it('global view returns top-N records with rank + score + metadata', async () => {
    await setupPopulatedRace();
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      limit: 10,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    const data = resp.data;
    expect(data.leaderboardId).toBe('tt_neon_blvd_B_all');
    expect(data.view).toBe('global');
    expect(data.totalCount).toBe(4);
    expect(data.records.length).toBe(4);
    // Sorted ascending by score.
    const scores = data.records.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    // First rank is 1.
    expect(data.records[0]?.rank).toBe(1);
    // Every record carries metadata.
    for (const r of data.records) {
      expect(r.metadata['__server_token__']).toBe('phase2');
      expect(typeof r.metadata['sessionId']).toBe('string');
    }
  });

  it('around_me view returns a band centered on the caller', async () => {
    await setupPopulatedRace();
    // HOST is rank 1; around_me(HOST, limit=4) → first 4 (the band
    // overflows the start because HOST is rank 1).
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'around_me',
      limit: 4,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.records.length).toBe(4);
    expect(resp.data.ownerRecord).not.toBeNull();
    expect(resp.data.ownerRecord?.ownerId).toBe(HOST_ID);
    expect(resp.data.ownerRecord?.rank).toBe(1);
  });

  it('friends view returns just the caller (no friend graph yet)', async () => {
    await setupPopulatedRace();
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'friends',
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.records.length).toBe(1);
    expect(resp.data.records[0]?.ownerId).toBe(HOST_ID);
  });

  it('enriches profiles in the same response (falls back to userId when missing)', async () => {
    await setupPopulatedRace();
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    // One profile entry per unique ownerId in the result.
    expect(Object.keys(resp.data.profiles).sort()).toEqual([HOST_ID, P1, P2, P3].sort());
    // No real profile records exist → fallback uses userId.
    expect(resp.data.profiles[HOST_ID]?.displayName).toBe(HOST_ID);
  });

  it('uses stored profiles when they exist (displayName from storage)', async () => {
    await setupPopulatedRace();
    // Seed a profile for HOST directly via the fake.
    env.fakeNakama.store.set(
      `profiles/${HOST_ID}/${HOST_ID}`,
      {
        collection: 'profiles',
        key: HOST_ID,
        userId: HOST_ID,
        value: { displayName: 'Hugo', avatarUrl: 'https://cdn/avatar.png' },
        version: 'v00000001',
        permissionRead: 0,
        permissionWrite: 0,
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        expiresAt: null,
      },
    );
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      callerUserId: HOST_ID,
    });
    expect(resp.data.profiles[HOST_ID]?.displayName).toBe('Hugo');
    expect(resp.data.profiles[HOST_ID]?.avatarUrl).toBe('https://cdn/avatar.png');
  });

  it('rejects an unknown leaderboard id', () => {
    const resp = call<ErrResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'does_not_exist',
      view: 'global',
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('NOT_FOUND');
  });

  it('rejects an invalid view', () => {
    const resp = call<ErrResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'top' as unknown as 'global',
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('BAD_REQUEST');
  });

  it('rejects when callerUserId mismatches the socket ctx userId', () => {
    const resp = call<ErrResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      callerUserId: P1, // HOST is authenticated, but we claim P1
    });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('FORBIDDEN');
  });

  it('clamps an oversized limit to MAX_LIMIT (100)', async () => {
    await setupPopulatedRace();
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      limit: 100_000,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    // We only have 4 records, but the cap shouldn't error.
    expect(resp.data.records.length).toBe(4);
  });

  it('around_me when caller is rank 1 (first rank) returns the leading records', async () => {
    await setupPopulatedRace();
    // HOST won (all submitted 120_000 — order is by subscore then ownerId,
    // so HOST isn't necessarily rank 1; let's just confirm HOST is in the
    // result and that calling around_me on rank 1 gives a valid slice).
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'around_me',
      limit: 4,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.ownerRecord?.rank).toBe(1);
    // First-rank edge: the band overflows the start, so we still
    // receive `limit` records.
    expect(resp.data.records.length).toBe(4);
    expect(resp.data.records[0]?.rank).toBe(1);
  });

  it('around_me when caller is last rank includes the tail (overflow at end)', async () => {
    await setupPopulatedRace();
    // Determine last rank ownerId, then call around_me on them.
    const global = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      limit: 100,
      callerUserId: HOST_ID,
    });
    const last = global.data.records[global.data.records.length - 1];
    expect(last).toBeDefined();
    const lastOwner = last!.ownerId;
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'around_me',
      limit: 4,
      aroundUserId: lastOwner,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.ownerRecord?.rank).toBe(global.data.totalCount);
    // Band overflows the end: the slice is `start..start+limit` and
    // clamped to the array end, so for last rank we get the trailing
    // 3 records (4-player board, last at idx=3, half=2, start=1).
    expect(resp.data.records.length).toBe(3);
    // The last record in the slice is the caller (last rank).
    expect(resp.data.records[resp.data.records.length - 1]?.ownerId).toBe(lastOwner);
  });

  it('around_me when caller has no record falls back to top-N (no error)', async () => {
    await setupPopulatedRace();
    const ghost = 'user-ghost-no-record';
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'around_me',
      limit: 3,
      aroundUserId: ghost,
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    // ownerRecord is null because the ghost user has no record.
    expect(resp.data.ownerRecord).toBeNull();
    // Fallback: we return the first `limit` records (NOT_FOUND semantics
    // is intentionally NOT used here — the leaderboard exists, the user
    // is just missing).
    expect(resp.data.records.length).toBe(3);
    expect(resp.data.records[0]?.rank).toBe(1);
  });
});