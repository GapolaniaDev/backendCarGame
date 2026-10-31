// T-04 (plan fishnet-nakama-server) — race server registry: rs_heartbeat
// (D-02), input validation and the ticker release of silent servers.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeContext } from '../e2e/_stubs';
import type { IContext, ILogger, INakama } from '../../modules/src/nkruntime';
import { rs_heartbeat_impl } from '../../modules/src/race_servers/rpcs';
import { claimServer, listServers, readServer } from '../../modules/src/race_servers/registry_repo';
import { RACE_SERVER_STALE_MS } from '../../modules/src/race_servers/types';
import { createSession } from '../../modules/src/race/session_repo';
import type { RaceSession, RaceState } from '../../modules/src/race/types';
import { runServiceTick, type ServiceTickerState } from '../../modules/src/scheduler/service_ticker';
import { ensureRuntimeState } from '../../modules/src/core/runtime_state';

const SECRET = 'a-long-random-secret';
const CTX: IContext = { ...FakeContext, env: { RACE_SERVER_SECRET: SECRET } } as IContext;

function makeLogger(): ILogger & { warns: string[] } {
  const warns: string[] = [];
  const logger = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (f: string) => { warns.push(f); },
    error: () => {},
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  };
  return logger as unknown as ILogger & { warns: string[] };
}

function heartbeatBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    serverKey: SECRET,
    serverId: 'srv-1',
    host: '10.0.0.5',
    port: 7770,
    capacity: 1,
    activeSessionId: null,
    buildVersion: '0.1.0',
    ...over,
  });
}

function sessionIn(state: RaceState, id: string): RaceSession {
  return {
    schemaVersion: 1,
    id,
    matchId: id,
    mode: 'private',
    trackId: 'neon_blvd',
    size: 1,
    roster: [{ userId: 'p1', loadout: { classId: 'D', bodyId: 'starter_viper' }, isBot: false }],
    host: 'p1',
    hostSuccession: ['p1'],
    state,
    results: [],
    flags: { needsReview: false },
    version: 1,
  };
}

function errorCodeOf(serialized: string): string {
  return (JSON.parse(serialized) as { error: { code: string } }).error.code;
}

describe('rs_heartbeat (D-02)', () => {
  let fake: FakeNakama;
  let nk: INakama;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = makeLogger();
  });

  it('registers a new server and answers assignment null', () => {
    const before = Date.now();
    const out = JSON.parse(rs_heartbeat_impl(CTX, logger, nk, heartbeatBody())) as { ok: boolean; data: { assignment: unknown } };
    expect(out.ok).toBe(true);
    expect(out.data.assignment).toBeNull();
    const row = readServer(nk, 'srv-1')!.record;
    expect(row).toMatchObject({ host: '10.0.0.5', port: 7770, capacity: 1, sessionId: null, buildVersion: '0.1.0' });
    expect(row.lastSeenMs).toBeGreaterThanOrEqual(before);
  });

  it('a second heartbeat updates the same row (address, capacity, lastSeenMs)', () => {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody());
    const first = readServer(nk, 'srv-1')!;
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ host: '10.0.0.9', port: 7771, capacity: 2, buildVersion: '0.2.0' }));
    const second = readServer(nk, 'srv-1')!;
    expect(second.record).toMatchObject({ host: '10.0.0.9', port: 7771, capacity: 2, buildVersion: '0.2.0' });
    expect(second.record.lastSeenMs).toBeGreaterThanOrEqual(first.record.lastSeenMs);
    expect(second.version).not.toBe(first.version);
    expect(listServers(nk)).toHaveLength(1);
  });

  it('rejects bad auth before touching storage', () => {
    const noSecret = { ...FakeContext, env: {} } as IContext;
    expect(errorCodeOf(rs_heartbeat_impl(noSecret, logger, nk, heartbeatBody()))).toBe('SERVICE_UNAVAILABLE');
    expect(errorCodeOf(rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ serverKey: 'bad' })))).toBe('FORBIDDEN');
    expect(listServers(nk)).toHaveLength(0);
  });

  it('validates the input', () => {
    const bad: Array<Record<string, unknown>> = [
      { serverId: '' },
      { serverId: 'has space' },
      { serverId: 'x'.repeat(65) },
      { host: '' },
      { host: 5 },
      { port: 0 },
      { port: 65536 },
      { port: 80.5 },
      { port: '7770' },
      { capacity: 0 },
      { capacity: 17 },
      { activeSessionId: '' },
      { activeSessionId: 3 },
    ];
    for (const over of bad) {
      expect(errorCodeOf(rs_heartbeat_impl(CTX, logger, nk, heartbeatBody(over)))).toBe('BAD_REQUEST');
    }
    expect(errorCodeOf(rs_heartbeat_impl(CTX, logger, nk, 'not json'))).toBe('BAD_REQUEST');
    expect(listServers(nk)).toHaveLength(0);
    // Boundaries are accepted.
    expect(JSON.parse(rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ port: 65535, capacity: 16, serverId: 'x'.repeat(64) }))).ok).toBe(true);
    expect(JSON.parse(rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ port: 1, capacity: 1 }))).ok).toBe(true);
  });

  function assign(sessionId: string): void {
    const entry = listServers(nk)[0]!;
    expect(claimServer(nk, entry, sessionId, Date.now())).toBe(true);
  }

  it('frees a server whose registered session is closed when it declares none', () => {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody());
    createSession(nk, sessionIn('closed', 's-closed'));
    assign('s-closed');
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ activeSessionId: null }));
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBeNull();
  });

  it('frees a server whose registered session does not exist', () => {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody());
    assign('s-missing');
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ activeSessionId: null }));
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBeNull();
  });

  it('keeps the assignment while the session is still open', () => {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody());
    createSession(nk, sessionIn('created', 's-open'));
    assign('s-open');
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ activeSessionId: null }));
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBe('s-open');
  });

  it('adds joinRemainingMs to the assignment: within 0..30000 inside the window, 0 after it', () => {
    type Out = { data: { assignment: { joinDeadlineMs: number; joinRemainingMs: number } } };
    const remainingFor = (ageMs: number): Out['data']['assignment'] => {
      const localNk = new FakeNakama().nakama;
      rs_heartbeat_impl(CTX, logger, localNk, heartbeatBody());
      createSession(localNk, {
        ...sessionIn('created', 's-hosted'),
        createdAt: Date.now() - ageMs,
        serverHosted: true,
        server: { serverId: 'srv-1', host: '10.0.0.5', port: 7770 },
      });
      expect(claimServer(localNk, listServers(localNk)[0]!, 's-hosted', Date.now())).toBe(true);
      return (JSON.parse(rs_heartbeat_impl(CTX, logger, localNk, heartbeatBody())) as Out).data.assignment;
    };

    const fresh = remainingFor(10_000);
    expect(fresh.joinRemainingMs).toBeGreaterThan(0);
    expect(fresh.joinRemainingMs).toBeLessThanOrEqual(20_000);
    expect(remainingFor(0).joinRemainingMs).toBeLessThanOrEqual(30_000);
    expect(remainingFor(40_000).joinRemainingMs).toBe(0);
  });

  it('keeps the assignment when the server declares an active session', () => {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody());
    assign('s-missing');
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ activeSessionId: 's-missing' }));
    expect(readServer(nk, 'srv-1')!.record.sessionId).toBe('s-missing');
  });
});

