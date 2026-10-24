// T-05 (plan fishnet-nakama-server) — matchmaking of groups that race on a
// dedicated server: ticket params (D-03), group validation (D-03), server
// reservation, join tickets and laps (D-04) and the no-server case (D-06).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeContext, SYSTEM_USER_ID } from '../e2e/_stubs';
import type { IContext, ILogger, IMatchmakerResult, INakama } from '../../modules/src/nkruntime';
import { matchmakerMatchedImpl } from '../../modules/src/matchmaking/rpcs';
import {
  buildOutput,
  buildTicket,
  validateTicketInput,
} from '../../modules/src/matchmaking/ticket_params';
import {
  candidateFromMatches,
  validateCandidate,
} from '../../modules/src/matchmaking/matched_hook';
import { getRankedConfig } from '../../modules/src/ranked/config';
import { ensureRuntimeState } from '../../modules/src/core/runtime_state';
import { rs_heartbeat_impl } from '../../modules/src/race_servers/rpcs';
import { listServers, readServer } from '../../modules/src/race_servers/registry_repo';
import { RACE_SERVER_ALIVE_MS } from '../../modules/src/race_servers/types';
import { getTrack } from '../../modules/src/core/catalog';
import type { RaceSession } from '../../modules/src/race/types';

const SECRET = 'a-long-random-secret';
const CTX: IContext = { ...FakeContext, env: { RACE_SERVER_SECRET: SECRET } } as IContext;
const OPTIONS = { version: '1.0.0', region: 'eu-west-1' };

function makeLogger(): ILogger & { lines: string[] } {
  const lines: string[] = [];
  const log = (f: string, ...args: unknown[]): void => { lines.push([f, ...args.map(String)].join(' ')); };
  const logger = {
    lines,
    debug: () => {},
    info: () => {},
    warn: log,
    error: log,
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  };
  return logger as unknown as ILogger & { lines: string[] };
}

function heartbeat(nk: INakama, logger: ILogger, serverId: string, over: Record<string, unknown> = {}): void {
  const body = JSON.stringify({
    serverKey: SECRET, serverId, host: `host-${serverId}`, port: 7770, capacity: 1,
    activeSessionId: null, buildVersion: '0.1.0', ...over,
  });
  const out = JSON.parse(rs_heartbeat_impl(CTX, logger, nk, body)) as { ok: boolean };
  expect(out.ok).toBe(true);
}

/** Overwrites fields of the registry row of `serverId` (test setup of liveness / assignment). */
function patchServer(nk: INakama, serverId: string, patch: Record<string, unknown>): void {
  const cur = readServer(nk, serverId)!;
  nk.storageWrite([{
    collection: 'race_servers', key: serverId, userId: SYSTEM_USER_ID,
    value: { ...cur.record, ...patch }, version: cur.version, permissionRead: 0, permissionWrite: 0,
  }]);
}

function entries(n: number, props: Record<string, string>, prefix = 'user'): IMatchmakerResult[] {
  return Array.from({ length: n }, (_, i) => ({
    properties: { mode: 'quick', size: '4', version: '1.0.0', region: 'eu-west-1', segmentBy: 'none', rtt: String(40 + i * 5), ...props },
    presence: { userId: `${prefix}-${i}`, sessionId: `sock-${prefix}-${i}`, username: `${prefix}-${i}`, node: 'test' },
  } as unknown as IMatchmakerResult));
}

function sessionOf(nk: INakama, userId: string): RaceSession | null {
  const pointer = nk.storageRead([{ collection: 'race_active', key: userId, userId: SYSTEM_USER_ID }])[0];
  const sid = (pointer?.value as { sessionId?: string } | undefined)?.sessionId;
  if (sid === undefined) return null;
  return nk.storageRead([{ collection: 'race_sessions', key: sid, userId: SYSTEM_USER_ID }])[0]!.value as unknown as RaceSession;
}

const DEDICATED = { hosting: 'dedicated' };

