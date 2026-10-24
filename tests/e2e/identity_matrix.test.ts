// T-04 identity matrix (plan D-03; audit PC-01, N2, N6, X2-c).
//
// Every player RPC takes the caller from the session (`ctx.userId`) only:
//   - a body `callerUserId` of another account → FORBIDDEN
//   - no session at all, even with a body identity (an `http_key` call)
//     → UNAUTHENTICATED
// `admin_*` RPCs authenticate with their own secret and are excluded, as
// are the read-only RPCs that serve anonymous data on purpose and the
// signed server-to-server callbacks (T-25), which refuse a session.

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** Public by design: no per-user data, callable before sign-in. */
const ANONYMOUS_RPCS = new Set([
  'config_get',
  'tournament_list',
  'tournament_get',
]);

/** Server-to-server (http_key + the network's signature): a session is FORBIDDEN. */
const SERVER_TO_SERVER_RPCS = new Set([
  'ads_levelplay_callback',
  'rs_heartbeat',
  'rs_join_validate',
  'rs_session_start',
  'rs_submit_results',
  'rs_session_release',
]);

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('identity matrix: every player RPC trusts only ctx.userId', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  let playerRpcs: string[];

  beforeAll(() => {
    env = loadBundleForTest();
    playerRpcs = env.rpcs
      .map((r) => r.key)
      .filter((k) => !k.startsWith('admin_') && !ANONYMOUS_RPCS.has(k) && !SERVER_TO_SERVER_RPCS.has(k))
      .sort();
  });

  function invoke(key: string, ctx: typeof FakeContext, body: unknown): Envelope {
    const handler = env.resolver(key);
    if (!handler) throw new Error(`no rpc ${key}`);
    return JSON.parse(handler(ctx, env.logger, env.nak, JSON.stringify(body))) as Envelope;
  }

  it('server-to-server callbacks refuse any player session (T-25)', () => {
    for (const key of SERVER_TO_SERVER_RPCS) {
      expect(env.rpcs.some((r) => r.key === key)).toBe(true);
      const r = invoke(key, { ...FakeContext, userId: SELF }, {});
      expect(r.ok ? 'ok' : r.error.code).toBe('FORBIDDEN');
    }
  });

  it('covers the player surface', () => {
    expect(playerRpcs.length).toBeGreaterThan(50);
  });

  it('a callerUserId of another account is FORBIDDEN', () => {
    const wrong: string[] = [];
    for (const key of playerRpcs) {
      const r = invoke(key, { ...FakeContext, userId: SELF }, { callerUserId: OTHER });
      if (r.ok || r.error.code !== 'FORBIDDEN') {
        wrong.push(`${key} → ${r.ok ? 'ok' : r.error.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('no session is UNAUTHENTICATED even when the body names a user', () => {
    const wrong: string[] = [];
    for (const key of playerRpcs) {
      const r = invoke(key, FakeContext, { callerUserId: SELF, hostUserId: SELF, userId: SELF });
      if (r.ok || r.error.code !== 'UNAUTHENTICATED') {
        wrong.push(`${key} → ${r.ok ? 'ok' : r.error.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('race_session_create accepts the client hostUserId when it is the session user', () => {
    const r = invoke('race_session_create', { ...FakeContext, userId: SELF }, {
      hostUserId: OTHER,
      matchId: 'm',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: { classId: 'C', bodyId: 'c' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN');
  });
});
