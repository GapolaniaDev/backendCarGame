// account_link and account_link_resolve_conflict over the bundle (plan
// T-15, P-02). Identities are linked natively (the fake's
// `linkIdentity` stands in for the client's `Link*Async`); the RPCs only
// read what Nakama reports, and a link token is rejected whatever it is.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { FakeContext, loadBundleForTest } from './_stubs';

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

interface LinkOk { linked: true; providers: string[]; bonusClaimed: boolean; newBalance?: { coins: number; gems: number } }
interface Opened { conflictToken: string; expiresAt: string; target: { userId: string; profile: { coins: number } } }
interface Resolved { resolved: 'linked' | 'cancelled'; affectedAccountDeleted?: boolean; relinkProviders?: string[] }

/** The token format the removed `account/token.ts` accepted, signed with its old secret. */
function legacyToken(provider: string, customId: string): string {
  const payload = Buffer.from(JSON.stringify({ provider, customId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const sig = createHmac('sha256', ['p5v4', 'account', 'link', 'test', 'secret', 'do', 'not', 'ship'].join('-'))
    .update(payload).digest('base64url');
  return `v1.${provider}.${payload}.${sig}`;
}

describe('account_link (native linking)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => { env = loadBundleForTest(); });

  it('a token signed with the old bundled secret is rejected and links nothing', () => {
    const r = call<Resp<unknown>>(env, 'account_link', USER_A, { provider: 'email', token: legacyToken('email', 'x@example.com') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
    expect(r.error.details).toEqual({ reason: 'NATIVE_LINK_REQUIRED' });
    expect(env.fakeNakama.identities.has(USER_A)).toBe(false);
    expect(env.fakeNakama.wallets.get(USER_A)?.['coins'] ?? 0).toBe(0);
  });

  it('the bundle no longer contains the secret', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const bundle = readFileSync(resolve(__dirname, '..', '..', 'modules', 'index.js'), 'utf8');
    expect(bundle.includes('account-link-test-secret')).toBe(false);
  });

  it('without a linked identity → CONFLICT NOT_LINKED, no bonus', () => {
    env.fakeNakama.linkIdentity(USER_A, 'devices', 'dev-a');
    const r = call<Resp<unknown>>(env, 'account_link', USER_A, {});
    expect(r.ok ? 'ok' : r.error.code).toBe('CONFLICT');
    if (!r.ok) expect((r.error.details as { reason: string }).reason).toBe('NOT_LINKED');
  });

  it('after a native link: providers, 500 coins once', () => {
    env.fakeNakama.linkIdentity(USER_A, 'googleId', 'g-a');
    const first = call<Resp<LinkOk>>(env, 'account_link', USER_A, { provider: 'google' });
    expect(first).toEqual({ ok: true, data: { linked: true, providers: ['google'], bonusClaimed: true, newBalance: { coins: 500, gems: 0 } } });
    env.fakeNakama.linkIdentity(USER_A, 'email', 'a@example.com');
    const second = call<Resp<LinkOk>>(env, 'account_link', USER_A, {});
    expect(second.ok && second.data.bonusClaimed).toBe(false);
    expect(second.ok && second.data.providers).toEqual(['google', 'email']);
    expect(env.fakeNakama.wallets.get(USER_A)?.['coins']).toBe(500);
  });

  it('a provider the account does not have → CONFLICT', () => {
    env.fakeNakama.linkIdentity(USER_A, 'googleId', 'g-a');
    const r = call<Resp<unknown>>(env, 'account_link', USER_A, { provider: 'apple' });
    expect(r.ok ? 'ok' : r.error.code).toBe('CONFLICT');
  });
});

describe('account_link_resolve_conflict (identity verified by Nakama)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    // B already owns the email; A's native link fails with "already in use".
    env.fakeNakama.linkIdentity(USER_B, 'email', 'shared@example.com');
    expect(() => env.fakeNakama.linkIdentity(USER_A, 'email', 'shared@example.com')).toThrow(/already in use/);
  });

  function open(): Opened {
    // The client authenticated as B with the identity (create: false).
    const r = call<Resp<Opened>>(env, 'account_link_resolve_conflict', USER_B, { step: 'open' });
    if (!r.ok) throw new Error(`open failed: ${r.error.code}`);
    return r.data;
  }

  it('cancel → A and B stay separate', () => {
    const o = open();
    expect(o.target.userId).toBe(USER_B);
    const r = call<Resp<Resolved>>(env, 'account_link_resolve_conflict', USER_A, { conflictToken: o.conflictToken, choice: 'cancel' });
    expect(r).toEqual({ ok: true, data: { resolved: 'cancelled' } });
    expect(env.fakeNakama.findIdentityOwner('email', 'shared@example.com')).toBe(USER_B);
  });

  it('link → B deleted with its data; A links the email natively and gets the bonus', () => {
    call<Resp<unknown>>(env, 'garage_get', USER_B, {});
    expect(env.fakeNakama.store.has(`garage/${USER_B}/${USER_B}`)).toBe(true);
    const o = open();
    const r = call<Resp<Resolved>>(env, 'account_link_resolve_conflict', USER_A, {
      step: 'resolve', conflictToken: o.conflictToken, choice: 'link', confirmText: 'TRANSFER',
    });
    expect(r).toEqual({ ok: true, data: { resolved: 'linked', affectedAccountDeleted: true, relinkProviders: ['email'] } });
    expect(env.fakeNakama.store.has(`garage/${USER_B}/${USER_B}`)).toBe(false);
    expect(env.fakeNakama.deletedAccounts.has(USER_B)).toBe(true);

    env.fakeNakama.linkIdentity(USER_A, 'email', 'shared@example.com');
    const linked = call<Resp<LinkOk>>(env, 'account_link', USER_A, { provider: 'email' });
    expect(linked.ok && linked.data.bonusClaimed).toBe(true);
  });

  it('a token cannot be minted by the account that stays (it needs B’s session)', () => {
    // A has nothing linked, so A cannot open a conflict naming B.
    const r = call<Resp<unknown>>(env, 'account_link_resolve_conflict', USER_A, { step: 'open' });
    expect(r.ok).toBe(false);
    const bogus = call<Resp<unknown>>(env, 'account_link_resolve_conflict', USER_A, {
      conflictToken: 'not-a-token', choice: 'link', confirmText: 'TRANSFER',
    });
    expect(bogus.ok ? 'ok' : bogus.error.code).toBe('NOT_FOUND');
    expect(env.fakeNakama.deletedAccounts.has(USER_B)).toBe(false);
  });
});
