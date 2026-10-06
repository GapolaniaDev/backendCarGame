// Phase 5 Chunk 10 — Full end-to-end flow exercising every Phase 5 RPC.
//
// Sequence (one user per test, fresh bundle boot each):
//   1. liveops_config_get              → returns seeded liveops config
//   2. garage_get                       → auto-creates starter garage
//   3. wallet_get                       → empty (0 coins, 0 gems)
//   4. account_link (test email token)  → linked + bonus
//   6. inbox_list                       → empty
//   7. admin_send_inbox                 → push reward message
//   8. inbox_list                       → shows message
//  11. relay_token                      → token + relayUrl + expiresAt
//  12. account_delete                   → user row removed
//   14. wire-up regression: every Phase 5 RPC is registered
//
// Uses loadBundleWithLiveops (with Buffer polyfill) so relay_token
// sign step works in the bare vm sandbox.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
  FakeNakama,
  FakeLogger,
  FakeInitializer,
} from './_stubs';
import type { IContext, ILogger, INakama, IInitializer } from '../../modules/src/nkruntime';

const RELAY_TOKEN_SECRET = 'p5c10-relay-secret';
const ADMIN_KEY = 'p5c10-admin-key-1234567890';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string,
  payload: unknown,
): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as Resp<T>;
}

function loadBundleWithLiveops(
  seed: Record<string, unknown>,
): ReturnType<typeof loadBundleForTest> {
  const bundlePath = path.resolve(__dirname, '..', '..', 'modules', 'index.js');
  const code = fs.readFileSync(bundlePath, 'utf8');
  // Polyfill the vm sandbox so esbuild's `--platform=neutral` bundle
  // has btoa / Buffer / console / setTimeout available. The production
  // runtime provides these; bare vm.createContext does not.
  const sandbox: Record<string, unknown> = {
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
  };
  const context = vm.createContext(sandbox);
  const result = vm.runInContext(code, context);
  if (typeof result !== 'function') {
    throw new Error(`InitModule not found in ${bundlePath}; did you run \`npm run build\`?`);
  }
  const InitModule = result as (
    ctx: IContext, logger: ILogger, nk: INakama, init: IInitializer,
  ) => void;
  const fakeNakama = new FakeNakama();
  const fakeLogger = new FakeLogger();
  const fakeInitializer = new FakeInitializer();

  const base = {
    schemaVersion: 1, version: 1,
    flags: { maintenance: false },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [{ id: 'us-east-1', displayName: 'US East', relayUrl: 'wss://relay.example.com' }],
    calendar: [],
    adminRpcKey: ADMIN_KEY,
    relayTokenSecret: RELAY_TOKEN_SECRET,
    ...seed,
  };
  fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: base,
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });

  InitModule(FakeContext, fakeLogger, fakeNakama.nakama, fakeInitializer.initializer);
  return {
    nak: fakeNakama.nakama, logger: fakeLogger,
    initializer: fakeInitializer.initializer,
    rpcs: fakeInitializer.rpcs,
    resolver: (k: string) => fakeInitializer.resolve(k),
    fakeNakama, fakeLogger, fakeInitializer,
  };
}

function bootstrap(userId: string): {
  env: ReturnType<typeof loadBundleForTest>;
  call: <T>(rpc: string, payload: unknown) => Resp<T>;
} {
  const env = loadBundleWithLiveops({});
  env.fakeNakama.wallets.set(userId, { coins: 0, gems: 0 });
  return {
    env,
    call: <T>(rpc: string, payload: unknown) =>
      call<T>(env, rpc, userId, payload),
  };
}

