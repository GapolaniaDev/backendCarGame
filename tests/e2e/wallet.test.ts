// E2E tests for the Phase 3 wallet_get RPC (Chunk 9):
//   - basic round-trip: set the wallet, call wallet_get, observe the
//     same coins/gems back
//   - round-trip after grant() — the post-grant wallet reflects the
//     new balance
//   - FORBIDDEN when the socket ctx.userId mismatches the payload
//     callerUserId (defence against identity spoofing via HTTP)
//   - UNAUTHENTICATED when neither socket nor payload carry an
//     identity
//   - pending field is always an array (empty for now)
//   - ledger.last30dCount is a non-negative integer

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
} from './_stubs';

const HOST_ID = 'user-host';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function callAnonymous<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = { ...FakeContext };
  delete (ctx as { userId?: string }).userId;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function setWallet(env: ReturnType<typeof loadBundleForTest>, userId: string, coins: number, gems = 0): void {
  env.fakeNakama.wallets.set(userId, { coins, gems });
}

describe('wallet_get (Chunk 9)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('returns the current wallet for the caller', () => {
    setWallet(env, HOST_ID, 1234, 56);
    const r = call<Resp<{ coins: number; gems: number; pending: unknown[]; ledger: { last30dCount: number } }>>(
      env, 'wallet_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coins).toBe(1234);
    expect(r.data.gems).toBe(56);
    expect(Array.isArray(r.data.pending)).toBe(true);
    expect(r.data.pending).toEqual([]);
    expect(typeof r.data.ledger.last30dCount).toBe('number');
    expect(r.data.ledger.last30dCount).toBe(0);
  });

  it('reflects grant() mutations on the next wallet_get call', () => {
    setWallet(env, HOST_ID, 1000, 10);
    // Buy the starter pack — spends 2500 coins (will fail with INSUFFICIENT_FUNDS
    // on this balance) but the seed car needs no spend. We use the store_buy
    // flow with a top-up via direct wallet write to simulate a grant.
    setWallet(env, HOST_ID, 100000, 0);
    const buy = call<Resp<{ newBalance: { coins: number; gems: number } }>>(
      env, 'store_buy', HOST_ID, { offerId: 'perm_starter_pack', callerUserId: HOST_ID },
    );
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    expect(buy.data.newBalance.gems).toBe(50);
    const w = call<Resp<{ coins: number; gems: number }>>(
      env, 'wallet_get', HOST_ID, { callerUserId: HOST_ID },
    );
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.data.coins).toBe(buy.data.newBalance.coins);
    expect(w.data.gems).toBe(50);
  });

  it('returns FORBIDDEN when ctx.userId mismatches payload.callerUserId', () => {
    setWallet(env, HOST_ID, 100, 5);
    const r = call<Resp<unknown>>(
      env, 'wallet_get', HOST_ID, { callerUserId: 'someone-else' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('returns UNAUTHENTICATED when no caller identity is present', () => {
    setWallet(env, HOST_ID, 100, 5);
    const r = callAnonymous<Resp<unknown>>(env, 'wallet_get', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNAUTHENTICATED');
  });

  it('treats an empty body as self-read when ctx.userId is set', () => {
    setWallet(env, HOST_ID, 999, 9);
    const r = call<Resp<{ coins: number; gems: number }>>(
      env, 'wallet_get', HOST_ID, {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coins).toBe(999);
    expect(r.data.gems).toBe(9);
  });

  it('returns BAD_REQUEST for a malformed JSON body', () => {
    setWallet(env, HOST_ID, 100, 5);
    const r = call<Resp<unknown>>(env, 'wallet_get', HOST_ID, '{not-json}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('returns zero coins/gems for an unknown user (no wallet yet)', () => {
    const r = call<Resp<{ coins: number; gems: number; pending: unknown[]; ledger: { last30dCount: number } }>>(
      env, 'wallet_get', 'ghost-user', { callerUserId: 'ghost-user' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coins).toBe(0);
    expect(r.data.gems).toBe(0);
    expect(Array.isArray(r.data.pending)).toBe(true);
  });
});