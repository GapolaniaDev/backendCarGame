// T-06 (plan fishnet-nakama-server) — a whole race on a dedicated server,
// end to end through the built bundle: heartbeat, dedicated match (D-03,
// D-04), ticket validation, start, official results and payout (D-07,
// D-10), the freed server (D-02) and the client RPCs that no longer apply
// to such a session (D-07).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  runMatchedHook,
  seedRaceGarage,
  SYSTEM_USER_ID,
  type LoadedBundle,
} from './_stubs';
import type { IContext, IMatchmakerMatchedEnvelope } from '../../modules/src/nkruntime';
import type { RaceSession } from '../../modules/src/race/types';
import type { RsHeartbeatOutput, RsJoinValidateOutput, RsSessionStartOutput, RsSubmitResultsOutput } from '../../modules/src/race_servers/rpcs';
import type { RaceServerRecord } from '../../modules/src/race_servers/types';

const SECRET = 'e2e-race-server-secret';
const SERVER_CTX = { ...FakeContext, env: { RACE_SERVER_SECRET: SECRET } } as IContext;
const SERVER_ID = 'race-1';
const ALICE = 'df-alice';
const BOB = 'df-bob';
const CAROL = 'df-carol';
const DAVE = 'df-dave';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: { reason?: string } } };

