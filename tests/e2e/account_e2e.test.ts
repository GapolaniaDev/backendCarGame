// Phase 5 Chunk 4 e2e tests for account linking RPCs.
//
// Covers the 5 spec cases:
//   1. Device auth → `account_link` with email token → linked, 500 coins
//   2. Logout → re-login same email → same userId, profile preserved
//      (NOTE: e2e stub cannot simulate a fresh HTTP auth, so we exercise
//       the link-side invariant: same customId re-linked to the SAME user
//       is a no-op for bonus + bonus-flag stays sealed.)
//   3. Device auth (user A) → device auth (user B) → A tries to link B's
//      email → conflictToken returned
//   4. Resolve with choice=cancel → A and B stay separate
//   5. Resolve with choice=link → B deleted, A linked + bonus

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';
import { mintTestToken } from './_test_tokens';

const USER_A = 'user-A';
const USER_B = 'user-B';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

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

interface LinkOk { linked: true; bonusClaimed: boolean; newBalance?: { coins: number; gems: number } }
interface LinkConflict {
  linked: false;
  conflict: {
    conflictToken: string;
    expiresAt: string;
    source: { userId: string };
    target: { userId: string };
  };
}
interface ResolveResult {
  resolved: 'linked' | 'cancelled';
  affectedAccountDeleted?: boolean;
  bonusClaimed?: boolean;
  newBalance?: { coins: number; gems: number };
}
interface WalletView { coins: number; gems: number }

function callAccountLink(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  provider: string,
  token: string,
): Resp<LinkOk | LinkConflict> {
  return call<Resp<LinkOk | LinkConflict>>(
    env,
    'account_link',
    userId,
    { callerUserId: userId, provider, token, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callResolve(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  conflictToken: string,
  choice: 'link' | 'cancel',
  confirmText?: string,
): Resp<ResolveResult> {
  return call<Resp<ResolveResult>>(
    env,
    'account_link_resolve_conflict',
    userId,
    {
      callerUserId: userId,
      conflictToken,
      choice,
      clientVersion: '1.0.0',
      platform: 'ios',
      ...(confirmText !== undefined ? { confirmText } : {}),
    },
  );
}

function callWalletGet(env: ReturnType<typeof loadBundleForTest>, userId: string): Resp<WalletView> {
  return call<Resp<WalletView>>(
    env,
    'wallet_get',
    userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

describe('account linking (Phase 5 Chunk 4) — account_link RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => { env = loadBundleForTest(); });

  it('1. device auth + email link → 500 coins credited', () => {
    const token = mintTestToken('email', 'a@example.com', 60);
    const r = callAccountLink(env, USER_A, 'email', token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!('linked' in r.data)) {
      throw new Error(`expected linked, got conflict: ${JSON.stringify(r.data)}`);
    }
    expect(r.data.linked).toBe(true);
    expect(r.data.bonusClaimed).toBe(true);
    expect(r.data.newBalance?.coins).toBe(500);

    const wallet = callWalletGet(env, USER_A);
    expect(wallet.ok).toBe(true);
    if (!wallet.ok) return;
    expect(wallet.data.coins).toBe(500);
  });

  it('2. same customId re-linked → no double bonus', () => {
    const token = mintTestToken('email', 'repeat@example.com', 60);
    const r1 = callAccountLink(env, USER_A, 'email', token);
    expect(r1.ok).toBe(true);
    if (r1.ok && 'linked' in r1.data) {
      expect(r1.data.bonusClaimed).toBe(true);
    }
    const r2 = callAccountLink(env, USER_A, 'email', token);
    expect(r2.ok).toBe(true);
    if (r2.ok && 'linked' in r2.data) {
      expect(r2.data.bonusClaimed).toBe(false);
    }
    const wallet = callWalletGet(env, USER_A);
    if (wallet.ok) expect(wallet.data.coins).toBe(500);
  });

  it('3. user A tries to link B\'s email → conflictToken', () => {
    const token = mintTestToken('email', 'shared@example.com', 60);
    // First link as user B.
    const first = callAccountLink(env, USER_B, 'email', token);
    expect(first.ok).toBe(true);
    // User A attempts the same email.
    const second = callAccountLink(env, USER_A, 'email', token);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    if (!('conflict' in second.data)) {
      throw new Error(`expected conflict, got linked: ${JSON.stringify(second.data)}`);
    }
    expect(second.data.conflict.conflictToken.length).toBeGreaterThan(0);
    expect(second.data.conflict.source.userId).toBe(USER_A);
    expect(second.data.conflict.target.userId).toBe(USER_B);
  });
});

describe('account linking (Phase 5 Chunk 4) — account_link_resolve_conflict RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => { env = loadBundleForTest(); });

  it('4. cancel — both accounts stay separate', () => {
    const token = mintTestToken('email', 'cancel@example.com', 60);
    callAccountLink(env, USER_B, 'email', token);
    const conflict = callAccountLink(env, USER_A, 'email', token);
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    if (!('conflict' in conflict.data)) throw new Error('expected conflict');
    const conflictToken = conflict.data.conflict.conflictToken;

    const r = callResolve(env, USER_A, conflictToken, 'cancel');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.resolved).toBe('cancelled');

    // B still owns the link; A doesn't.
    expect(env.fakeNakama.links.get('email:cancel@example.com')).toBe(USER_B);
  });

  it('5. link with TRANSFER confirm → B deleted, A linked + bonus', () => {
    const token = mintTestToken('email', 'transfer@example.com', 60);
    callAccountLink(env, USER_B, 'email', token);
    const conflict = callAccountLink(env, USER_A, 'email', token);
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    if (!('conflict' in conflict.data)) throw new Error('expected conflict');
    const conflictToken = conflict.data.conflict.conflictToken;

    const r = callResolve(env, USER_A, conflictToken, 'link', 'TRANSFER');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.resolved).toBe('linked');
    expect(r.data.affectedAccountDeleted).toBe(true);
    expect(r.data.bonusClaimed).toBe(true);
    expect(r.data.newBalance?.coins).toBe(500);

    // A now owns the link; B's link entries gone.
    expect(env.fakeNakama.links.get('email:transfer@example.com')).toBe(USER_A);
    expect(env.fakeNakama.wallets.get(USER_B)).toBeUndefined();
  });
});