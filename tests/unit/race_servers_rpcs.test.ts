// T-06 (plan fishnet-nakama-server) — the session RPCs of the dedicated race
// servers: rs_join_validate, rs_session_start, rs_submit_results and
// rs_session_release (D-01, D-07, D-10).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeContext, SYSTEM_USER_ID } from '../e2e/_stubs';
import type { IContext, ILogger, INakama } from '../../modules/src/nkruntime';
import {
  rs_heartbeat_impl,
  rs_join_validate_impl,
  rs_session_release_impl,
  rs_session_start_impl,
  rs_submit_results_impl,
  REVIEW_LAP_BELOW_MIN,
  type RsSubmitResultsOutput,
} from '../../modules/src/race_servers/rpcs';
import { claimServer, readServer } from '../../modules/src/race_servers/registry_repo';
import { createSession } from '../../modules/src/race/session_repo';
import type { RaceSession, RaceState } from '../../modules/src/race/types';
import { ensureRuntimeState } from '../../modules/src/core/runtime_state';

const SECRET = 'a-long-random-secret';
const CTX: IContext = { ...FakeContext, env: { RACE_SERVER_SECRET: SECRET } } as IContext;
const SERVER = 'srv-1';
const OTHER_SERVER = 'srv-2';
const ALICE = 'rs-alice';
const BOB = 'rs-bob';
const TICKETS: Record<string, string> = {
  [ALICE]: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  [BOB]: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
};
/** neon_blvd, mode quick: 3 laps, class D minimum 48 000 ms per lap. */
const LAPS = 3;
const GOOD_LAP = 50_000;

type Envelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: { reason?: string } } };

function makeLogger(): ILogger & { lines: string[] } {
  const lines: string[] = [];
  const log = (f: string, ...args: unknown[]): void => { lines.push([f, ...args.map(String)].join(' ')); };
  const logger = {
    lines,
    debug: () => {},
    info: log,
    warn: log,
    error: log,
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  };
  return logger as unknown as ILogger & { lines: string[] };
}

function sessionDoc(id: string, state: RaceState, serverId: string, over: Partial<RaceSession> = {}): RaceSession {
  return {
    schemaVersion: 1,
    id,
    matchId: id,
    mode: 'quick',
    trackId: 'neon_blvd',
    size: 2,
    roster: [ALICE, BOB].map((userId) => ({
      userId, isBot: false, loadout: { classId: 'D', bodyId: `body-${userId}` }, joinTicket: TICKETS[userId]!,
    })),
    host: ALICE,
    hostSuccession: [ALICE, BOB],
    state,
    createdAt: Date.now(),
    startedAt: state === 'created' ? null : Date.now() - 10_000,
    results: [],
    flags: { needsReview: false },
    serverHosted: true,
    server: { serverId, host: '10.0.0.5', port: 7770 },
    laps: LAPS,
    version: 0,
    ...over,
  };
}

const laps = (...times: number[]): number[] => times;
const finisher = (userId: string | null, lapTimes: number[], over: Record<string, unknown> = {}) => ({
  userId, isBot: false, displayName: 'x', totalMs: lapTimes.reduce((a, b) => a + b, 0), laps: lapTimes, dnf: false, ...over,
});

