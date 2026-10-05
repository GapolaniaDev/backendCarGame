// End-to-end tests for the Chunk 5 race RPCs.
//
// Loads the built bundle (`modules/index.js`) once per test in an isolated
// VM context with stub nk/logger/initializer, then drives the registered
// RPC functions directly. Reused by Chunks 6-9 as we add join/start/submit.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadBundleForTest,
  FakeContext,
  SYSTEM_USER_ID,
} from './_stubs';
import type { RpcFunction } from '../../modules/src/nkruntime';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

interface CreatePayload {
  matchId: string;
  mode: 'quick' | 'ranked' | 'private' | 'time_trial';
  trackId: string;
  size: 1 | 2 | 4 | 6;
  hostLoadout: { classId: 'D' | 'C' | 'B' | 'A' | 'S'; bodyId: string };
  hostUserId: string;
}

interface CreateData {
  sessionId: string;
  rosterVersion: number;
  hostSuccession: string[];
}

interface GetData {
  session: {
    id: string;
    matchId: string;
    mode: string;
    trackId: string;
    state: string;
    host: string;
    roster: Array<{ userId: string }>;
    startedAt: number | null;
  };
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  key: string,
  userId: string | null,
  payload: object | string,
): Envelope<T> {
  const handler = env.resolver(key);
  expect(handler).toBeDefined();
  const ctx = userId === null
    ? FakeContext
    : { ...FakeContext, userId };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = handler!(ctx, env.logger, env.nak, body);
  return JSON.parse(result) as Envelope<T>;
}