describe('ticker release of silent servers (D-02)', () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
  let fake: FakeNakama;
  let nk: INakama;
  let logger: ReturnType<typeof makeLogger>;
  let state: ServiceTickerState;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = makeLogger();
    ensureRuntimeState(nk, logger);
    state = { lastTournamentMs: NOW, lastEventMs: NOW, lastSubscriptionMs: NOW, lastRaceCloseMs: 0, lastPassSeasonMs: NOW, lastClubWeekMs: NOW, runs: 0, nextAttemptMs: 0 };
  });

  function seed(serverId: string, lastSeenMs: number, sessionId: string | null): void {
    rs_heartbeat_impl(CTX, logger, nk, heartbeatBody({ serverId }));
    const entry = listServers(nk).find((e) => e.serverId === serverId)!;
    const row = { ...entry.record, lastSeenMs, sessionId };
    fake.nakama.storageWrite([{
      collection: 'race_servers', key: serverId, userId: '00000000-0000-0000-0000-000000000000',
      value: row, version: entry.version, permissionRead: 0, permissionWrite: 0,
    }]);
  }

  it('frees only servers with a session and a heartbeat older than 30 s', () => {
    seed('silent', NOW - RACE_SERVER_STALE_MS - 1, 's-1');
    seed('fresh', NOW - RACE_SERVER_STALE_MS + 1_000, 's-2');
    seed('idle-old', NOW - 120_000, null);
    const r = runServiceTick(nk, logger, state, NOW, 'match:t');
    expect(r.raceServers).toBe('freed=1');
    expect(readServer(nk, 'silent')!.record.sessionId).toBeNull();
    expect(readServer(nk, 'fresh')!.record.sessionId).toBe('s-2');
    expect(readServer(nk, 'idle-old')!.record.sessionId).toBeNull();
    expect(logger.warns.some((w) => w.includes('without heartbeat'))).toBe(true);
  });

  it('a second pass frees nothing more', () => {
    seed('silent', NOW - 60_000, 's-1');
    runServiceTick(nk, logger, state, NOW, 'match:t');
    const again = runServiceTick(nk, logger, state, NOW + 15_000, 'match:t');
    expect(again.raceServers).toBe('freed=0');
  });
});
