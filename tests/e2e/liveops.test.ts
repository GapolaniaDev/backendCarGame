// Phase 5 Chunk 2 e2e tests for the liveops gate + RPC.
//
// Covers:
//   1. liveops_config_get returns the current shape + a configHash
//   2. Mutate storage → next call returns a new hash
//   3. garage_get with maintenance=ON → SERVICE_UNAVAILABLE
//   4. garage_get with maintenance=ON + user in exempt → 200 OK
//   5. garage_get with clientVersion='0.0.1' (< minClientVersion.ios='0.1.0')
//      → UPGRADE_REQUIRED
//
// Companion to tests/unit/liveops_gate.test.ts (pure helpers) and
// tests/unit/liveops_config.test.ts (storage read path).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import {
  LIVEOPS_COLLECTION,
  LIVEOPS_KEY,
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

const USER = 'user-liveops';

interface LiveopsConfigOutput {
  version: number;
  flags: { maintenance: boolean; maintenanceMessage?: string };
  minClientVersion: Record<string, string>;
  regions: ReadonlyArray<{ id: string; displayName: string; relayUrl: string }>;
  calendar: ReadonlyArray<unknown>;
  configHash: string;
}

interface GarageOutput {
  garage: { userId: string; cars: unknown[] };
}

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

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

function getConfig(env: ReturnType<typeof loadBundleForTest>, userId: string): Resp<LiveopsConfigOutput> {
  return call<Resp<LiveopsConfigOutput>>(
    env,
    'liveops_config_get',
    userId,
    { callerUserId: userId },
  );
}

function getGarage(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  payloadExtras: Record<string, unknown> = {},
): Resp<GarageOutput> {
  return call<Resp<GarageOutput>>(
    env,
    'garage_get',
    userId,
    { callerUserId: userId, ...payloadExtras },
  );
}

describe('liveops (Phase 5 Chunk 2) — liveops_config_get RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('returns the current shape + configHash', () => {
    const r = getConfig(env, USER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.version).toBeGreaterThanOrEqual(1);
    expect(r.data.flags.maintenance).toBe(false);
    expect(r.data.minClientVersion.ios).toBe('0.1.0');
    expect(r.data.minClientVersion.android).toBe('0.1.0');
    expect(r.data.regions.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(r.data.calendar)).toBe(true);
    expect(typeof r.data.configHash).toBe('string');
    expect(r.data.configHash).toMatch(/^[0-9a-f]{64}$/);
    // The server-only exempt list MUST NOT be exposed to clients.
    const flagsRaw = r.data.flags as { maintenanceExemptUserIds?: unknown };
    expect(flagsRaw.maintenanceExemptUserIds).toBeUndefined();
  });

  it('mutate storage → next call returns a new hash', () => {
    const r1 = getConfig(env, USER);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const hash1 = r1.data.configHash;

    // Admin flips maintenance ON with a message — version bumps to 2.
    const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    const current = stored?.value as LiveopsConfig;
    env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
      ...stored,
      value: {
        ...current,
        version: 2,
        flags: { maintenance: true, maintenanceMessage: 'Deploy window' },
      },
    });

    const r2 = getConfig(env, USER);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.version).toBe(2);
    expect(r2.data.flags.maintenance).toBe(true);
    expect(r2.data.flags.maintenanceMessage).toBe('Deploy window');
    expect(r2.data.configHash).not.toBe(hash1);
  });

  it('does not require maintenance to be off — works while in maintenance', () => {
    // Flip maintenance ON; liveops_config_get must still respond (the
    // client needs to read the config to display the splash).
    const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    const current = stored?.value as LiveopsConfig;
    env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
      ...stored,
      value: { ...current, flags: { maintenance: true } },
    });

    const r = getConfig(env, USER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.flags.maintenance).toBe(true);
  });
});

describe('liveops (Phase 5 Chunk 2) — gate enforcement on garage_get', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  function flipMaintenance(value: boolean, exempt?: string[]): void {
    const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    const current = stored?.value as LiveopsConfig;
    env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
      ...stored,
      value: {
        ...current,
        flags: {
          maintenance: value,
          ...(exempt !== undefined ? { maintenanceExemptUserIds: exempt } : {}),
        },
      },
    });
  }

  it('garage_get with maintenance=ON → SERVICE_UNAVAILABLE', () => {
    flipMaintenance(true);
    const r = getGarage(env, USER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(r.error.message).toContain('mantenimiento');
  });

  it('garage_get with maintenance=ON + user in exempt → 200 OK', () => {
    flipMaintenance(true, [USER]);
    const r = getGarage(env, USER, { clientVersion: '1.0.0', platform: 'ios' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.garage.userId).toBe(USER);
  });

  it('garage_get with clientVersion below min → UPGRADE_REQUIRED', () => {
    // Default minClientVersion.ios = '0.1.0'.
    const r = getGarage(env, USER, { clientVersion: '0.0.1', platform: 'ios' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UPGRADE_REQUIRED');
    expect(r.error.message).toContain('desactualizada');
    const detail = r.error.details as { clientVersion: string; required: string; platform: string };
    expect(detail.clientVersion).toBe('0.0.1');
    expect(detail.required).toBe('0.1.0');
    expect(detail.platform).toBe('ios');
  });

  it('garage_get with clientVersion at-or-above min → 200 OK', () => {
    const r = getGarage(env, USER, { clientVersion: '0.1.0', platform: 'ios' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.garage.userId).toBe(USER);
  });

  it('garage_get with missing clientVersion (legacy client) → UPGRADE_REQUIRED', () => {
    // clientVersion undefined → treated as "0.0.0" → fails min 0.1.0.
    const r = getGarage(env, USER, { platform: 'ios' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('garage_get with missing clientVersion + min=0.0.0 → 200 OK', () => {
    // Seed a config with all minClientVersion at 0.0.0 so the legacy
    // client (undefined version) is not blocked.
    const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    const current = stored?.value as LiveopsConfig;
    env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
      ...stored,
      value: {
        ...current,
        minClientVersion: { ios: '0.0.0', android: '0.0.0', windows: '0.0.0', macos: '0.0.0', linux: '0.0.0' },
      },
    });

    const r = getGarage(env, USER);
    expect(r.ok).toBe(true);
  });
});