describe('race_lifecycle (Chunk 5)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  function makeCreatePayload(overrides: Partial<CreatePayload> = {}): CreatePayload {
    return {
      matchId: 'match-test-1',
      mode: 'time_trial',
      trackId: 'neon_blvd',
      size: 1,
      hostLoadout: { classId: 'C', bodyId: 'charger' },
      hostUserId: HOST_ID,
      ...overrides,
    };
  }

  describe('race_session_create', () => {
    it('returns sessionId, rosterVersion=1, hostSuccession=[host]', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      expect(env2.ok).toBe(true);
      if (!env2.ok) return;
      expect(env2.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(env2.data.rosterVersion).toBe(1);
      expect(env2.data.hostSuccession).toEqual([HOST_ID]);
    });

    it('persists the session in storage with state=created, startedAt=null', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      expect(env2.ok).toBe(true);
      if (!env2.ok) return;

      const read = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: env2.data.sessionId,
        callerUserId: HOST_ID,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.session.state).toBe('created');
      expect(read.data.session.startedAt).toBeNull();
      expect(read.data.session.host).toBe(HOST_ID);
      expect(read.data.session.roster).toHaveLength(1);
      expect(read.data.session.roster[0]?.userId).toBe(HOST_ID);
    });

    it('rejects invalid mode with BAD_REQUEST', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'garbage' as never }));
      expect(env2.ok).toBe(false);
      if (env2.ok) return;
      expect(env2.error.code).toBe('BAD_REQUEST');
      expect(env2.error.message).toMatch(/mode/);
    });

    it('rejects unknown trackId with BAD_REQUEST', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ trackId: 'atlantis' }));
      expect(env2.ok).toBe(false);
      if (env2.ok) return;
      expect(env2.error.code).toBe('BAD_REQUEST');
      expect(env2.error.message).toMatch(/unknown trackId/);
    });

    it('rejects size not allowed for mode with CONFLICT', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'ranked', size: 6 }));
      expect(env2.ok).toBe(false);
      if (env2.ok) return;
      expect(env2.error.code).toBe('CONFLICT');
      expect(env2.error.details).toMatchObject({ mode: 'ranked', size: 6, allowedSizes: [4] });
    });

    it('rejects missing hostUserId in HTTP gateway mode with BAD_REQUEST', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, {
        matchId: 'm',
        mode: 'quick',
        trackId: 'neon_blvd',
        size: 4,
        hostLoadout: { classId: 'C', bodyId: 'c' },
      });
      expect(env2.ok).toBe(false);
      if (env2.ok) return;
      expect(env2.error.code).toBe('BAD_REQUEST');
      expect(env2.error.message).toMatch(/hostUserId/);
    });

    it('prefers ctx.userId over payload.hostUserId (socket call)', () => {
      const env2 = call<CreateData>(env, 'race_session_create', HOST_ID, {
        ...makeCreatePayload(),
        hostUserId: OTHER_ID, // would be ignored
      });
      expect(env2.ok).toBe(true);
      if (!env2.ok) return;
      const read = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: env2.data.sessionId,
        callerUserId: HOST_ID,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.session.host).toBe(HOST_ID);
    });
  });

  describe('race_session_get', () => {
    it('returns NOT_FOUND for a caller not in the roster', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      expect(env2.ok).toBe(true);
      if (!env2.ok) return;
      const read = call<GetData>(env, 'race_session_get', OTHER_ID, {
        sessionId: env2.data.sessionId,
        callerUserId: OTHER_ID,
      });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND for a nonexistent sessionId', () => {
      const read = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: 'does-not-exist',
        callerUserId: HOST_ID,
      });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when sessionId is omitted', () => {
      const read = call<GetData>(env, 'race_session_get', HOST_ID, { callerUserId: HOST_ID });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('NOT_FOUND');
    });

    it('returns the same session to the host', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!env2.ok) throw new Error('create failed');
      const read = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: env2.data.sessionId,
        callerUserId: HOST_ID,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.data.session.id).toBe(env2.data.sessionId);
      expect(read.data.session.state).toBe('created');
    });
  });

  describe('config_get', () => {
    it('returns the catalogs and server time', () => {
      const cfg = env.resolver('config_get') as RpcFunction | undefined;
      expect(cfg).toBeDefined();
      const result = JSON.parse(cfg!(FakeContext, env.logger, env.nak, ''));
      expect(result.ok).toBe(true);
      expect((result.data as { catalogsHash: string }).catalogsHash).toMatch(/^[0-9a-f]{12}/);
      expect((result.data as { tracks: unknown[] }).tracks).toHaveLength(6);
      expect((result.data as { modes: unknown[] }).modes).toHaveLength(4);
      expect(typeof (result.data as { serverTimeMs: number }).serverTimeMs).toBe('number');
      expect((result.data as { minClientVersion: string }).minClientVersion).toBe('1.0.0');
    });
  });

  describe('race_session_join', () => {
    function joinPayload(
      sessionId: string,
      joinerId: string,
      callerId: string,
      overrides: Partial<{ loadout: { classId: 'D' | 'C' | 'B' | 'A' | 'S'; bodyId: string } }> = {},
    ): Record<string, unknown> {
      return {
        sessionId,
        userId: joinerId,
        callerUserId: callerId,
        loadout: { classId: 'B', bodyId: 'coupe', ...overrides.loadout },
      };
    }

    it('appends to the roster and bumps rosterVersion + rosterSize', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'quick', size: 4 }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;

      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        joinPayload(sid, OTHER_ID, OTHER_ID),
      );
      expect(joinEnv.ok).toBe(true);
      if (!joinEnv.ok) return;
      expect(joinEnv.data.rosterVersion).toBe(2);
      expect(joinEnv.data.rosterSize).toBe(2);

      const readEnv = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!readEnv.ok) throw new Error('read failed');
      expect(readEnv.data.session.roster).toHaveLength(2);
      expect(readEnv.data.session.roster.map((r) => r.userId)).toEqual([HOST_ID, OTHER_ID]);
    });

    it('rejects joining a session that does not exist (NOT_FOUND)', () => {
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        joinPayload('does-not-exist', OTHER_ID, OTHER_ID),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('NOT_FOUND');
    });

    it('rejects duplicate join (CONFLICT)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      // host tries to join again
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        HOST_ID,
        joinPayload(sid, HOST_ID, HOST_ID),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('CONFLICT');
      expect(joinEnv.error.message).toMatch(/already in the roster/);
    });

    it('rejects joiner when callerUserId !== userId (HTTP FORBIDDEN)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      // someone tries to make OTHER_ID join by impersonating them
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        joinPayload(sid, OTHER_ID, '33333333-3333-4333-8333-333333333333'),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('FORBIDDEN');
    });

    it('rejects joiner when ctx.userId !== callerUserId (socket FORBIDDEN)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      // ctx.userId says HOST, payload says OTHER_ID — defense against a socket client
      // claiming to be someone else.
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        HOST_ID,
        joinPayload(sid, OTHER_ID, OTHER_ID),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('FORBIDDEN');
    });

    it('rejects join when capacity reached (CONFLICT)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ size: 1 }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        joinPayload(sid, OTHER_ID, OTHER_ID),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('CONFLICT');
      expect(joinEnv.error.message).toMatch(/roster is full/);
    });

    it('rejects join after the session has been started (CONFLICT)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!startEnv.ok) throw new Error('start failed');
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env,
        'race_session_join',
        null,
        joinPayload(sid, OTHER_ID, OTHER_ID),
      );
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('CONFLICT');
      expect(joinEnv.error.message).toMatch(/state started/);
    });

    it('rejects missing loadout (BAD_REQUEST)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const joinEnv = call<unknown>(env, 'race_session_join', null, {
        sessionId: sid,
        userId: OTHER_ID,
        callerUserId: OTHER_ID,
      });
      expect(joinEnv.ok).toBe(false);
      if (joinEnv.ok) return;
      expect(joinEnv.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('race_session_start', () => {
    it('host transitions to started and stamps startedAt', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'quick', size: 4 }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      expect(startEnv.ok).toBe(true);
      if (!startEnv.ok) return;
      expect(typeof startEnv.data.startedAt).toBe('number');
      expect(startEnv.data.startedAt).toBeGreaterThan(0);

      const readEnv = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!readEnv.ok) throw new Error('read failed');
      expect(readEnv.data.session.state).toBe('started');
      expect(readEnv.data.session.startedAt).toBe(startEnv.data.startedAt);
    });

    it('rejects non-host caller (FORBIDDEN)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', null, {
        sessionId: sid,
        callerUserId: OTHER_ID,
      });
      expect(startEnv.ok).toBe(false);
      if (startEnv.ok) return;
      expect(startEnv.error.code).toBe('FORBIDDEN');
      expect(startEnv.error.message).toMatch(/host/);
    });

    it('rejects a second start (CONFLICT)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const first = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      expect(first.ok).toBe(true);
      const second = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('CONFLICT');
      expect(second.error.message).toMatch(/state started/);
    });

    it('rejects start for nonexistent session (NOT_FOUND)', () => {
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: 'does-not-exist',
        callerUserId: HOST_ID,
      });
      expect(startEnv.ok).toBe(false);
      if (startEnv.ok) return;
      expect(startEnv.error.code).toBe('NOT_FOUND');
    });
  });

  describe('race_session_get (lastClosed path)', () => {
    it('returns NOT_FOUND when sessionId is omitted and lastClosed index is empty', () => {
      const readEnv = call<unknown>(env, 'race_session_get', HOST_ID, {
        callerUserId: HOST_ID,
      });
      expect(readEnv.ok).toBe(false);
      if (readEnv.ok) return;
      expect(readEnv.error.code).toBe('NOT_FOUND');
      expect(readEnv.error.message).toMatch(/lastClosed/);
    });

    it('returns NOT_FOUND when sessionId is omitted (no caller — HTTP gateway)', () => {
      const readEnv = call<unknown>(env, 'race_session_get', null, {
        callerUserId: '00000000-0000-0000-0000-000000000000',
      });
      expect(readEnv.ok).toBe(false);
      if (readEnv.ok) return;
      expect(readEnv.error.code).toBe('NOT_FOUND');
    });
  });

  describe('create → join ×3 → start happy path', () => {
    it('produces a session with 4 entries, state=started, startedAt set', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'quick', size: 4 }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;

      const joinerIds = [
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ];
      for (const jid of joinerIds) {
        const r = call<{ rosterVersion: number; rosterSize: number }>(
          env,
          'race_session_join',
          null,
          {
            sessionId: sid,
            userId: jid,
            callerUserId: jid,
            loadout: { classId: 'C', bodyId: 'coupe' },
          },
        );
        expect(r.ok).toBe(true);
      }

      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      expect(startEnv.ok).toBe(true);

      const readEnv = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!readEnv.ok) throw new Error('read failed');
      expect(readEnv.data.session.roster).toHaveLength(4);
      expect(readEnv.data.session.state).toBe('started');
      expect(readEnv.data.session.startedAt).not.toBeNull();
      expect(readEnv.data.session.version).toBe(5); // create=1, +3 joins=4, +start=5
    });
  });

  describe('storage sanity', () => {
    it('writes race_sessions collection only (no leaks into other collections)', () => {
      const env2 = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      expect(env2.ok).toBe(true);
      if (!env2.ok) return;
      const allKeys = Array.from(env.fakeNakama.store.keys());
      const ours = allKeys.filter((k) => k.startsWith('race_sessions/'));
      expect(ours).toHaveLength(1);
      expect(ours[0]).toContain(env2.data.sessionId);
    });

    it('uses the system userId as owner (clients cannot read directly)', () => {
      call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      const sysKey = Array.from(env.fakeNakama.store.keys()).find((k) =>
        k.includes('/' + SYSTEM_USER_ID),
      );
      expect(sysKey).toBeDefined();
    });
  });

  describe('race_submit_result (Chunk 7: step-1 + idempotency)', () => {
    const PLAYER_A = '22222222-2222-4222-8222-222222222222';

    /**
     * Helper: create + join PLAYER_A + start the session. Returns the
     * sessionId for further calls.
     */
    function setupStartedSession(
      size: 1 | 2 | 4 | 6 = 4,
      mode: 'quick' | 'ranked' | 'private' | 'time_trial' = 'quick',
      opts: { overrideStartedAtMs?: number } = {},
    ): string {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode, size }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      if (size > 1) {
        const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
          env, 'race_session_join', null,
          {
            sessionId: sid,
            userId: PLAYER_A,
            callerUserId: PLAYER_A,
            loadout: { classId: 'B', bodyId: 'coupe' },
          },
        );
        if (!joinEnv.ok) throw new Error('join failed');
      }
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!startEnv.ok) throw new Error('start failed');
      if (opts.overrideStartedAtMs !== undefined) {
        // Backdate startedAt so step-2 clock checks pass for reports
        // claiming a multi-minute totalMs.
        const storeKey = `race_sessions/${sid}/00000000-0000-0000-0000-000000000000`;
        const obj = env.fakeNakama.store.get(storeKey);
        if (obj) (obj.value as { startedAt: number }).startedAt = opts.overrideStartedAtMs;
      }
      return sid;
    }

    function makeReport(reporterId: string, totalMs = 120_000): Record<string, unknown> {
      // quick/neon_blvd = 3 laps; B class min = 40_000/lap → min total 120_000.
      // Default makeReport returns the threshold so step-2 (Chunk 8) passes.
      return {
        userId: reporterId,
        totalMs,
        laps: [40_000, 40_000, totalMs - 80_000],
        isBotReport: false,
      };
    }

    function submitPayload(sid: string, report: Record<string, unknown>, caller = PLAYER_A): string {
      return JSON.stringify({
        sessionId: sid,
        callerUserId: caller,
        report,
      });
    }

    it('accepts a valid report from a roster member and bumps the session version', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const submitEnv = call<{ accepted: true; confidence: string }>(
        env,
        'race_submit_result',
        null,
        submitPayload(sid, makeReport(PLAYER_A)),
      );
      expect(submitEnv.ok).toBe(true);
      if (!submitEnv.ok) return;
      expect(submitEnv.data.accepted).toBe(true);
      expect(submitEnv.data.confidence).toBe('client'); // placeholder until Chunk 9

      const readEnv = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!readEnv.ok) throw new Error('read failed');
      const entry = readEnv.data.session.roster.find((r) => r.userId === PLAYER_A);
      expect(entry?.reportedAt).toBeGreaterThan(0);
      expect(entry?.totalMs).toBe(120_000);
      expect(entry?.laps).toEqual([40_000, 40_000, 40_000]);
    });

    it('persists the report in the race_sessions/{sid}/reports/{userId} sub-key', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      call<{ accepted: true }>(
        env,
        'race_submit_result',
        null,
        submitPayload(sid, makeReport(PLAYER_A)),
      );
      const reportKey = `race_sessions/${sid}/reports/${PLAYER_A}/${PLAYER_A}`;
      expect(env.fakeNakama.store.has(reportKey)).toBe(true);
    });

    it('replays the cached response on retry with the same (sessionId, userId)', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const first = call<{ accepted: true }>(
        env,
        'race_submit_result',
        null,
        submitPayload(sid, makeReport(PLAYER_A, 120_000)),
      );
      expect(first.ok).toBe(true);
      // Replay with the SAME totalMs should return cached (idempotent).
      const replay = call<{ accepted: true }>(
        env,
        'race_submit_result',
        null,
        submitPayload(sid, makeReport(PLAYER_A, 120_000)),
      );
      expect(replay.ok).toBe(true);
      // Even with a different totalMs the cache wins — that's the point
      // of idempotency on the (sessionId, userId) key.
      const replay2 = call<{ accepted: true }>(
        env,
        'race_submit_result',
        null,
        submitPayload(sid, makeReport(PLAYER_A, 130_000)),
      );
      expect(replay2.ok).toBe(true);
      // Session version bumped exactly once (cache prevented the second).
      const readEnv = call<GetData>(env, 'race_session_get', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!readEnv.ok) throw new Error('read failed');
      const entry = readEnv.data.session.roster.find((r) => r.userId === PLAYER_A);
      expect(entry?.totalMs).toBe(120_000);
    });

    it('rejects an out-of-roster submission (INVALID_RESULT)', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const OUTSIDER = '99999999-9999-4999-8999-999999999999';
      const submitEnv = call<unknown>(env, 'race_submit_result', null, submitPayload(sid, makeReport(OUTSIDER), OUTSIDER));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('INVALID_RESULT');
    });

    it('rejects a duplicate submission with CONFLICT / ALREADY_REPORTED', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      // First submission — clear the cache key after writing so the
      // duplicate test doesn't hit idempotency. Easiest: delete the
      // cache entry directly.
      const first = call<{ accepted: true }>(
        env, 'race_submit_result', null, submitPayload(sid, makeReport(PLAYER_A)),
      );
      expect(first.ok).toBe(true);
      env.fakeNakama.cache.delete('submit_result:' + sid + ':' + PLAYER_A);
      const second = call<unknown>(env, 'race_submit_result', null, submitPayload(sid, makeReport(PLAYER_A, 130_000)));
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('CONFLICT');
      expect((second.error.details as { reason?: string }).reason).toBe('ALREADY_REPORTED');
    });

    it('rejects a submission to a session in created state (CONFLICT / BAD_STATE)', () => {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload());
      if (!createEnv.ok) throw new Error('create failed');
      // No start — session is in created. The HOST is in the roster,
      // so we can use HOST as both caller and reporter.
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(createEnv.data.sessionId, makeReport(HOST_ID), HOST_ID));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('CONFLICT');
      expect((submitEnv.error.details as { reason?: string }).reason).toBe('BAD_STATE');
    });

    it('rejects a submission to a nonexistent session (NOT_FOUND)', () => {
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload('does-not-exist', makeReport(PLAYER_A)));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('NOT_FOUND');
    });

    it('rejects mismatched callerUserId vs report.userId (FORBIDDEN)', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, makeReport('44444444-4444-4444-8444-444444444444'), PLAYER_A));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('FORBIDDEN');
    });

    it('rejects ctx.userId != callerUserId on socket calls (FORBIDDEN)', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const submitEnv = call<unknown>(env, 'race_submit_result', HOST_ID,
        submitPayload(sid, makeReport(PLAYER_A), PLAYER_A));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('FORBIDDEN');
    });

    it('rejects malformed reports (BAD_REQUEST)', () => {
      const sid = setupStartedSession(4, 'quick', { overrideStartedAtMs: 1_000_000_000_000 });
      const bad = {
        sessionId: sid,
        callerUserId: PLAYER_A,
        report: { userId: PLAYER_A, totalMs: -1, laps: [], isBotReport: false },
      };
      const submitEnv = call<unknown>(env, 'race_submit_result', null, JSON.stringify(bad));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('race_submit_result (Chunk 8: step-2 + bot-auth)', () => {
    const PLAYER_A = '22222222-2222-4222-8222-222222222222';

    function submitPayload(sid: string, report: Record<string, unknown>, caller = PLAYER_A): string {
      return JSON.stringify({
        sessionId: sid,
        callerUserId: caller,
        report,
      });
    }

    /**
     * Setup a quick/3-lap (neon_blvd) session with HOST + PLAYER_A in the
     * roster. The bundle runs in a separate VM context, so we cannot use
     * vi.setSystemTime — instead we rewrite the persisted session's
     * startedAt to a known past instant, making step-2 clock checks
     * deterministic.
     */
    function setupQuick3Lap(opts: { overrideStartedAtMs?: number } = {}): { sid: string } {
      const createEnv = call<CreateData>(env, 'race_session_create', null, makeCreatePayload({ mode: 'quick', size: 2 }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const joinEnv = call<{ rosterVersion: number; rosterSize: number }>(
        env, 'race_session_join', null,
        {
          sessionId: sid,
          userId: PLAYER_A,
          callerUserId: PLAYER_A,
          loadout: { classId: 'B', bodyId: 'coupe' },
        },
      );
      if (!joinEnv.ok) throw new Error('join failed');
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!startEnv.ok) throw new Error('start failed');

      if (opts.overrideStartedAtMs !== undefined) {
        // Mutate the persisted session value so the bundle reads the
        // overridden startedAt on the next readSession.
        const storeKey = `race_sessions/${sid}/00000000-0000-0000-0000-000000000000`;
        const obj = env.fakeNakama.store.get(storeKey);
        if (obj) {
          (obj.value as { startedAt: number }).startedAt = opts.overrideStartedAtMs;
        }
      }
      return { sid };
    }

    it('accepts a well-formed report (within clock, at-or-above min-time, sum matches)', () => {
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: 1_000_000_000_000 });
      // quick/neon_blvd = 3 laps; B class min = 40_000/lap → min total 120_000.
      const submitEnv = call<{ accepted: true; confidence: string }>(
        env, 'race_submit_result', null,
        submitPayload(sid, { userId: PLAYER_A, totalMs: 120_000, laps: [40_000, 40_000, 40_000], isBotReport: false }),
      );
      expect(submitEnv.ok).toBe(true);
    });

    it('rejects a report whose totalMs exceeds the wall clock (TIME_EXCEEDS_CLOCK)', () => {
      // Get the server's current time so we can backdate startedAt to a
      // known small elapsed window. With startedAt 10s ago and totalMs
      // 10 minutes, step-2 clock must fire (the lap-sum is consistent
      // at 600_000ms so we don't trip the next check first).
      const cfg = call<{ serverTimeMs: number }>(env, 'config_get', null, '{}');
      expect(cfg.ok).toBe(true);
      if (!cfg.ok) return;
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: cfg.data.serverTimeMs - 10_000 });
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, { userId: PLAYER_A, totalMs: 600_000, laps: [200_000, 200_000, 200_000], isBotReport: false }));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('INVALID_RESULT');
      expect((submitEnv.error.details as { reason?: string }).reason).toBe('TIME_EXCEEDS_CLOCK');
    });

    it('rejects a report below the per-class min-time (BELOW_MIN_TIME)', () => {
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: 1_000_000_000_000 });
      // B class min = 120_000. totalMs = 30_000 is well below; min-time
      // fires before lap-count.
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, { userId: PLAYER_A, totalMs: 30_000, laps: [30_000], isBotReport: false }));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('INVALID_RESULT');
      expect((submitEnv.error.details as { reason?: string }).reason).toBe('BELOW_MIN_TIME');
    });

    it('rejects a report with the wrong number of laps (LAP_COUNT_MISMATCH)', () => {
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: 1_000_000_000_000 });
      // quick/neon_blvd = 3 laps; submit 2 laps. totalMs ≥ min so
      // min-time passes; lap-count fires.
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, { userId: PLAYER_A, totalMs: 150_000, laps: [75_000, 75_000], isBotReport: false }));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('INVALID_RESULT');
      expect((submitEnv.error.details as { reason?: string }).reason).toBe('LAP_COUNT_MISMATCH');
    });

    it('rejects a report whose laps do not sum to totalMs (LAP_SUM_MISMATCH)', () => {
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: 1_000_000_000_000 });
      // Lap sum 120_000 but totalMs claims 130_000. Min-time and
      // lap-count pass; lap-sum fires.
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, { userId: PLAYER_A, totalMs: 130_000, laps: [40_000, 40_000, 40_000], isBotReport: false }));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('INVALID_RESULT');
      expect((submitEnv.error.details as { reason?: string }).reason).toBe('LAP_SUM_MISMATCH');
    });

    it('rejects a bot report submitted by a non-host caller (FORBIDDEN)', () => {
      const { sid } = setupQuick3Lap({ overrideStartedAtMs: 1_000_000_000_000 });
      // PLAYER_A is not the host. isBotReport=true requires the caller
      // to be the host.
      const submitEnv = call<unknown>(env, 'race_submit_result', null,
        submitPayload(sid, { userId: 'bot-1', totalMs: 120_000, laps: [40_000, 40_000, 40_000], isBotReport: true }, PLAYER_A));
      expect(submitEnv.ok).toBe(false);
      if (submitEnv.ok) return;
      expect(submitEnv.error.code).toBe('FORBIDDEN');
      expect(submitEnv.error.message).toMatch(/host/);
    });

    it('accepts a bot report submitted by the host (host = caller = report.userId)', () => {
      // 1-player time_trial session; only the host is in the roster.
      // Bots are relay-pure — the host reports on their own behalf with
      // isBotReport=true.
      const createEnv = call<CreateData>(env, 'race_session_create', null,
        makeCreatePayload({ mode: 'time_trial', size: 1, hostLoadout: { classId: 'C', bodyId: 'coupe' } }));
      if (!createEnv.ok) throw new Error('create failed');
      const sid = createEnv.data.sessionId;
      const startEnv = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
        sessionId: sid,
        callerUserId: HOST_ID,
      });
      if (!startEnv.ok) throw new Error('start failed');
      // Backdate startedAt so the clock check is comfortably within
      // tolerance for a 60s totalMs.
      const storeKey = `race_sessions/${sid}/00000000-0000-0000-0000-000000000000`;
      const obj = env.fakeNakama.store.get(storeKey);
      if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;

      const submitEnv = call<{ accepted: true }>(env, 'race_submit_result', HOST_ID,
        submitPayload(sid, { userId: HOST_ID, totalMs: 60_000, laps: [60_000], isBotReport: true }, HOST_ID));
      expect(submitEnv.ok).toBe(true);
    });
  });
});