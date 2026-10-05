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
});