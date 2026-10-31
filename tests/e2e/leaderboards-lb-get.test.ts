// E2E tests for the Phase 2 `lb_get` RPC. Covers:
//   - global view (top-N)
//   - around_me view (band around a known caller)
//   - friends view (the caller and their friends, plan T-13)
//   - table order, cursors and usernames (plan T-13)
//   - profile enrichment batched in the same response
//   - input validation (unknown table, bad view, missing caller)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
  sessionCtxFor,
  autoSeedRaceGarages,
} from './_stubs';
import type { RaceSessionCreateOutput } from '../../modules/src/race/types';
import { clubMetadataWrite } from '../../modules/src/clubs/clubs_repo';
import { memberWrite } from '../../modules/src/clubs/members_repo';

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
  const ctx = caller === null ? sessionCtxFor(payload) : { ...FakeContext, userId: caller };
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
    autoSeedRaceGarages(env);
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
    if (obj) (obj.value as { startedAt: number }).startedAt = Date.now() - 600_000; // inside ABANDONED_SESSION_MS (T-06)

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

  it('enriches profiles in the same response (falls back to the username when missing)', async () => {
    await setupPopulatedRace();
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'tt_neon_blvd_B_all',
      view: 'global',
      callerUserId: HOST_ID,
    });
    expect(resp.ok).toBe(true);
    // One profile entry per unique ownerId in the result.
    expect(Object.keys(resp.data.profiles).sort()).toEqual([HOST_ID, P1, P2, P3].sort());
    // No real profile records exist → fallback uses the account username.
    expect(resp.data.profiles[HOST_ID]?.displayName).toBe(`name-${HOST_ID}`);
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
    // Nakama's haystack fills the page from above when the caller is
    // last, so a 4-record board returns all 4 records.
    expect(resp.data.records.length).toBe(4);
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

  // ── Plan T-13 ────────────────────────────────────────────────────────────

  function seedWins(wins: Record<string, number>): void {
    for (const [userId, n] of Object.entries(wins)) {
      for (let i = 0; i < n; i += 1) env.nak.leaderboardRecordWrite('wins_week', userId, '', 1, i, {});
    }
  }

  it('wins_week is listed from most to fewest wins, rank 1 first (desc table)', () => {
    seedWins({ [P1]: 1, [P2]: 3, [P3]: 2 });
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'wins_week',
      view: 'global',
      limit: 10,
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.records.map((r) => [r.ownerId, r.score, r.rank])).toEqual([
      [P2, 3, 1],
      [P3, 2, 2],
      [P1, 1, 3],
    ]);
    expect(resp.data.totalCount).toBe(3);
  });

  it('records written without a name get the account username', () => {
    seedWins({ [P1]: 1 });
    const resp = call<LbGetResponse & { data: { records: Array<{ username: string }> } }>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'wins_week',
      view: 'global',
    });
    expect(resp.data.records[0]?.username).toBe(`name-${P1}`);
  });

  it('global view pages with nextCursor / prevCursor', () => {
    seedWins({ [P1]: 1, [P2]: 3, [P3]: 2, [HOST_ID]: 4 });
    type Paged = LbGetResponse & { data: { nextCursor: string | null; prevCursor: string | null } };
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const resp: Paged = call<Paged>(env, 'lb_get', HOST_ID, {
        leaderboardId: 'wins_week',
        view: 'global',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(resp.ok).toBe(true);
      if (pages > 0) expect(resp.data.prevCursor).not.toBeNull();
      seen.push(...resp.data.records.map((r) => r.ownerId));
      cursor = resp.data.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toEqual([HOST_ID, P2, P3, P1]);
  });

  it('the race writer stores the account username on every record (HT-65)', async () => {
    await setupPopulatedRace();
    for (const table of ['tt_neon_blvd_B_all', 'lap_neon_blvd_B_all']) {
      const rec = env.fakeNakama.leaderboardRecords.get(table)?.get(HOST_ID);
      expect(rec?.username).toBe(`name-${HOST_ID}`);
    }
  });

  it('a malformed cursor is a BAD_REQUEST inside the envelope', () => {
    seedWins({ [P1]: 1 });
    const resp = call<ErrResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'wins_week',
      view: 'global',
      cursor: 'not-a-cursor',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('BAD_REQUEST');
  });

  it('friends view lists the caller and their friends (friends_edge), not strangers', () => {
    seedWins({ [HOST_ID]: 1, [P1]: 2, [P2]: 5 });
    env.nak.storageWrite([
      {
        collection: 'friends_edge',
        key: P1,
        userId: HOST_ID,
        value: { schemaVersion: 1, userId: HOST_ID, friendId: P1, friendCode: 'ABC123', since: 1 },
        permissionRead: 0,
        permissionWrite: 0,
      },
    ]);
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'wins_week',
      view: 'friends',
    });
    expect(resp.ok).toBe(true);
    // P2 (rank 1) is not a friend; ranks stay global.
    expect(resp.data.records.map((r) => [r.ownerId, r.rank])).toEqual([[P1, 2], [HOST_ID, 3]]);
  });

  it('accepts the ranked table of a season and ranks the best rating first', () => {
    env.nak.leaderboardRecordWrite('ranked_season_2', P1, '', 1010, 0, {}, 'set');
    env.nak.leaderboardRecordWrite('ranked_season_2', P2, '', 1090, 0, {}, 'set');
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'ranked_season_2',
      view: 'global',
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.records.map((r) => [r.ownerId, r.rank])).toEqual([[P2, 1], [P1, 2]]);
  });

  it('a season ranked table that does not exist yet is an empty board, not an error', () => {
    const resp = call<LbGetResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'ranked_season_9',
      view: 'global',
    });
    expect(resp.ok).toBe(true);
    expect(resp.data.records).toEqual([]);
    expect(resp.data.totalCount).toBe(0);
  });

  // ── Plan B2 (D-05): club tables ──────────────────────────────────────────

  interface ClubLbResponse {
    ok: true;
    data: {
      leaderboardId: string;
      view: string;
      ownerKind: string;
      totalCount: number;
      records: Array<{ ownerId: string; username: string; rank: number; score: number }>;
      ownerRecord: { ownerId: string; rank: number; score: number } | null;
      profiles: Record<string, unknown>;
      clubs: Record<string, { clubId: string; name: string; emblemId: string; memberCount: number }>;
      nextCursor: string | null;
      prevCursor: string | null;
    };
  }

  /** A club group of `size` members, its metadata, the leader's membership row and `points` in club_week. */
  function seedClub(name: string, leaderId: string, size: number, points: number): string {
    const group = env.nak.groupCreate(leaderId, name);
    const members = env.fakeNakama.groupMembers.get(group.id)!;
    for (let i = 1; i < size; i += 1) members.add(`${leaderId}-m${i}`);
    env.nak.storageWrite([
      clubMetadataWrite({
        schemaVersion: 1,
        clubId: group.id,
        leaderId,
        motto: 'go fast',
        emblemId: 'emblem_default',
        region: 'global',
        minDivision: 'bronce',
        weeklyPoints: points,
        createdAt: 1,
      }),
      memberWrite(
        { schemaVersion: 1, clubId: group.id, userId: leaderId, role: 'leader', joinedAt: 1, weeklyContribution: points },
        '*',
      ),
    ]);
    env.nak.leaderboardRecordWrite('club_week', group.id, '', points, 1761955200000, {});
    return group.id;
  }

  it('club_week global lists clubs with names, ranks, club views and the C-04 key order', () => {
    const big = seedClub('Night Riders', 'leader-big', 5, 5);
    const small = seedClub('Slow Pokes', 'leader-small', 2, 2);
    const resp = call<ClubLbResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'club_week',
      view: 'global',
    });
    expect(resp.ok).toBe(true);
    expect(Object.keys(resp.data)).toEqual([
      'leaderboardId', 'view', 'ownerKind', 'totalCount', 'records', 'ownerRecord',
      'profiles', 'clubs', 'nextCursor', 'prevCursor',
    ]);
    expect(resp.data.ownerKind).toBe('club');
    expect(resp.data.records.map((r) => [r.ownerId, r.username, r.rank])).toEqual([
      [big, 'Night Riders', 1],
      [small, 'Slow Pokes', 2],
    ]);
    expect(resp.data.clubs).toEqual({
      [big]: { clubId: big, name: 'Night Riders', emblemId: 'emblem_default', memberCount: 5 },
      [small]: { clubId: small, name: 'Slow Pokes', emblemId: 'emblem_default', memberCount: 2 },
    });
    expect(resp.data.profiles).toEqual({});
    expect(resp.data.ownerRecord).toBeNull();
  });

  it('club_week around_me centers on the clubs of the caller; no club gives the top page', () => {
    const big = seedClub('Night Riders', 'leader-big', 5, 5);
    const small = seedClub('Slow Pokes', 'leader-small', 2, 2);
    const member = call<ClubLbResponse>(env, 'lb_get', 'leader-small', {
      leaderboardId: 'club_week',
      view: 'around_me',
    });
    expect(member.ok).toBe(true);
    expect(member.data.ownerRecord?.ownerId).toBe(small);
    expect(member.data.ownerRecord?.rank).toBe(2);

    const loner = call<ClubLbResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'club_week',
      view: 'around_me',
    });
    expect(loner.ok).toBe(true);
    expect(loner.data.ownerRecord).toBeNull();
    expect(loner.data.records.map((r) => r.ownerId)).toEqual([big, small]);

    const explicit = call<ClubLbResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'club_week',
      view: 'around_me',
      aroundClubId: big,
    });
    expect(explicit.data.ownerRecord?.ownerId).toBe(big);
  });

  it('club_week rejects the friends view', () => {
    const resp = call<ErrResponse>(env, 'lb_get', HOST_ID, {
      leaderboardId: 'club_week',
      view: 'friends',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('BAD_REQUEST');
  });

  it('player tables answer ownerKind user and no clubs', () => {
    seedWins({ [P1]: 1 });
    const resp = call<LbGetResponse & { data: { ownerKind: string; clubs: Record<string, unknown> } }>(
      env,
      'lb_get',
      HOST_ID,
      { leaderboardId: 'wins_week', view: 'global' },
    );
    expect(resp.data.ownerKind).toBe('user');
    expect(resp.data.clubs).toEqual({});
  });
});