describe('mm_ticket_params with hosting dedicated (D-03)', () => {
  beforeEach(() => { ensureRuntimeState(new FakeNakama().nakama, makeLogger()); });

  it('stamps size 4 and returns minCount 2 / maxCount 4', () => {
    const v = validateTicketInput({ mode: 'quick', hosting: 'dedicated' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, OPTIONS, getRankedConfig());
    const out = buildOutput(v, ticket, OPTIONS);
    expect(out).toMatchObject({ mode: 'quick', size: 4, hosting: 'dedicated', minCount: 2, maxCount: 4 });
    expect(ticket.query['hosting']).toBe('dedicated');
    expect(ticket.query['size']).toBe(4);
    expect(ticket.metadata['hosting']).toBe('dedicated');
    expect(ticket.metadata['size']).toBe('4');
  });

  it('ignores the requested size', () => {
    const v = validateTicketInput({ mode: 'quick', size: 2, hosting: 'dedicated' });
    expect(v).toMatchObject({ ok: true, size: 4 });
  });

  it('a ticket without hosting is unchanged: no hosting, minCount or maxCount', () => {
    const v = validateTicketInput({ mode: 'quick', size: 6 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const ticket = buildTicket(v, OPTIONS, getRankedConfig());
    const out = buildOutput(v, ticket, OPTIONS);
    expect(out.size).toBe(6);
    expect(out).not.toHaveProperty('hosting');
    expect(out).not.toHaveProperty('minCount');
    expect(out).not.toHaveProperty('maxCount');
    expect(ticket.query).not.toHaveProperty('hosting');
    expect(ticket.metadata).not.toHaveProperty('hosting');
  });

  it('is only for quick mode and only the value "dedicated"', () => {
    expect(validateTicketInput({ mode: 'ranked', hosting: 'dedicated' }).ok).toBe(false);
    expect(validateTicketInput({ mode: 'private', hosting: 'dedicated' }).ok).toBe(false);
    expect(validateTicketInput({ mode: 'quick', hosting: 'relay' as 'dedicated' }).ok).toBe(false);
  });
});

describe('validateCandidate for dedicated groups (D-03)', () => {
  const candidate = (n: number, props: Record<string, string>) => candidateFromMatches('sid', entries(n, props));

  it('accepts 2, 3 and 4 players', () => {
    for (const n of [2, 3, 4]) expect(validateCandidate(candidate(n, DEDICATED))).toBeNull();
  });

  it('rejects 1 and 5 players', () => {
    expect(validateCandidate(candidate(1, DEDICATED))).not.toBeNull();
    expect(validateCandidate(candidate(5, DEDICATED))).not.toBeNull();
  });

  it('keeps the 2/4/6 rule for a group that is not dedicated: 3 is rejected', () => {
    expect(validateCandidate(candidate(3, {}))).not.toBeNull();
    expect(validateCandidate(candidate(4, {}))).toBeNull();
  });

  it('rejects dedicated outside quick mode and groups that mix hosting', () => {
    expect(validateCandidate(candidate(3, { ...DEDICATED, mode: 'ranked' }))).not.toBeNull();
    const mixed = candidate(3, DEDICATED);
    delete (mixed.tickets[1]!.metadata as Record<string, string>)['hosting'];
    expect(validateCandidate(mixed)).toMatch(/hosting mismatch/);
  });
});

describe('matchmakerMatched with a dedicated group (D-04, D-06)', () => {
  let fake: FakeNakama;
  let nk: INakama;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = makeLogger();
    ensureRuntimeState(nk, logger);
  });

  function runHook(n: number, props: Record<string, string> = DEDICATED, prefix = 'user'): void {
    matchmakerMatchedImpl(FakeContext, logger, nk, entries(n, props, prefix));
  }

  it('a group of 3 gets a session with server, laps and 3 distinct join tickets', () => {
    heartbeat(nk, logger, 'srv-1', { port: 7771 });
    runHook(3);

    const session = sessionOf(nk, 'user-0')!;
    expect(session).not.toBeNull();
    expect(session.serverHosted).toBe(true);
    expect(session.server).toEqual({ serverId: 'srv-1', host: 'host-srv-1', port: 7771 });
    expect(session.laps).toBe(getTrack(session.trackId, nk)!.modes.quick);
    expect(session.state).toBe('created');
    expect(session.roster).toHaveLength(3);
    const tickets = session.roster.map((e) => e.joinTicket);
    for (const t of tickets) expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(tickets).size).toBe(3);
    for (let i = 0; i < 3; i += 1) expect(sessionOf(nk, `user-${i}`)!.id).toBe(session.id);

    const row = readServer(nk, 'srv-1')!.record;
    expect(row.sessionId).toBe(session.id);
    expect(row.assignedAtMs).toBeGreaterThan(0);
  });

  it('with no registered server nothing is created and a warning is logged (D-06)', () => {
    runHook(3);
    expect(sessionOf(nk, 'user-0')).toBeNull();
    expect(logger.lines.some((l) => l.startsWith('matchmaker: no free race server'))).toBe(true);
  });

  it('servers that are busy or silent are not free', () => {
    heartbeat(nk, logger, 'busy');
    patchServer(nk, 'busy', { sessionId: 'other-session' });
    heartbeat(nk, logger, 'silent');
    patchServer(nk, 'silent', { lastSeenMs: Date.now() - RACE_SERVER_ALIVE_MS - 1_000 });
    runHook(2);
    expect(sessionOf(nk, 'user-0')).toBeNull();
    expect(readServer(nk, 'busy')!.record.sessionId).toBe('other-session');
    expect(readServer(nk, 'silent')!.record.sessionId).toBeNull();
  });

  it('picks the free server with the most recent heartbeat', () => {
    heartbeat(nk, logger, 'older');
    patchServer(nk, 'older', { lastSeenMs: Date.now() - 5_000 });
    heartbeat(nk, logger, 'newest');
    runHook(2);
    expect(sessionOf(nk, 'user-0')!.server!.serverId).toBe('newest');
    expect(readServer(nk, 'older')!.record.sessionId).toBeNull();
  });

  it('two groups never share a server: the second takes the next free one, then none', () => {
    heartbeat(nk, logger, 'srv-a');
    heartbeat(nk, logger, 'srv-b');
    runHook(2, DEDICATED, 'first');
    runHook(2, DEDICATED, 'second');
    runHook(2, DEDICATED, 'third');
    const first = sessionOf(nk, 'first-0')!;
    const second = sessionOf(nk, 'second-0')!;
    expect(new Set([first.server!.serverId, second.server!.serverId]).size).toBe(2);
    expect(sessionOf(nk, 'third-0')).toBeNull();
    expect(listServers(nk).every((s) => s.record.sessionId !== null)).toBe(true);
  });

  it('a lost CAS (a heartbeat landed meanwhile) is retried on the refreshed row', () => {
    heartbeat(nk, logger, 'srv-1');
    const realUpdate = nk.multiUpdate.bind(nk);
    let calls = 0;
    nk.multiUpdate = ((...args: Parameters<INakama['multiUpdate']>) => {
      calls += 1;
      if (calls === 1) heartbeat(nk, logger, 'srv-1'); // bumps the row version before the claim lands
      return realUpdate(...args);
    }) as INakama['multiUpdate'];
    runHook(2);
    expect(calls).toBe(2);
    expect(sessionOf(nk, 'user-0')!.server!.serverId).toBe('srv-1');
    expect(readServer(nk, 'srv-1')!.record.sessionId).not.toBeNull();
  });

  it('a failed write that is not a lost race is not swallowed and leaves the server free', () => {
    heartbeat(nk, logger, 'srv-1');
    nk.multiUpdate = (() => { throw new Error('storage down'); }) as INakama['multiUpdate'];
    runHook(2);
    expect(logger.lines.some((l) => l.includes('race session not created'))).toBe(true);
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBeNull();
    expect(sessionOf(nk, 'user-0')).toBeNull();
  });

  it('a group that is not dedicated never touches the registry and carries no server fields', () => {
    heartbeat(nk, logger, 'srv-1');
    runHook(4, {});
    const session = sessionOf(nk, 'user-0')!;
    expect(session.serverHosted).toBeUndefined();
    expect(session.server).toBeUndefined();
    expect(session.roster.every((e) => e.joinTicket === undefined)).toBe(true);
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBeNull();
  });

  it('a non-dedicated group of 3 is rejected as before', () => {
    heartbeat(nk, logger, 'srv-1');
    runHook(3, {});
    expect(sessionOf(nk, 'user-0')).toBeNull();
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBeNull();
  });
});