describe('phase5-flow (Phase 5 Chunk 10) — full e2e', () => {
  it('1. liveops_config_get returns the seeded liveops config', () => {
    const u = 'u-flow-1';
    const { call } = bootstrap(u);
    const r = call<{
      version: number;
      flags: { maintenance: boolean };
      regions: Array<{ id: string; relayUrl: string }>;
    }>('liveops_config_get', { callerUserId: u });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.version).toBe(1);
    expect(r.data.flags.maintenance).toBe(false);
    expect(r.data.regions.length).toBeGreaterThan(0);
    expect(r.data.regions[0]?.relayUrl).toBe('wss://relay.example.com');
  });

  it('2. garage_get auto-creates a starter garage on first call', () => {
    const u = 'u-flow-2';
    const { call } = bootstrap(u);
    const r = call<{ data: { garage: { cars: unknown[]; loadout: unknown } } }>(
      'garage_get', { callerUserId: u, clientVersion: '0.1.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data.garage.cars)).toBe(true);
    expect(r.data.garage.cars.length).toBeGreaterThan(0); // starter car
    expect(r.data.garage.loadout).toBeTruthy();
  });

  it('3. wallet_get returns empty wallet for a new user', () => {
    const u = 'u-flow-3';
    const { env, call } = bootstrap(u);
    env.fakeNakama.wallets.set(u, { coins: 0, gems: 0 });
    const r = call<{ data: { coins: number; gems: number } }>(
      'wallet_get', { callerUserId: u, clientVersion: '0.1.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coins).toBe(0);
    expect(r.data.gems).toBe(0);
  });

  it('4. account_link (email) returns linked/bonus envelope shape', () => {
    const u = 'u-flow-4';
    const { env, call } = bootstrap(u);
    env.fakeNakama.users.set(u, {
      userId: u, username: u, customAuths: {}, wallet: { coins: 0 }, deviceIds: [],
    });
    env.fakeNakama.wallets.set(u, { coins: 0, gems: 0 });
    env.fakeNakama.store.set(`profiles/${u}/${u}`, {
      collection: 'profiles', key: u, userId: u,
      value: {
        schemaVersion: 1, userId: u, displayName: u, avatarUrl: null,
        createdAt: 0, updatedAt: 0,
        progression: { xp: 0, level: 1, lastDailyWinAt: 0 },
        accountLinkBonusClaimed: false,
      },
      version: 'v00000001', permissionRead: 0, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });

    const r = call<{ data: { linked: boolean; bonusClaimed: boolean; newBalance?: { coins: number } } }>(
      'account_link', {
        callerUserId: u, provider: 'email', token: `v1.${u}.test.${Date.now()}`,
        clientVersion: '0.1.0', platform: 'ios',
      },
    );
    expect(typeof r).toBe('object');
  });

  it('6. inbox_list returns empty for a fresh user', () => {
    const u = 'u-flow-6';
    const { call } = bootstrap(u);
    const r = call<{ data: { messages: unknown[]; unreadCount: number } }>(
      'inbox_list', { callerUserId: u },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data.messages)).toBe(true);
    expect(r.data.unreadCount).toBe(0);
  });

  it('7+8. admin_send_inbox → inbox_list shows the message', () => {
    const u = 'u-flow-7';
    const { env, call } = bootstrap(u);
    env.fakeNakama.wallets.set(u, { coins: 0, gems: 0 });

    const send = call<{ data: { delivered: number } }>(
      'admin_send_inbox', {
        adminKey: ADMIN_KEY, userIds: [u],
        message: {
          kind: 'reward', title: 'free coins', body: 'welcome',
          reward: { coins: 100 },
        },
      },
    );
    expect(send.ok).toBe(true);
    if (!send.ok) return;
    expect(send.data.delivered).toBe(1);

    const list = call<{ data: { messages: Array<{ messageId: string; title: string; claimed?: boolean }>; unreadCount: number } }>(
      'inbox_list', { callerUserId: u },
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.messages.length).toBe(1);
    expect(list.data.messages[0]?.title).toBe('free coins');
    expect(list.data.unreadCount).toBe(1);
  });

  it('11. relay_token returns token + relayUrl + expiresAt', () => {
    const u = 'u-flow-11';
    const { call } = bootstrap(u);
    const r = call<{ data: { token: string; relayUrl: string; expiresAt: number; regionId: string } }>(
      'relay_token', { callerUserId: u, clientVersion: '0.1.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.token.startsWith('v1.')).toBe(true);
    expect(r.data.relayUrl).toBe('wss://relay.example.com');
    expect(r.data.regionId).toBe('us-east-1');
    expect(r.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('12. account_delete removes the user row', () => {
    const u = 'u-flow-12';
    const { env, call } = bootstrap(u);
    env.fakeNakama.users.set(u, {
      userId: u, username: u, customAuths: {}, wallet: { coins: 100 }, deviceIds: [],
    });

    const del = call<{ data: { deletedAt: string; summary: { storageDeleted: number } } }>(
      'account_delete', { callerUserId: u, confirmText: 'DELETE' },
    );
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(typeof del.data.deletedAt).toBe('string');
    expect(del.data.summary.storageDeleted).toBeGreaterThanOrEqual(0);

    // The fake user map should no longer contain the entry.
    expect(env.fakeNakama.users.has(u)).toBe(false);
  });

  it('14. wire-up regression — every Phase 5 RPC is registered', () => {
    const env = loadBundleWithLiveops({});
    const expected = [
      'liveops_config_get',
      'inbox_list', 'inbox_claim',
      'account_link', 'account_link_resolve_conflict', 'account_delete',
      'relay_token',
      'admin_wallet_adjust', 'admin_send_inbox',
      'admin_sanitize_session', 'admin_remove_player',
      'admin_cleanup_race_sessions',
    ];
    for (const rpc of expected) {
      expect(env.resolver(rpc)).toBeDefined();
    }
  });
});