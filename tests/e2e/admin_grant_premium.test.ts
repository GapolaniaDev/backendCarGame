// Phase 6 Chunk 6 — `admin_grant_premium` e2e tests.
//
// Covers:
//   1. FORBIDDEN when adminKey is missing
//   2. FORBIDDEN when adminKey mismatches the liveops config
//   3. SERVICE_UNAVAILABLE when adminRpcKey is not configured
//   4. BAD_REQUEST when userId is missing
//   5. SUCCESS — flips premiumPurchased=true without charging gems
//   6. Idempotent — second call returns the prior state
//   7. Bypasses maintenance (admin surface stays live)

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import { bootEnsure as bootEnsureLiveops } from '../../modules/src/liveops/config';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

const ADMIN_KEY = 'test-admin-key-pass-1234567890';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface AdminGrantOutput {
  userId: string;
  seasonId: string;
  premiumPurchased: true;
  viaAdmin: true;
}

function seedLiveops(env: LoadedBundle): void {
  bootEnsureLiveops(env.nak, env.logger);
  const cur = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      version: 1,
      flags: { maintenance: false },
      minClientVersion: {
        ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
      },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    } as unknown as LiveopsConfig,
    version: cur?.version ?? 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: cur?.createTime ?? new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

function seedMaintenance(env: LoadedBundle): void {
  seedLiveops(env);
  const cur = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: {
      ...(cur!.value as LiveopsConfig),
      flags: { maintenance: true },
    } as unknown as LiveopsConfig,
    version: cur?.version ?? 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: cur?.createTime ?? new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

function callAdminGrant(
  env: LoadedBundle,
  userId: string,
  adminKey: string,
): Resp<AdminGrantOutput> {
  const handler = env.resolver('admin_grant_premium');
  if (!handler) throw new Error('no rpc: admin_grant_premium');
  const body = JSON.stringify({ userId, adminKey });
  return JSON.parse(handler(FakeContext, env.logger, env.nak, body)) as Resp<AdminGrantOutput>;
}

describe('admin_grant_premium e2e (Phase 6 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    seedLiveops(env);
  });

  it('FORBIDDEN when adminKey is missing', () => {
    const handler = env.resolver('admin_grant_premium');
    if (!handler) throw new Error('no rpc: admin_grant_premium');
    const res = JSON.parse(handler(FakeContext, env.logger, env.nak, JSON.stringify({ userId: 'target' }))) as Resp<unknown>;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('FORBIDDEN when adminKey mismatches the liveops config', () => {
    const res = callAdminGrant(env, 'target', 'wrong-key');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('SERVICE_UNAVAILABLE when adminRpcKey is not configured', () => {
    // Override the liveops config to remove adminRpcKey.
    const cur = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    const cfg = { ...(cur!.value as LiveopsConfig) } as Record<string, unknown>;
    delete cfg['adminRpcKey'];
    env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
      collection: 'liveops',
      key: 'config',
      userId: SYSTEM_USER_ID,
      value: cfg as unknown as LiveopsConfig,
      version: cur?.version ?? 'v00000001',
      permissionRead: 0,
      permissionWrite: 0,
      createTime: cur?.createTime ?? new Date().toISOString(),
      updateTime: new Date().toISOString(),
      expiresAt: null,
    });
    const res = callAdminGrant(env, 'target', ADMIN_KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('BAD_REQUEST when userId is missing', () => {
    const handler = env.resolver('admin_grant_premium');
    if (!handler) throw new Error('no rpc: admin_grant_premium');
    const res = JSON.parse(handler(FakeContext, env.logger, env.nak, JSON.stringify({ adminKey: ADMIN_KEY }))) as Resp<unknown>;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
  });

  it('SUCCESS — flips premiumPurchased=true without charging gems', () => {
    const target = 'target-user-1';
    const res = callAdminGrant(env, target, ADMIN_KEY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.premiumPurchased).toBe(true);
    expect(res.data.viaAdmin).toBe(true);

    // Verify persistence.
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${passRecordKey(target)}/${target}`);
    expect(stored).toBeDefined();
    expect((stored!.value as { premiumPurchased: boolean }).premiumPurchased).toBe(true);

    // No gems spent — wallet unchanged (undefined or zero).
    const w = env.fakeNakama.wallets.get(target);
    expect(w?.gems ?? 0).toBe(0);
  });

  it('idempotent — second call returns the prior state', () => {
    const target = 'target-user-2';
    const first = callAdminGrant(env, target, ADMIN_KEY);
    expect(first.ok).toBe(true);
    const second = callAdminGrant(env, target, ADMIN_KEY);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.premiumPurchased).toBe(true);
  });

  it('bypasses maintenance — succeeds even when liveops.maintenance=true', () => {
    seedMaintenance(env);
    const target = 'target-user-3';
    const res = callAdminGrant(env, target, ADMIN_KEY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.premiumPurchased).toBe(true);
  });
});