function rpc<T>(env: LoadedBundle, id: string, ctx: IContext, payload: unknown): Resp<T> {
  const handler = env.resolver(id);
  if (!handler) throw new Error(`no rpc: ${id}`);
  return JSON.parse(handler(ctx, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function data<T>(r: Resp<T>): T {
  if (!r.ok) throw new Error(`rpc failed: ${r.error.code} ${r.error.message}`);
  return r.data;
}

const server = <T>(env: LoadedBundle, id: string, body: Record<string, unknown>): Resp<T> =>
  rpc<T>(env, id, SERVER_CTX, { serverKey: SECRET, serverId: SERVER_ID, ...body });

const heartbeat = (env: LoadedBundle, activeSessionId: string | null = null): RsHeartbeatOutput =>
  data(server<RsHeartbeatOutput>(env, 'rs_heartbeat', { host: '127.0.0.1', port: 7777, capacity: 1, activeSessionId, buildVersion: '0.1.0' }));

function dedicatedEnvelope(matchId: string, users: string[]): IMatchmakerMatchedEnvelope {
  const metadata = { mode: 'quick', size: '4', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none', hosting: 'dedicated' };
  return {
    matches: [{
      sessionId: matchId,
      tickets: users.map((_u, i) => ({ ticket: `${matchId}-${i}`, metadata })),
      matched: users.map((userId, i) => ({ userId, username: userId, vars: { rtt: String(40 + i) } })),
    }],
  } as unknown as IMatchmakerMatchedEnvelope;
}

const stored = (env: LoadedBundle, sid: string): RaceSession =>
  env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`)?.value as unknown as RaceSession;

const registry = (env: LoadedBundle): RaceServerRecord =>
  env.fakeNakama.store.get(`race_servers/${SERVER_ID}/${SYSTEM_USER_ID}`)?.value as unknown as RaceServerRecord;

const coins = (env: LoadedBundle, u: string): number => env.fakeNakama.wallets.get(u)?.['coins'] ?? 0;

/** The profile the progression payout needs (a new account has one from the first sign-in). */
function seedProfile(env: LoadedBundle, userId: string): void {
  const now = new Date().toISOString();
  env.fakeNakama.store.set(`profiles/${userId}/${userId}`, {
    collection: 'profiles', key: userId, userId,
    value: { schemaVersion: 1, userId, displayName: 'Racer', avatarUrl: null, createdAt: 0, updatedAt: 0, progression: { xp: 0, level: 1, lastDailyWinAt: 0 } },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0, createTime: now, updateTime: now, expiresAt: null,
  } as never);
}

/** Matches `users` on the (free) server and returns the session id. */
function matchOnServer(env: LoadedBundle, matchId: string, users: string[]): string {
  const result = runMatchedHook(env, dedicatedEnvelope(matchId, users));
  expect(result.matched).toBe(true);
  return result.sessionId!;
}

describe('a race on a dedicated server (T-06)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    for (const u of [ALICE, BOB, CAROL, DAVE]) {
      seedRaceGarage(env.nak, u, 'D');
      seedProfile(env, u);
    }
  });

  it('heartbeat, match of 2, both validated, start, results: closed with confidence server, both paid, server free', () => {
    expect(heartbeat(env).assignment).toBeNull();
    const sid = matchOnServer(env, 'mm-flow', [ALICE, BOB]);

    const { assignment } = heartbeat(env);
    expect(assignment?.sessionId).toBe(sid);
    expect(assignment?.expectedUserIds.slice().sort()).toEqual([ALICE, BOB]);

    // Each player presents the ticket the client got in race_session_get.
    for (const userId of [ALICE, BOB]) {
      const mine = data(rpc<{ myJoinTicket: string }>(env, 'race_session_get', { ...FakeContext, userId }, {})).myJoinTicket;
      const who = data(server<RsJoinValidateOutput>(env, 'rs_join_validate', { sessionId: sid, joinTicket: mine }));
      expect(who).toMatchObject({ userId, classId: 'D' });
      expect(who.displayName.length).toBeGreaterThan(0);
    }
    const bad = server<RsJoinValidateOutput>(env, 'rs_join_validate', { sessionId: sid, joinTicket: '0'.repeat(32) });
    expect(bad.ok ? 'ok' : bad.error.details?.reason).toBe('BAD_TICKET');

    const started = data(server<RsSessionStartOutput>(env, 'rs_session_start', { sessionId: sid }));
    expect(stored(env, sid).state).toBe('started');
    expect(stored(env, sid).startedAt).toBe(started.startedAt);
    expect(heartbeat(env, sid).assignment).toBeNull();
    expect(registry(env).sessionId).toBe(sid);

    // The track (and so the lap count) is the matchmaker's pick; 60 s laps are above every class D minimum.
    const lapsOf = (ms: number): number[] => Array.from({ length: assignment!.laps }, () => ms);
    const totalOf = (ms: number): number => ms * assignment!.laps;
    const results = [
      { userId: BOB, isBot: false, displayName: 'Bob', totalMs: totalOf(61_000), laps: lapsOf(61_000), dnf: false },
      { userId: ALICE, isBot: false, displayName: 'Alice', totalMs: totalOf(60_000), laps: lapsOf(60_000), dnf: false },
    ];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-flow', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.userId, r.abandoned])).toEqual([[1, ALICE, false], [2, BOB, false]]);
    for (const u of [ALICE, BOB]) {
      expect(submitted.rewards[u]?.coins).toBeGreaterThan(0);
      expect(submitted.rewards[u]?.xp).toBeGreaterThan(0);
      expect(submitted.rewards[u]?.newLevel).toBeGreaterThanOrEqual(1);
      expect(coins(env, u)).toBeGreaterThan(0);
    }

    const closed = stored(env, sid);
    expect(closed.state).toBe('closed');
    expect(closed.results.map((r) => r.userId)).toEqual([ALICE, BOB]);
    expect(env.fakeLogger.lines.some((l) => l.includes('race closed') && l.includes(`sid=${sid}`) && l.includes('confidence=server'))).toBe(true);
    // The client reads the result with race_session_get.
    const seen = data(rpc<{ session: RaceSession; myJoinTicket?: string }>(env, 'race_session_get', { ...FakeContext, userId: ALICE }, { sessionId: sid }));
    expect(seen.session.state).toBe('closed');
    expect(seen.myJoinTicket).toBeUndefined();

    // The server is free at once and at its next heartbeat, and gets the next match.
    expect(registry(env).sessionId).toBeNull();
    expect(heartbeat(env).assignment).toBeNull();
    const second = matchOnServer(env, 'mm-flow-2', [CAROL, DAVE]);
    expect(heartbeat(env).assignment?.sessionId).toBe(second);

    // The retry of the closing call returns the same response and pays nothing more.
    const before = coins(env, ALICE);
    expect(data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-flow', results }))).toEqual(submitted);
    expect(coins(env, ALICE)).toBe(before);
  });

  it('the client RPCs that drive a race are FORBIDDEN (SERVER_HOSTED) on a server-hosted session', () => {
    heartbeat(env);
    const sid = matchOnServer(env, 'mm-guard', [ALICE, BOB]);
    data(server(env, 'rs_session_start', { sessionId: sid }));
    const as = (userId: string): IContext => ({ ...FakeContext, userId });
    const lapsOf = [60_000, 60_000, 60_000];
    const attempts: Array<[string, IContext, Record<string, unknown>]> = [
      ['race_submit_result', as(ALICE), { sessionId: sid, report: { userId: ALICE, totalMs: 180_000, laps: lapsOf, isBotReport: false } }],
      ['race_session_start', as(ALICE), { sessionId: sid }],
      ['race_host_claim', as(BOB), { sessionId: sid }],
      ['race_session_join', as(CAROL), { sessionId: sid, loadout: { classId: 'D', bodyId: 'starter_viper' } }],
    ];
    for (const [id, ctx, payload] of attempts) {
      const r = rpc(env, id, ctx, payload);
      expect(r.ok ? 'ok' : `${r.error.code}/${r.error.details?.reason}`).toBe('FORBIDDEN/SERVER_HOSTED');
    }
    expect(stored(env, sid).state).toBe('started');
    expect(coins(env, ALICE)).toBe(0);
  });

  it('rs_session_release closes without payments and the server takes the next match', () => {
    heartbeat(env);
    const sid = matchOnServer(env, 'mm-release', [ALICE, BOB]);
    data(server(env, 'rs_session_start', { sessionId: sid }));
    expect(data(server<{ released: boolean }>(env, 'rs_session_release', { sessionId: sid, reason: 'server_error' }))).toEqual({ released: true });
    expect(stored(env, sid).state).toBe('closed');
    expect(stored(env, sid).results.every((r) => r.abandoned)).toBe(true);
    expect(coins(env, ALICE) + coins(env, BOB)).toBe(0);
    expect(registry(env).sessionId).toBeNull();
    const next = matchOnServer(env, 'mm-release-2', [CAROL, DAVE]);
    expect(heartbeat(env).assignment?.sessionId).toBe(next);
  });

  /** A started dedicated session of ALICE and BOB; returns its id and a helper that builds finisher rows. */
  function startedPair(matchId: string): { sid: string; row: (userId: string | null, isBot: boolean, lapMs: number, extra?: Record<string, unknown>) => Record<string, unknown> } {
    heartbeat(env);
    const sid = matchOnServer(env, matchId, [ALICE, BOB]);
    const { assignment } = heartbeat(env);
    data(server<RsSessionStartOutput>(env, 'rs_session_start', { sessionId: sid }));
    const laps = assignment!.laps;
    const row = (userId: string | null, isBot: boolean, lapMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      userId, isBot, displayName: 'Racer', totalMs: lapMs * laps, laps: Array.from({ length: laps }, () => lapMs), dnf: false, ...extra,
    });
    return { sid, row };
  }

  it('a human 3rd and 4th of a race with 2 humans and 2 bots is paid from the size-4 row, and the server rank rules (P-12, D-04)', () => {
    const { sid, row } = startedPair('mm-bots');
    // The humans are the faster by time, but the server placed them 3rd and 4th.
    const results = [
      row(null, true, 70_000, { rank: 1, estimated: true }),
      row(null, true, 71_000, { rank: 2, estimated: true }),
      row(ALICE, false, 60_000, { rank: 3 }),
      row(BOB, false, 61_000, { rank: 4 }),
    ];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-bots', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.isBot])).toEqual([[1, true], [2, true], [3, false], [4, false]]);
    expect(submitted.officialResults.filter((r) => !r.isBot).map((r) => [r.rank, r.userId])).toEqual([[3, ALICE], [4, BOB]]);
    expect(submitted.rewards[ALICE]?.coins).toBeGreaterThan(0);
    expect(submitted.rewards[BOB]?.coins).toBeGreaterThan(0);
    expect(submitted.rewards[ALICE]!.coins).toBeGreaterThan(submitted.rewards[BOB]!.coins);
    // The session keeps its matched size; only the payout looks at the rows.
    expect(stored(env, sid).size).toBe(2);
  });

  it('without rank the order stays by time', () => {
    const { sid, row } = startedPair('mm-no-rank');
    const results = [row(BOB, false, 62_000), row(ALICE, false, 60_000)];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-no-rank', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.userId])).toEqual([[1, ALICE], [2, BOB]]);
  });

  it('rank out of range, repeated or on only some rows is INVALID_RESULT; a non-integer rank is BAD_REQUEST', () => {
    const { sid, row } = startedPair('mm-bad-rank');
    const submit = (results: unknown[]) => server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: `req-${Math.random()}`, results });
    const reasonOf = (r: Resp<unknown>): string => (r.ok ? 'ok' : `${r.error.code}/${r.error.details?.reason ?? ''}`);
    expect(reasonOf(submit([row(ALICE, false, 60_000, { rank: 1 }), row(BOB, false, 61_000, { rank: 3 })]))).toBe('INVALID_RESULT/RANK_OUT_OF_RANGE');
    expect(reasonOf(submit([row(ALICE, false, 60_000, { rank: 1 }), row(BOB, false, 61_000, { rank: 1 })]))).toBe('INVALID_RESULT/DUPLICATE_RANK');
    expect(reasonOf(submit([row(ALICE, false, 60_000, { rank: 1 }), row(BOB, false, 61_000)]))).toBe('INVALID_RESULT/RANK_INCOMPLETE');
    expect(reasonOf(submit([row(ALICE, false, 60_000, { rank: 1.5 }), row(BOB, false, 61_000, { rank: 2 })]))).toBe('BAD_REQUEST/');
    expect(reasonOf(submit([row(ALICE, false, 60_000, { rank: 0 }), row(BOB, false, 61_000, { rank: 1 })]))).toBe('BAD_REQUEST/');
    expect(stored(env, sid).state).toBe('started');
  });

  it('race_session_get returns confidence "server" for a session closed by the server (P-13, D-06)', () => {
    const { sid, row } = startedPair('mm-confidence');
    data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-conf', results: [row(ALICE, false, 60_000), row(BOB, false, 61_000)] }));
    expect(stored(env, sid).confidence).toBe('server');
    const seen = data(rpc<{ session: RaceSession }>(env, 'race_session_get', { ...FakeContext, userId: ALICE }, { sessionId: sid }));
    expect(seen.session.confidence).toBe('server');
  });

  it('a relay race closed by the players\' reports stores its quorum confidence (P-13, D-06)', () => {
    const as = (userId: string): IContext => ({ ...FakeContext, userId });
    const loadout = { classId: 'D', bodyId: 'starter_viper' };
    const created = data(rpc<{ sessionId: string }>(env, 'race_session_create', as(ALICE), {
      matchId: 'm-quorum', mode: 'private', trackId: 'neon_blvd', size: 2, hostLoadout: loadout, hostUserId: ALICE,
    }));
    data(rpc(env, 'race_session_join', as(BOB), { sessionId: created.sessionId, userId: BOB, loadout }));
    data(rpc(env, 'race_session_start', as(ALICE), { sessionId: created.sessionId }));
    stored(env, created.sessionId).startedAt = Date.now() - 200_000;
    const laps = [48_100, 48_100, 48_100];
    for (const userId of [ALICE, BOB]) {
      data(rpc(env, 'race_submit_result', as(userId), {
        sessionId: created.sessionId, requestId: `req-${userId}`,
        report: { userId, totalMs: 144_300, laps, isBotReport: false },
      }));
    }
    expect(stored(env, created.sessionId).state).toBe('closed');
    expect(stored(env, created.sessionId).confidence).toBe('quorum');
    const seen = data(rpc<{ session: RaceSession }>(env, 'race_session_get', as(ALICE), { sessionId: created.sessionId }));
    expect(seen.session.confidence).toBe('quorum');
  });

  it('estimated bots (no laps) close the race: ranks 1..4, bots not abandoned, humans paid (D-01)', () => {
    const { sid, row } = startedPair('mm-est-a');
    const bot = (rank?: number): Record<string, unknown> => ({ userId: null, isBot: true, displayName: 'Bot', totalMs: 0, laps: [], dnf: false, estimated: true, ...(rank !== undefined ? { rank } : {}) });
    const results = [row(ALICE, false, 60_000, { rank: 1 }), row(BOB, false, 61_000, { rank: 2 }), bot(3), bot(4)];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-est-a', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.isBot, r.abandoned])).toEqual([[1, false, false], [2, false, false], [3, true, false], [4, true, false]]);
    expect(submitted.rewards[ALICE]?.coins).toBeGreaterThan(0);
    expect(submitted.rewards[BOB]?.coins).toBeGreaterThan(0);
  });

  it('human 1st, estimated bot 2nd, human 3rd: the 3rd is paid from the size-4 row', () => {
    const { sid, row } = startedPair('mm-est-b');
    const bot = { userId: null, isBot: true, displayName: 'Bot', totalMs: 0, laps: [], dnf: false, estimated: true, rank: 2 };
    const results = [row(ALICE, false, 60_000, { rank: 1 }), bot, row(BOB, false, 61_000, { rank: 3 }), { ...bot, rank: 4 }];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-est-b', results }));
    expect(submitted.officialResults.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    const quick = submitted.rewards[ALICE]!.coins - submitted.rewards[BOB]!.coins;
    expect(quick).toBeGreaterThan(0);
    // Same bonuses for both, so the difference is the gap of the "4" row: 100 - 50, times the mode multiplier.
    expect(submitted.rewards[BOB]!.coins).toBeGreaterThanOrEqual(50);
  });

  it('estimated on a human is INVALID_RESULT ESTIMATED_NOT_BOT', () => {
    const { sid, row } = startedPair('mm-est-c');
    const r = server<RsSubmitResultsOutput>(env, 'rs_submit_results', {
      sessionId: sid, requestId: 'req-est-c', results: [row(ALICE, false, 60_000, { estimated: true }), row(BOB, false, 61_000)],
    });
    expect(r.ok ? 'ok' : `${r.error.code}/${r.error.details?.reason}`).toBe('INVALID_RESULT/ESTIMATED_NOT_BOT');
  });

  it('with rank, a human listed with dnf keeps the server rank (no gap)', () => {
    const { sid, row } = startedPair('mm-dnf-rank');
    const bot = { userId: null, isBot: true, displayName: 'Bot', totalMs: 0, laps: [], dnf: false, estimated: true };
    const results = [
      row(ALICE, false, 60_000, { rank: 1 }), { ...bot, rank: 2 }, { ...bot, rank: 3 },
      { userId: BOB, isBot: false, displayName: 'Bob', totalMs: 0, laps: [], dnf: true, rank: 4 },
    ];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-dnf-rank', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.userId === BOB ? 'bob' : '', r.abandoned])).toEqual([[1, '', false], [2, '', false], [3, '', false], [4, 'bob', true]]);
  });

  it('without rank an estimated bot goes behind the timed finishers and before the DNFs', () => {
    const { sid, row } = startedPair('mm-est-e');
    const results = [
      { userId: null, isBot: true, displayName: 'Bot', totalMs: 0, laps: [], dnf: false, estimated: true },
      { userId: BOB, isBot: false, displayName: 'Bob', totalMs: 0, laps: [], dnf: true },
      row(ALICE, false, 60_000),
    ];
    const submitted = data(server<RsSubmitResultsOutput>(env, 'rs_submit_results', { sessionId: sid, requestId: 'req-est-e', results }));
    expect(submitted.officialResults.map((r) => [r.rank, r.isBot, r.abandoned])).toEqual([[1, false, false], [2, true, false], [3, false, true]]);
  });
});