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
});
