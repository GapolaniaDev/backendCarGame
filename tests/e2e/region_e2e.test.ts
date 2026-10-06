// Phase 5 Chunk 8 e2e tests — Region relay (NODE_ROLE + relay_token).
//
// Drives a fresh bundle boot under two nodeRole configurations
// (home, relay) and asserts the RPC surface differs:
//   - home: full game RPCs + `relay_token`
//   - relay: only `race_session_get` + `race_submit_result`
// All scenarios also test the HMAC token round-trip and the
// `beforeAuthenticateDevice` hook behaviour.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  FakeLogger,
  FakeNakama,
  FakeInitializer,
  SYSTEM_USER_ID,
  loadBundleForTest,
} from './_stubs';
import {
  verifyRelayToken,
  signRelayToken,
  RELAY_TOKEN_TTL_SEC,
} from '../../modules/src/region/relay_token';
import type { INakama, IContext, ILogger } from '../../modules/src/nkruntime';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

const RELAY_TOKEN_SECRET = 'unit-test-relay-secret-rotate';

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): { ok: true; data: T } | { ok: false; error: { code: string; message: string } } {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
}

/**
 * Load the bundle with a pre-existing liveops config in storage
 * (mimics `liveops_config_override` happening before boot).
 */
function loadBundleWithLiveops(
  seed: Record<string, unknown>,
): ReturnType<typeof loadBundleForTest> {
  const bundlePath = path.resolve(__dirname, '..', '..', 'modules', 'index.js');
  const code = fs.readFileSync(bundlePath, 'utf8');
  // Polyfill the sandbox with Node globals so esbuild's
  // `--platform=neutral` bundle has btoa/Buffer/console available.
  // The production runtime has these too (the Go runtime provides
  // them to goja), but a bare `vm.createContext({})` does not.
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
    throw new Error(`InitModule not found in bundle at ${bundlePath}; did you run \`npm run build\`?`);
  }
  const InitModule = result as (ctx: IContext, logger: ILogger, nk: INakama, init: unknown) => void;
  const fakeNakama = new FakeNakama();
  const fakeLogger = new FakeLogger();
  const fakeInitializer = new FakeInitializer();

  // Seed the liveops config before InitModule runs.
  const base = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: false },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [
      { id: 'us-east-1', displayName: 'US East', relayUrl: 'wss://api.example.com' },
    ],
    calendar: [],
    relayTokenSecret: RELAY_TOKEN_SECRET,
    ...seed,
  };
  fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: base,
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    expiresAt: null,
  });

  InitModule(FakeContext, fakeLogger, fakeNakama.nakama, fakeInitializer.initializer);

  return {
    nak: fakeNakama.nakama,
    logger: fakeLogger,
    initializer: fakeInitializer.initializer,
    rpcs: fakeInitializer.rpcs,
    resolver: (key: string) => fakeInitializer.resolve(key),
    fakeNakama,
    fakeLogger,
    fakeInitializer,
  };
}