describe('rs_* session RPCs (T-06)', () => {
  let fake: FakeNakama;
  let nk: INakama;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = makeLogger();
    ensureRuntimeState(nk, logger);
    for (const serverId of [SERVER, OTHER_SERVER]) {
      const hb = JSON.stringify({
        serverKey: SECRET, serverId, host: '10.0.0.5', port: 7770, capacity: 1, activeSessionId: null, buildVersion: '0.1.0',
      });
      expect(JSON.parse(rs_heartbeat_impl(CTX, logger, nk, hb)).ok).toBe(true);
    }
  });

  /** Stores a session hosted by `serverId` and reserves that server for it. */
  function seed(id: string, state: RaceState, serverId = SERVER, over: Partial<RaceSession> = {}): void {
    createSession(nk, sessionDoc(id, state, serverId, over), [ALICE, BOB]);
    const entry = readServer(nk, serverId)!;
    if (state !== 'closed') {
      expect(claimServer(nk, { serverId, record: entry.record, version: entry.version }, id, Date.now())).toBe(true);
    }
  }

  const stored = (id: string): RaceSession =>
    nk.storageRead([{ collection: 'race_sessions', key: id, userId: SYSTEM_USER_ID }])[0]!.value as unknown as RaceSession;
  const serverSession = (serverId = SERVER): string | null => readServer(nk, serverId)!.record.sessionId;

  function call<T>(impl: typeof rs_join_validate_impl, body: Record<string, unknown>, ctx: IContext = CTX, over: INakama = nk): Envelope<T> {
    return JSON.parse(impl(ctx, logger, over, JSON.stringify({ serverKey: SECRET, serverId: SERVER, ...body }))) as Envelope<T>;
  }
  const codeOf = (r: Envelope): string => (r.ok ? 'ok' : r.error.code);
  const reasonOf = (r: Envelope): string | undefined => (r.ok ? undefined : r.error.details?.reason);

  describe('rs_join_validate', () => {
    it('answers the player behind a good ticket, reusable while the session is not closed', () => {
      seed('s1', 'created');
      const named = new Proxy(nk, {
        get: (target, prop, receiver) => prop === 'accountGetId'
          ? () => ({ user: { displayName: 'Ana', username: 'ana_01' } })
          : Reflect.get(target, prop, receiver) as unknown,
      });
      const first = call<Record<string, string>>(rs_join_validate_impl, { sessionId: 's1', joinTicket: TICKETS[ALICE] }, CTX, named);
      expect(first).toEqual({ ok: true, data: { userId: ALICE, displayName: 'Ana', classId: 'D', bodyId: `body-${ALICE}` } });
      expect(call(rs_join_validate_impl, { sessionId: 's1', joinTicket: TICKETS[ALICE] }, CTX, named).ok).toBe(true);
      // Reconnection after the race started.
      seed('s2', 'started', OTHER_SERVER);
      const again = call<{ userId: string }>(rs_join_validate_impl, { serverId: OTHER_SERVER, sessionId: 's2', joinTicket: TICKETS[BOB] });
      expect(again.ok && again.data.userId).toBe(BOB);
    });

    it('falls back to the username when the account has no display name', () => {
      seed('s1', 'created');
      const r = call<{ displayName: string }>(rs_join_validate_impl, { sessionId: 's1', joinTicket: TICKETS[BOB] });
      expect(r.ok && r.data.displayName).toBe('fake-user');
    });

    it('rejects a wrong ticket, an empty one and one of another session', () => {
      seed('s1', 'created');
      seed('s2', 'created', OTHER_SERVER, { roster: sessionDoc('s2', 'created', OTHER_SERVER).roster.map((e) => ({ ...e, joinTicket: `ff${e.joinTicket!.slice(2)}` })) });
      for (const joinTicket of ['00000000000000000000000000000000', '', TICKETS[ALICE]!.slice(0, 31), `ff${TICKETS[ALICE]!.slice(2)}`]) {
        const r = call(rs_join_validate_impl, { sessionId: 's1', joinTicket });
        expect([codeOf(r), reasonOf(r)]).toEqual(['FORBIDDEN', 'BAD_TICKET']);
      }
      // The ticket of s2 (other server) is not valid in s1, and s1's not in s2.
      const r2 = call(rs_join_validate_impl, { serverId: OTHER_SERVER, sessionId: 's2', joinTicket: TICKETS[ALICE] });
      expect([codeOf(r2), reasonOf(r2)]).toEqual(['FORBIDDEN', 'BAD_TICKET']);
      expect(call(rs_join_validate_impl, { serverId: OTHER_SERVER, sessionId: 's2', joinTicket: `ff${TICKETS[ALICE]!.slice(2)}` }).ok).toBe(true);
    });

    it('rejects a session of another server, a missing one and a hosted-by-nobody one with NOT_ASSIGNED', () => {
      seed('s1', 'created');
      createSession(nk, { ...sessionDoc('relay', 'created', SERVER), serverHosted: undefined, server: undefined });
      for (const [serverId, sessionId] of [[OTHER_SERVER, 's1'], [SERVER, 'nope'], [SERVER, 'relay']] as const) {
        const r = call(rs_join_validate_impl, { serverId, sessionId, joinTicket: TICKETS[ALICE] });
        expect([codeOf(r), reasonOf(r)]).toEqual(['FORBIDDEN', 'NOT_ASSIGNED']);
      }
    });

    it('rejects a closed session with BAD_STATE', () => {
      seed('s1', 'closed');
      const r = call(rs_join_validate_impl, { sessionId: 's1', joinTicket: TICKETS[ALICE] });
      expect([codeOf(r), reasonOf(r)]).toEqual(['FORBIDDEN', 'BAD_STATE']);
    });

    it('needs the server key and a string ticket', () => {
      seed('s1', 'created');
      expect(codeOf(call(rs_join_validate_impl, { sessionId: 's1', joinTicket: TICKETS[ALICE], serverKey: 'wrong' }))).toBe('FORBIDDEN');
      expect(codeOf(call(rs_join_validate_impl, { sessionId: 's1' }))).toBe('BAD_REQUEST');
      expect(codeOf(call(rs_join_validate_impl, { sessionId: 's1', joinTicket: 7 }))).toBe('BAD_REQUEST');
      expect(codeOf(call(rs_join_validate_impl, { joinTicket: TICKETS[ALICE] }))).toBe('BAD_REQUEST');
    });
  });

  describe('rs_session_start', () => {
    it('moves created to started once and repeats the same startedAt', () => {
      seed('s1', 'created');
      const first = call<{ startedAt: number }>(rs_session_start_impl, { sessionId: 's1' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(stored('s1').state).toBe('started');
      expect(stored('s1').startedAt).toBe(first.data.startedAt);
      const second = call<{ startedAt: number }>(rs_session_start_impl, { sessionId: 's1' });
      expect(second).toEqual({ ok: true, data: { startedAt: first.data.startedAt } });
    });

    it('refuses a closed session, a session of another server and a missing one', () => {
      seed('closed', 'closed');
      seed('s1', 'created');
      expect(codeOf(call(rs_session_start_impl, { sessionId: 'closed' }))).toBe('CONFLICT');
      const other = call(rs_session_start_impl, { serverId: OTHER_SERVER, sessionId: 's1' });
      expect([codeOf(other), reasonOf(other)]).toEqual(['FORBIDDEN', 'NOT_ASSIGNED']);
      expect(codeOf(call(rs_session_start_impl, { sessionId: 'nope' }))).toBe('NOT_FOUND');
    });
  });

  describe('rs_submit_results', () => {
    const submit = (body: Record<string, unknown>) => call<RsSubmitResultsOutput>(rs_submit_results_impl, { sessionId: 's1', requestId: 'req-1', ...body });
    const both = [finisher(ALICE, laps(GOOD_LAP, GOOD_LAP, GOOD_LAP)), finisher(BOB, laps(51_000, 51_000, 51_000))];

    it('closes with the ranked results, confidence server, and frees the server', () => {
      seed('s1', 'started');
      const r = submit({ results: [both[1], both[0]] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.officialResults).toEqual([
        { rank: 1, userId: ALICE, isBot: false, totalMs: 150_000, abandoned: false },
        { rank: 2, userId: BOB, isBot: false, totalMs: 153_000, abandoned: false },
      ]);
      expect(Object.keys(r.data.rewards).sort()).toEqual([ALICE, BOB]);
      const s = stored('s1');
      expect(s.state).toBe('closed');
      expect(s.flags.needsReview).toBe(false);
      expect(s.roster.find((e) => e.userId === ALICE)).toMatchObject({ totalMs: 150_000, laps: [GOOD_LAP, GOOD_LAP, GOOD_LAP] });
      expect(logger.lines.some((l) => l.startsWith('race closed') && l.endsWith('s1 server_results server false 0'))).toBe(true);
      expect(serverSession()).toBeNull();
    });

    it('rejects laps that do not add up to the total, and a wrong lap count', () => {
      seed('s1', 'started');
      const badSum = submit({ results: [{ ...both[0], totalMs: 150_001 }, both[1]] });
      expect([codeOf(badSum), reasonOf(badSum)]).toEqual(['INVALID_RESULT', 'LAP_SUM_MISMATCH']);
      const badCount = submit({ results: [finisher(ALICE, laps(GOOD_LAP, GOOD_LAP)), both[1]] });
      expect([codeOf(badCount), reasonOf(badCount)]).toEqual(['INVALID_RESULT', 'LAP_COUNT_MISMATCH']);
      expect(stored('s1').state).toBe('started');
      expect(serverSession()).toBe('s1');
    });

    it('rejects a human outside the roster, a duplicate and a bot using a player id', () => {
      seed('s1', 'started');
      expect(reasonOf(submit({ results: [finisher('stranger', laps(GOOD_LAP, GOOD_LAP, GOOD_LAP))] }))).toBe('NOT_IN_ROSTER');
      expect(reasonOf(submit({ results: [finisher(null, laps(GOOD_LAP, GOOD_LAP, GOOD_LAP))] }))).toBe('NOT_IN_ROSTER');
      expect(reasonOf(submit({ results: [both[0], both[0]] }))).toBe('DUPLICATE_RESULT');
      expect(reasonOf(submit({ results: [finisher(ALICE, laps(GOOD_LAP, GOOD_LAP, GOOD_LAP), { isBot: true })] }))).toBe('BOT_ID_CLASH');
      expect(stored('s1').state).toBe('started');
    });

    it('rejects malformed bodies with BAD_REQUEST', () => {
      seed('s1', 'started');
      expect(codeOf(submit({ results: [] }))).toBe('BAD_REQUEST');
      expect(codeOf(submit({ results: 'x' }))).toBe('BAD_REQUEST');
      expect(codeOf(submit({ results: [{ ...both[0], dnf: 'no' }] }))).toBe('BAD_REQUEST');
      expect(codeOf(submit({ results: [{ ...both[0], laps: ['a'] }] }))).toBe('BAD_REQUEST');
      expect(codeOf(submit({ results: both, requestId: '' }))).toBe('BAD_REQUEST');
    });

    it('accepts a lap under the class minimum and flags the race for review', () => {
      seed('s1', 'started');
      const fast = finisher(ALICE, laps(40_000, 50_000, 50_000));
      const r = submit({ results: [fast, both[1]] });
      expect(r.ok).toBe(true);
      expect(stored('s1').state).toBe('closed');
      expect(stored('s1').flags).toMatchObject({ needsReview: true, reviewReason: REVIEW_LAP_BELOW_MIN });
    });

    it('marks the humans that are absent or report dnf as DNF, after the finishers, without payment', () => {
      seed('s1', 'started');
      const r = submit({ results: [both[0]] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.officialResults.map((x) => [x.userId, x.rank, x.abandoned])).toEqual([[ALICE, 1, false], [BOB, 2, true]]);
      expect(Object.keys(r.data.rewards)).toEqual([ALICE]);
      expect(stored('s1').roster.find((e) => e.userId === BOB)?.abandoned).toBe(true);

      seed('s2', 'started', OTHER_SERVER);
      const dnf = call<RsSubmitResultsOutput>(rs_submit_results_impl, {
        serverId: OTHER_SERVER, sessionId: 's2', requestId: 'req-2',
        results: [{ userId: BOB, isBot: false, displayName: 'b', totalMs: 0, laps: [], dnf: true }, both[0]],
      });
      expect(dnf.ok && dnf.data.officialResults.map((x) => [x.userId, x.abandoned])).toEqual([[ALICE, false], [BOB, true]]);
    });

    it('ranks bots among the humans without paying them', () => {
      seed('s1', 'started');
      const bot = { userId: null, isBot: true, displayName: 'Bot', totalMs: 149_000, laps: [49_000, 50_000, 50_000], dnf: false };
      const lostBot = { userId: null, isBot: true, displayName: 'Bot2', totalMs: 0, laps: [], dnf: true };
      const r = submit({ results: [both[0], both[1], bot, lostBot] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.officialResults.map((x) => [x.rank, x.isBot, x.abandoned])).toEqual([
        [1, true, false], [2, false, false], [3, false, false], [4, true, true],
      ]);
      expect(Object.keys(r.data.rewards).sort()).toEqual([ALICE, BOB]);
      expect(stored('s1').flags.botSession).toBeUndefined();
      const ids = r.data.officialResults.map((x) => x.userId);
      expect(new Set(ids).size).toBe(4);
    });

    it('answers a repeated requestId with the same response and does not pay twice', () => {
      seed('s1', 'started');
      const first = JSON.parse(JSON.stringify(submit({ results: both }))) as Envelope<RsSubmitResultsOutput>;
      const wallet = { ...fake.wallets.get(ALICE) };
      const raw = rs_submit_results_impl(CTX, logger, nk, JSON.stringify({ serverKey: SECRET, serverId: SERVER, sessionId: 's1', requestId: 'req-1', results: both }));
      expect(JSON.parse(raw)).toEqual(first);
      expect({ ...fake.wallets.get(ALICE) }).toEqual(wallet);
      expect(first.ok && first.data.rewards[ALICE]?.coins).toBeGreaterThan(0);
      // Another requestId on the closed session is not a retry.
      const other = call(rs_submit_results_impl, { sessionId: 's1', requestId: 'req-other', results: both });
      expect([codeOf(other), reasonOf(other)]).toEqual(['CONFLICT', 'BAD_STATE']);
    });

    it('closes and pays a session that is still created, starting it implicitly', () => {
      seed('s1', 'created');
      const r = submit({ results: both });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Object.keys(r.data.rewards).sort()).toEqual([ALICE, BOB]);
      expect(r.data.rewards[ALICE]?.coins).toBeGreaterThan(0);
      const s = stored('s1');
      expect(s.state).toBe('closed');
      expect(s.startedAt).not.toBeNull();
      expect(serverSession()).toBeNull();
    });

    it('refuses a closed session and one of another server', () => {
      seed('s1', 'closed');
      expect(reasonOf(submit({ results: both }))).toBe('BAD_STATE');
      const other = call(rs_submit_results_impl, { serverId: OTHER_SERVER, sessionId: 's1', requestId: 'r', results: both });
      expect([codeOf(other), reasonOf(other)]).toEqual(['FORBIDDEN', 'NOT_ASSIGNED']);
      expect(codeOf(call(rs_submit_results_impl, { sessionId: 'nope', requestId: 'r', results: both }))).toBe('NOT_FOUND');
    });
  });

  describe('rs_session_release', () => {
    it('closes a created session as abandoned, without payments, and frees the server', () => {
      seed('s1', 'created');
      expect(call(rs_session_release_impl, { sessionId: 's1', reason: 'no_players' })).toEqual({ ok: true, data: { released: true } });
      const s = stored('s1');
      expect(s.state).toBe('closed');
      expect(s.results.every((r) => r.abandoned)).toBe(true);
      expect(fake.wallets.get(ALICE)).toBeUndefined();
      expect(serverSession()).toBeNull();
    });

    it('closes a started session as abandoned and frees the server', () => {
      seed('s1', 'started');
      expect(call(rs_session_release_impl, { sessionId: 's1', reason: 'server_error' }).ok).toBe(true);
      expect(stored('s1').state).toBe('closed');
      expect(stored('s1').results.every((r) => r.abandoned)).toBe(true);
      expect(serverSession()).toBeNull();
    });

    it('is idempotent and tolerates a session that is gone', () => {
      seed('s1', 'started');
      expect(call(rs_session_release_impl, { sessionId: 's1', reason: 'x' }).ok).toBe(true);
      expect(call(rs_session_release_impl, { sessionId: 's1', reason: 'x' })).toEqual({ ok: true, data: { released: true } });
      expect(call(rs_session_release_impl, { sessionId: 'gone', reason: 'x' })).toEqual({ ok: true, data: { released: true } });
    });

    it('refuses a session of another server and a reason that is not a string', () => {
      seed('s1', 'created');
      const other = call(rs_session_release_impl, { serverId: OTHER_SERVER, sessionId: 's1', reason: 'x' });
      expect([codeOf(other), reasonOf(other)]).toEqual(['FORBIDDEN', 'NOT_ASSIGNED']);
      expect(codeOf(call(rs_session_release_impl, { sessionId: 's1', reason: 5 }))).toBe('BAD_REQUEST');
      expect(stored('s1').state).toBe('created');
      expect(serverSession()).toBe('s1');
    });
  });
});
