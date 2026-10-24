// T-05 (plan fishnet-nakama-server) — end to end through the built bundle:
// a dedicated ticket (D-03), the matched hook reserving a race server (D-04),
// the server's heartbeat receiving the assignment (D-01) and every player
// reading the server and only their own join ticket (D-05).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, runMatchedHook, SYSTEM_USER_ID } from './_stubs';
import type { IContext, IMatchmakerMatchedEnvelope } from '../../modules/src/nkruntime';
import type { RaceSession, RaceSessionGetOutput } from '../../modules/src/race/types';
import type { RsHeartbeatOutput } from '../../modules/src/race_servers/rpcs';

const SECRET = 'e2e-race-server-secret';
const SERVER_CTX = { ...FakeContext, env: { RACE_SERVER_SECRET: SECRET } } as IContext;
const PLAYERS = ['dp-alice', 'dp-bob', 'dp-carol'];

type Env = ReturnType<typeof loadBundleForTest>;
type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function rpc<T>(env: Env, id: string, ctx: IContext, payload: unknown): Resp<T> {
  const handler = env.resolver(id);
  if (!handler) throw new Error(`no rpc: ${id}`);
  return JSON.parse(handler(ctx, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function data<T>(r: Resp<T>): T {
  if (!r.ok) throw new Error(`rpc failed: ${r.error.code} ${r.error.message}`);
  return r.data;
}

function heartbeat(env: Env, serverId: string, over: Record<string, unknown> = {}): RsHeartbeatOutput {
  return data(rpc<RsHeartbeatOutput>(env, 'rs_heartbeat', SERVER_CTX, {
    serverKey: SECRET, serverId, host: `host-${serverId}`, port: 7770, capacity: 1,
    activeSessionId: null, buildVersion: '0.1.0', ...over,
  }));
}

function sessionGet(env: Env, userId: string, payload: Record<string, unknown> = {}): RaceSessionGetOutput {
  return data(rpc<RaceSessionGetOutput>(env, 'race_session_get', { ...FakeContext, userId }, payload));
}

function dedicatedEnvelope(users: string[]): IMatchmakerMatchedEnvelope {
  const metadata = { mode: 'quick', size: '4', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none', hosting: 'dedicated' };
  return {
    matches: [{
      sessionId: 'mm-dedicated',
      tickets: users.map((_u, i) => ({ ticket: `tok-${i}`, metadata })),
      matched: users.map((userId, i) => ({ userId, username: userId, vars: { rtt: String(40 + i) } })),
    }],
  } as unknown as IMatchmakerMatchedEnvelope;
}

describe('dedicated race server assignment (T-05)', () => {
  let env: Env;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('mm_ticket_params with hosting dedicated returns minCount 2 and maxCount 4', () => {
    const r = data(rpc<{ ticket: { query: Record<string, unknown>; metadata: Record<string, string> }; output: Record<string, unknown> }>(
      env, 'mm_ticket_params', { ...FakeContext, userId: 'dp-alice' }, { mode: 'quick', hosting: 'dedicated' },
    ));
    expect(r.output).toMatchObject({ mode: 'quick', size: 4, hosting: 'dedicated', minCount: 2, maxCount: 4 });
    expect(r.ticket.query['hosting']).toBe('dedicated');
    expect(r.ticket.metadata['hosting']).toBe('dedicated');
  });

  it('mm_ticket_params rejects hosting dedicated for a mode other than quick', () => {
    const r = rpc(env, 'mm_ticket_params', { ...FakeContext, userId: 'dp-alice' }, { mode: 'ranked', hosting: 'dedicated' });
    expect(r.ok).toBe(false);
  });

  it('heartbeat -> match -> heartbeat delivers the assignment; each player gets server and only their ticket', () => {
    expect(heartbeat(env, 'race-1', { port: 7788 }).assignment).toBeNull();

    const result = runMatchedHook(env, dedicatedEnvelope(PLAYERS));
    expect(result.matched).toBe(true);

    const { assignment } = heartbeat(env, 'race-1', { port: 7788 });
    expect(assignment).not.toBeNull();
    const stored = env.nak.storageRead([{ collection: 'race_sessions', key: result.sessionId!, userId: SYSTEM_USER_ID }])[0]!.value as unknown as RaceSession;
    expect(assignment).toMatchObject({
      sessionId: result.sessionId,
      mode: 'quick',
      trackId: stored.trackId,
      laps: stored.laps,
    });
    expect([...assignment!.expectedUserIds].sort()).toEqual([...PLAYERS].sort());
    expect(assignment!.joinDeadlineMs).toBe(stored.createdAt! + 30_000);

    // The same assignment is repeated while the session waits in `created`.
    expect(heartbeat(env, 'race-1', { port: 7788 }).assignment).toEqual(assignment);

    const ticketsByUser = new Map(stored.roster.map((e) => [e.userId, e.joinTicket!]));
    expect(new Set(ticketsByUser.values()).size).toBe(PLAYERS.length);
    for (const userId of PLAYERS) {
      const out = sessionGet(env, userId);
      expect(out.server).toEqual({ host: 'host-race-1', port: 7788 });
      expect(out.myJoinTicket).toBe(ticketsByUser.get(userId));
      expect(out.session.id).toBe(result.sessionId);
      expect(out.session.serverHosted).toBe(true);
      expect(out.session.laps).toBe(stored.laps);
      for (const entry of out.session.roster) expect(entry).not.toHaveProperty('joinTicket');
      // No ticket of anybody else, anywhere in the response.
      const raw = JSON.stringify(out);
      for (const [other, ticket] of ticketsByUser) {
        if (other !== userId) expect(raw).not.toContain(ticket);
      }
    }
  });

  it('race_session_get with an explicit sessionId follows the same rules', () => {
    heartbeat(env, 'race-1');
    const { sessionId } = runMatchedHook(env, dedicatedEnvelope(PLAYERS));
    const stored = env.nak.storageRead([{ collection: 'race_sessions', key: sessionId!, userId: SYSTEM_USER_ID }])[0]!.value as unknown as RaceSession;
    const mine = stored.roster.find((e) => e.userId === 'dp-bob')!.joinTicket;
    const out = sessionGet(env, 'dp-bob', { sessionId });
    expect(out.myJoinTicket).toBe(mine);
    expect(out.session.roster.every((e) => e.joinTicket === undefined)).toBe(true);
  });

  it('a different server gets no assignment', () => {
    heartbeat(env, 'race-1');
    heartbeat(env, 'race-2');
    const { sessionId } = runMatchedHook(env, dedicatedEnvelope(PLAYERS));
    const hosting = sessionGet(env, 'dp-alice').server!;
    const serverId = hosting.host.replace('host-', '');
    const other = serverId === 'race-1' ? 'race-2' : 'race-1';
    expect(heartbeat(env, other).assignment).toBeNull();
    expect(heartbeat(env, serverId).assignment?.sessionId).toBe(sessionId);
  });

  it('a session that already started is no longer offered, and a closed one exposes neither server nor ticket', () => {
    heartbeat(env, 'race-1');
    const { sessionId } = runMatchedHook(env, dedicatedEnvelope(PLAYERS));
    const row = env.nak.storageRead([{ collection: 'race_sessions', key: sessionId!, userId: SYSTEM_USER_ID }])[0]!;
    const started = { ...(row.value as unknown as RaceSession), state: 'started' as const, startedAt: Date.now() };
    env.nak.storageWrite([{
      collection: 'race_sessions', key: sessionId!, userId: SYSTEM_USER_ID, value: started as never,
      version: row.version, permissionRead: 0, permissionWrite: 0,
    }]);
    expect(heartbeat(env, 'race-1', { activeSessionId: sessionId }).assignment).toBeNull();
    expect(sessionGet(env, 'dp-alice').myJoinTicket).toBeDefined();

    const row2 = env.nak.storageRead([{ collection: 'race_sessions', key: sessionId!, userId: SYSTEM_USER_ID }])[0]!;
    env.nak.storageWrite([{
      collection: 'race_sessions', key: sessionId!, userId: SYSTEM_USER_ID,
      value: { ...(row2.value as object), state: 'closed' } as never,
      version: row2.version, permissionRead: 0, permissionWrite: 0,
    }]);
    const closed = sessionGet(env, 'dp-alice', { sessionId });
    expect(closed.server).toBeUndefined();
    expect(closed.myJoinTicket).toBeUndefined();
    expect(closed.session.roster.every((e) => e.joinTicket === undefined)).toBe(true);
  });

  it('with no free server there is no session, no active index and no assignment', () => {
    const result = runMatchedHook(env, dedicatedEnvelope(PLAYERS));
    expect(result.matched).toBe(false);
    const r = rpc(env, 'race_session_get', { ...FakeContext, userId: 'dp-alice' }, {});
    expect(r.ok).toBe(false);
    expect(env.fakeLogger.lines.some((l) => l.includes('matchmaker: no free race server'))).toBe(true);
    expect(heartbeat(env, 'race-1').assignment).toBeNull();
  });

  it('relayed sessions are unchanged: no server, no ticket', () => {
    heartbeat(env, 'race-1');
    const metadata = { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none' };
    const envelope = {
      matches: [{
        sessionId: 'mm-relay',
        tickets: [0, 1].map((i) => ({ ticket: `tok-${i}`, metadata })),
        matched: ['rl-a', 'rl-b'].map((userId) => ({ userId, username: userId, vars: { rtt: '50' } })),
      }],
    } as unknown as IMatchmakerMatchedEnvelope;
    expect(runMatchedHook(env, envelope).matched).toBe(true);
    const out = sessionGet(env, 'rl-a');
    expect(out.server).toBeUndefined();
    expect(out.myJoinTicket).toBeUndefined();
    expect(out.session.serverHosted).toBeUndefined();
    expect(heartbeat(env, 'race-1').assignment).toBeNull();
  });
});
