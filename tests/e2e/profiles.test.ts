// E2E tests for the Phase 2 profile module:
//   - profile_get auto-creates a default profile on first read
//   - profile_update validates displayName (length, pattern, blocked words)
//   - profile_update validates avatarUrl length
//   - after-auth hook auto-creates a profile for a new user
//   - the server-token guard is orthogonal to profiles (no leaderboard
//     write here, but it confirms profiles can be read by lb_get after
//     an update)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';
const OTHER_ID = 'user-other';

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

describe('profile module (Chunk 14)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('profile_get auto-creates a default profile on first read', () => {
    const resp = call<{ ok: true; data: { profile: { userId: string; displayName: string; avatarUrl: string | null } } }>(
      env,
      'profile_get',
      HOST_ID,
      { callerUserId: HOST_ID },
    );
    expect(resp.ok).toBe(true);
    expect(resp.data.profile.userId).toBe(HOST_ID);
    expect(resp.data.profile.displayName).toBe('Racer');
    expect(resp.data.profile.avatarUrl).toBeNull();

    // A subsequent read returns the persisted profile (same userId).
    const r2 = call<{ ok: true; data: { profile: { displayName: string } } }>(
      env,
      'profile_get',
      HOST_ID,
      { callerUserId: HOST_ID },
    );
    expect(r2.data.profile.displayName).toBe('Racer');
  });

  it('profile_get returns the Phase 3 progression field (Chunk 3, additive)', () => {
    const resp = call<{
      ok: true;
      data: {
        profile: {
          userId: string;
          progression: {
            level: number;
            xp: number;
            xpToNextLevel: number;
            unlockedLevels: string[];
            lastDailyWinAt: number;
          };
        };
      };
    }>(env, 'profile_get', HOST_ID, { callerUserId: HOST_ID });
    expect(resp.ok).toBe(true);
    const p = resp.data.profile.progression;
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.xpToNextLevel).toBeGreaterThan(0);
    expect(p.unlockedLevels).toContain('class:D');
    expect(p.lastDailyWinAt).toBe(0);
  });

  it('profile_update persists a new displayName + avatarUrl', () => {
    // First create the default.
    call(env, 'profile_get', HOST_ID, { callerUserId: HOST_ID });
    // Now update.
    const upd = call<{ ok: true; data: { profile: { displayName: string; avatarUrl: string | null } } }>(
      env,
      'profile_update',
      HOST_ID,
      {
        displayName: 'Hugo Fast',
        avatarUrl: 'https://cdn.example/avatar.png',
        callerUserId: HOST_ID,
      },
    );
    expect(upd.ok).toBe(true);
    expect(upd.data.profile.displayName).toBe('Hugo Fast');
    expect(upd.data.profile.avatarUrl).toBe('https://cdn.example/avatar.png');

    // Subsequent get returns the updated values.
    const get = call<{ ok: true; data: { profile: { displayName: string; avatarUrl: string | null } } }>(
      env,
      'profile_get',
      HOST_ID,
      { callerUserId: HOST_ID },
    );
    expect(get.data.profile.displayName).toBe('Hugo Fast');
    expect(get.data.profile.avatarUrl).toBe('https://cdn.example/avatar.png');
  });

  it('rejects a blocked displayName with FORBIDDEN', () => {
    call(env, 'profile_get', HOST_ID, { callerUserId: HOST_ID });
    const r = call<{ ok: false; error: { code: string; message: string } }>(
      env,
      'profile_update',
      HOST_ID,
      {
        displayName: 'the Admin',
        callerUserId: HOST_ID,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('rejects a too-short displayName with BAD_REQUEST', () => {
    call(env, 'profile_get', HOST_ID, { callerUserId: HOST_ID });
    const r = call<{ ok: false; error: { code: string; message: string } }>(
      env,
      'profile_update',
      HOST_ID,
      { displayName: 'a', callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a too-long avatarUrl with BAD_REQUEST', () => {
    call(env, 'profile_get', HOST_ID, { callerUserId: HOST_ID });
    const r = call<{ ok: false; error: { code: string; message: string } }>(
      env,
      'profile_update',
      HOST_ID,
      {
        avatarUrl: 'x'.repeat(600),
        callerUserId: HOST_ID,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a caller-mismatch with FORBIDDEN', () => {
    const r = call<{ ok: false; error: { code: string; message: string } }>(
      env,
      'profile_update',
      HOST_ID,
      {
        displayName: 'Hugo',
        callerUserId: OTHER_ID,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('after-auth hook creates a profile for a freshly-authenticated user', () => {
    // Invoke the first installed after-auth hook directly to simulate
    // Nakama firing it on a device auth.
    expect(env.fakeInitializer.afterAuthenticates.length).toBeGreaterThanOrEqual(1);
    const hook = env.fakeInitializer.afterAuthenticates[0];
    expect(hook).toBeDefined();
    if (!hook) return;
    const fakeNk = env.fakeNakama.nakama;
    hook(
     FakeContext,
      env.logger,
      fakeNk,
      { username: 'newbie', userId: 'user-newbie', vars: {} },
    );
    // Profile should now exist.
    const stored = env.fakeNakama.store.get('profiles/user-newbie/user-newbie');
    expect(stored).toBeDefined();
    expect((stored?.value as { displayName: string }).displayName).toBe('Racer');
  });
});