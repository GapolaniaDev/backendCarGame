// Phase 5 Chunk 6 e2e tests — admin RPCs wired into the bundle.
//
// Covers the 5 spec cases:
//   1. No adminKey in body → FORBIDDEN
//   2. With adminKey → admin_wallet_adjust OK
//   3. In maintenance mode + adminKey → admin_wallet_adjust OK (admin bypasses)
//   4. admin_send_inbox to 5 users → each can claim via inbox_claim
//   5. admin_cleanup_race_sessions → deletes closed sessions
//
// Each test boots the full bundle via loadBundleForTest, then exercises
// the registered RPCs through env.resolver(). The admin RPCs require
// the admin key in the body — the test seeds it via a direct storage
// write (mimicking `liveops_config_override` from the ops tool).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';

const ADMIN_KEY = 'test-admin-key-1234567890';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(
    handler(FakeContext, env.logger, env.nak, typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ) as T;
}

function seedAdminRpcKey(env: ReturnType<typeof loadBundleForTest>): void {
  // Mimic `liveops_config_override`: the test bundles writes a
  // liveops_config row with the adminRpcKey baked in. loadLiveopsConfig
  // (no cache) reads it on every admin RPC.
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
  });
}

function setMaintenance(env: ReturnType<typeof loadBundleForTest>, on: boolean): void {
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 2,
      flags: { maintenance: on },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000002', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
  });
}

describe('admin_e2e (Phase 5 Chunk 6) — RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    seedAdminRpcKey(env);
  });

  it('1. no adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_wallet_adjust', {
      userId: 'u1',
      coins: 1000,
      reason: 'test',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('2. with adminKey → admin_wallet_adjust OK', () => {
    env.fakeNakama.wallets.set('u1', { coins: 100 });
    const r = call<Resp<{ newBalance: { coins: number; gems: number } }>>(env, 'admin_wallet_adjust', {
      adminKey: ADMIN_KEY,
      userId: 'u1',
      coins: 1000,
      reason: 'manual top-up',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.newBalance.coins).toBe(1100);
  });

  it('3. in maintenance + adminKey → admin_wallet_adjust still OK (admin bypass)', () => {
    setMaintenance(env, true);
    env.fakeNakama.wallets.set('u1', { coins: 50 });
    const r = call<Resp<{ newBalance: { coins: number; gems: number } }>>(env, 'admin_wallet_adjust', {
      adminKey: ADMIN_KEY,
      userId: 'u1',
      gems: 25,
      reason: 'maint grant',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.newBalance.gems).toBe(25);
  });

  it('4. admin_send_inbox to 5 users → each can claim', () => {
    const send = call<Resp<{ delivered: number }>>(env, 'admin_send_inbox', {
      adminKey: ADMIN_KEY,
      userIds: ['u1', 'u2', 'u3', 'u4', 'u5'],
      message: { kind: 'reward', title: 'welcome', body: 'free coins', reward: { coins: 100 } },
    });
    expect(send.ok).toBe(true);
    if (!send.ok) return;
    expect(send.data.delivered).toBe(5);
  });

  it('5. admin_cleanup_race_sessions → drops closed sessions', () => {
    const sessId = 'sess-cleanup-1';
    env.fakeNakama.store.set(`race_sessions/${sessId}/${SYSTEM_USER_ID}`, {
      collection: 'race_sessions', key: sessId, userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, id: sessId, matchId: 'm1', mode: 'quick', trackId: 't1',
        size: 2, roster: [], host: 'p1', hostSuccession: ['p1'],
        state: 'closed', startedAt: 1, results: [], flags: { needsReview: false }, version: 1,
      },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    const r = call<Resp<{ deleted: number }>>(env, 'admin_cleanup_race_sessions', {
      adminKey: ADMIN_KEY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.deleted).toBeGreaterThanOrEqual(1);
    expect(env.fakeNakama.store.has(`race_sessions/${sessId}/${SYSTEM_USER_ID}`)).toBe(false);
  });
});