describe('region_e2e (Phase 5 Chunk 8) — nodeRole=home', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleWithLiveops({ nodeRole: 'home' });
  });

  it('1. home node: relay_token RPC returns token + relayUrl + expiresAt', () => {
    const r = call<{ token: string; relayUrl: string; expiresAt: number; regionId: string }>(
      env, 'relay_token', 'u-home-1',
      { clientVersion: '1.0.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.token.startsWith('v1.')).toBe(true);
    expect(r.data.relayUrl).toBe('wss://api.example.com');
    expect(r.data.regionId).toBe('us-east-1');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(r.data.expiresAt - nowSec).toBe(RELAY_TOKEN_TTL_SEC);
  });

  it('2. home node: verify token with same secret returns ctx userId', () => {
    const r = call<{ token: string }>(
      env, 'relay_token', 'u-home-2',
      { clientVersion: '1.0.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = verifyRelayToken(env.nak, r.data.token, RELAY_TOKEN_SECRET);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.payload.userId).toBe('u-home-2');
    expect(v.payload.region).toBe('us-east-1');
  });

  it('3. home node: token expires after 60min — verified at nowSec+3601 → expired', () => {
    const r = call<{ token: string }>(
      env, 'relay_token', 'u-home-3',
      { clientVersion: '1.0.0', platform: 'ios' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const future = nowSec + RELAY_TOKEN_TTL_SEC + 1;
    const v = verifyRelayToken(env.nak, r.data.token, RELAY_TOKEN_SECRET, future);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('expired');
  });

  it('4. home node: maintenance + admin (skipForAdmin) → relay_token still OK', () => {
    env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
      ...env.fakeNakama.store.get(`liveops/config/${SYSTEM_USER_ID}`)!,
      value: {
        schemaVersion: 1, version: 2,
        flags: { maintenance: true },
        minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
        regions: [{ id: 'us-east-1', displayName: 'US East', relayUrl: 'wss://api.example.com' }],
        calendar: [],
        nodeRole: 'home',
        relayTokenSecret: RELAY_TOKEN_SECRET,
      },
    });
    const r = call<unknown>(env, 'relay_token', 'u-admin-1', {
      clientVersion: '1.0.0', platform: 'ios',
    });
    expect(r.ok).toBe(true);
  });
});

describe('region_e2e (Phase 5 Chunk 8) — nodeRole=relay', () => {
  it('5. relay node: wallet_get is NOT registered → resolver returns undefined', () => {
    const env = loadBundleWithLiveops({ nodeRole: 'relay' });
    expect(env.resolver('wallet_get')).toBeUndefined();
    expect(env.resolver('garage_get')).toBeUndefined();
    expect(env.resolver('store_buy')).toBeUndefined();
    expect(env.resolver('admin_wallet_adjust')).toBeUndefined();
  });

  it('6. relay node: race_session_get IS registered', () => {
    const env = loadBundleWithLiveops({ nodeRole: 'relay' });
    expect(env.resolver('race_session_get')).toBeDefined();
    expect(env.resolver('race_submit_result')).toBeDefined();
  });

  it('7. relay node: relay_token RPC is NOT registered', () => {
    const env = loadBundleWithLiveops({ nodeRole: 'relay' });
    expect(env.resolver('relay_token')).toBeUndefined();
  });

  it('8. relay node: beforeAuthenticateDevice installed and validates', () => {
    const env = loadBundleWithLiveops({ nodeRole: 'relay' });
    expect(env.fakeInitializer.beforeAuthenticateDevices.length).toBe(1);
    const hook = env.fakeInitializer.beforeAuthenticateDevices[0]!;

    // Missing relayToken on relay node → must throw.
    expect(() => hook(FakeContext, env.logger, env.nak, {
      userId: '', username: '', vars: {},
    })).toThrowError(/relay_token/);

    // Valid token → must not throw.
    const nowSec = Math.floor(Date.now() / 1000);
    const tok = signRelayToken(
      env.nak,
      { userId: 'u-relay-1', region: 'us-east-1', expSec: nowSec + 60 },
      RELAY_TOKEN_SECRET,
    );
    expect(() => hook(FakeContext, env.logger, env.nak, {
      userId: '', username: '', vars: { relayToken: tok },
    })).not.toThrow();

    // Expired token → must throw with relay_token_expired.
    const tokExpired = signRelayToken(
      env.nak,
      { userId: 'u-relay-1', region: 'us-east-1', expSec: nowSec - 5 },
      RELAY_TOKEN_SECRET,
    );
    expect(() => hook(FakeContext, env.logger, env.nak, {
      userId: '', username: '', vars: { relayToken: tokExpired },
    })).toThrowError(/relay_token_expired/);

    // Tampered signature → must throw.
    const badTok = tok.replace(/.$/, 'X');
    expect(() => hook(FakeContext, env.logger, env.nak, {
      userId: '', username: '', vars: { relayToken: badTok },
    })).toThrowError(/relay_token_bad_sig/);
  });

  it('9. home node: beforeAuthenticateDevice is a no-op (no relayToken required)', () => {
    const env = loadBundleWithLiveops({ nodeRole: 'home' });
    expect(env.fakeInitializer.beforeAuthenticateDevices.length).toBe(1);
    const hook = env.fakeInitializer.beforeAuthenticateDevices[0]!;
    // No relayToken, no throw — home allows direct device-auth.
    expect(() => hook(FakeContext, env.logger, env.nak, {
      userId: '', username: '', vars: {},
    })).not.toThrow();
  });
});