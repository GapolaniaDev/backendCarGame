// T-04 (plan fishnet-nakama-server) — server-to-server authentication of the
// dedicated race servers (D-01).

import { describe, it, expect } from 'vitest';
import { FakeContext } from '../e2e/_stubs';
import type { IContext } from '../../modules/src/nkruntime';
import { isValidServerId, requireRaceServer, secretsMatch } from '../../modules/src/race_servers/auth';

const SECRET = 'a-long-random-secret';

function ctxWith(env: Record<string, string>, userId?: string): IContext {
  return { ...FakeContext, env, ...(userId !== undefined ? { userId } : {}) } as IContext;
}

function errorCode(serialized: string): string {
  return (JSON.parse(serialized) as { error: { code: string } }).error.code;
}

describe('requireRaceServer (D-01)', () => {
  it('without RACE_SERVER_SECRET answers SERVICE_UNAVAILABLE', () => {
    const r = requireRaceServer(ctxWith({}), { serverKey: SECRET, serverId: 'srv-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCode(r.error)).toBe('SERVICE_UNAVAILABLE');
  });

  it('a blank secret counts as missing', () => {
    const r = requireRaceServer(ctxWith({ RACE_SERVER_SECRET: '   ' }), { serverKey: '', serverId: 'srv-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCode(r.error)).toBe('SERVICE_UNAVAILABLE');
  });

  it('a wrong or missing serverKey answers FORBIDDEN', () => {
    const ctx = ctxWith({ RACE_SERVER_SECRET: SECRET });
    for (const key of ['nope', SECRET + 'x', '', undefined, 42]) {
      const r = requireRaceServer(ctx, { serverKey: key, serverId: 'srv-1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(errorCode(r.error)).toBe('FORBIDDEN');
    }
  });

  it('a player session is refused even with the right key', () => {
    const r = requireRaceServer(ctxWith({ RACE_SERVER_SECRET: SECRET }, 'user-1'), { serverKey: SECRET, serverId: 'srv-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCode(r.error)).toBe('FORBIDDEN');
  });

  it('the right key returns the serverId', () => {
    const r = requireRaceServer(ctxWith({ RACE_SERVER_SECRET: SECRET }), { serverKey: SECRET, serverId: 'srv-1' });
    expect(r).toEqual({ ok: true, serverId: 'srv-1' });
  });

  it('an invalid serverId is BAD_REQUEST (after the key check)', () => {
    const ctx = ctxWith({ RACE_SERVER_SECRET: SECRET });
    for (const id of ['', 'a b', 'a/b', 'x'.repeat(65), undefined, 7]) {
      const r = requireRaceServer(ctx, { serverKey: SECRET, serverId: id });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(errorCode(r.error)).toBe('BAD_REQUEST');
    }
  });
});

describe('helpers', () => {
  it('secretsMatch compares whole strings', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });

  it('isValidServerId accepts 1-64 chars of [A-Za-z0-9._-]', () => {
    expect(isValidServerId('a')).toBe(true);
    expect(isValidServerId('Race.Server_01-eu')).toBe(true);
    expect(isValidServerId('x'.repeat(64))).toBe(true);
    expect(isValidServerId('x'.repeat(65))).toBe(false);
    expect(isValidServerId('')).toBe(false);
    expect(isValidServerId('no spaces')).toBe(false);
  });
});
