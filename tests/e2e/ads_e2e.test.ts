// Phase 9 Chunk 5 / T-25 (PC-05) — e2e tests for rewarded ads.
//
// Through the built bundle:
//   - `ad_watched` (the client's call) never pays;
//   - `ads_levelplay_callback` (LevelPlay S2S, http_key, no session) pays
//     once per signed event: md5(timestamp + eventId + userId + rewards +
//     LEVELPLAY_S2S_PRIVATE_KEY), answer `<eventId>:OK`;
//   - a repeated event answers OK again without paying; a bad signature
//     or an empty secret pays nothing and has no `:OK`;
//   - the amount must be a catalog tier; the daily cap (10) holds;
//   - `ad_reward_status` lists the caller's callback rewards.

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest, FakeNakama, FakeContext } from './_stubs';
import type { LoadedBundle } from './_stubs';
import type { IContext, ILogger } from '../../modules/src/nkruntime';

const REAL_NOW = Date.now();
const KEY = 'local-test-private-key';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

type Env = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; details?: { reason?: string } } };

function invoke(bundle: LoadedBundle, nk: FakeNakama, rpc: string, ctx: IContext, body: string): { raw: string; env: Env } {
  const handler = bundle.resolver(rpc);
  if (!handler) throw new Error(`${rpc} RPC not registered`);
  const raw = handler(ctx, mkLogger(), nk.nakama, body);
  return { raw, env: JSON.parse(raw) as Env };
}

const sign = (ts: string, eventId: string, userId: string, rewards: string, key = KEY): string =>
  createHash('md5').update(`${ts}${eventId}${userId}${rewards}${key}`).digest('hex');

/** A LevelPlay callback as Nakama hands it: query params, no session, runtime.env. */
function callback(
  bundle: LoadedBundle,
  nk: FakeNakama,
  q: { userId?: string; eventId: string; rewards: string; timestamp?: string; signature?: string; userField?: string },
  env: Record<string, string> = { LEVELPLAY_S2S_PRIVATE_KEY: KEY },
): { raw: string; env: Env } {
  const userId = q.userId ?? USER;
  const timestamp = q.timestamp ?? '202610230015';
  const signature = q.signature ?? sign(timestamp, q.eventId, userId, q.rewards);
  const queryParams: Record<string, string[]> = {
    [q.userField ?? 'userId']: [userId], eventId: [q.eventId], rewards: [q.rewards],
    timestamp: [timestamp], signature: [signature], placementName: ['DefaultRewardedVideo'], unwrap: [''],
  };
  const ctx = { ...FakeContext, env, queryParams } as unknown as IContext;
  return invoke(bundle, nk, 'ads_levelplay_callback', ctx, '');
}

const coins = (nk: FakeNakama, uid = USER): number => nk.wallets.get(uid)?.['coins'] ?? 0;

describe('rewarded ads e2e (Phase 9 Chunk 5, T-25)', () => {
  let bundle: LoadedBundle;
  let nk: FakeNakama;

  beforeEach(() => {
    bundle = loadBundleForTest();
    nk = new FakeNakama();
  });

  it('ad_watched from the client pays nothing (granted: false, coinsGranted: 0)', () => {
    const ctx = { ...FakeContext, userId: USER } as IContext;
    const r = invoke(bundle, nk, 'ad_watched', ctx, JSON.stringify({
      tier: 'xlarge', provider: 'mock', adUnitId: 'u', impressionId: '550e8400-e29b-41d4-a716-446655440000', watchedAtUtc: REAL_NOW,
    })).env;
    expect(r.ok).toBe(true);
    expect(r.data!['coinsGranted']).toBe(0);
    expect(r.data!['granted']).toBe(false);
    expect(r.data!['rewardVia']).toBe('server_callback');
    expect(coins(nk)).toBe(0);
    expect(nk.ledger.get(USER) ?? []).toHaveLength(0);
  });

  it('ad_watched still validates its input and keeps the maintenance bypass', () => {
    const ctx = { ...FakeContext, userId: USER } as IContext;
    expect(invoke(bundle, nk, 'ad_watched', ctx, JSON.stringify({ tier: 'huge' })).env.error?.code).toBe('BAD_REQUEST');
    nk.nakama.storageWrite([{
      collection: 'liveops', key: 'config', userId: '00000000-0000-0000-0000-000000000000',
      value: { version: 1, flags: { maintenance: true, maintenanceMessage: 'down' } }, permissionRead: 1, permissionWrite: 0,
    }]);
    const r = invoke(bundle, nk, 'ad_watched', ctx, JSON.stringify({
      tier: 'small', provider: 'levelplay', adUnitId: 'u', impressionId: 'imp-1', watchedAtUtc: REAL_NOW,
    })).env;
    expect(r.ok).toBe(true);
  });

  it('a signed callback pays once and answers <eventId>:OK; a repeat answers OK without paying', () => {
    const first = callback(bundle, nk, { eventId: 'evt0001', rewards: '15' });
    expect(first.env.ok).toBe(true);
    expect(first.raw).toContain('evt0001:OK');
    expect(first.env.data!['status']).toBe('granted');
    expect(first.env.data!['coinsGranted']).toBe(15);
    expect(coins(nk)).toBe(15);
    for (let i = 0; i < 3; i += 1) {
      const again = callback(bundle, nk, { eventId: 'evt0001', rewards: '15' });
      expect(again.raw).toContain('evt0001:OK');
      expect(again.env.data!['idempotent']).toBe(true);
    }
    expect(coins(nk)).toBe(15);
    expect((nk.ledger.get(USER) ?? []).length).toBe(1);
  });

  it('after a restart (fresh VM) the repeated event still does not pay', () => {
    callback(bundle, nk, { eventId: 'evtrestart', rewards: '5' });
    const again = callback(loadBundleForTest(), nk, { eventId: 'evtrestart', rewards: '5' });
    expect(again.raw).toContain('evtrestart:OK');
    expect(coins(nk)).toBe(5);
  });

  it('the documented user-id parameter names are accepted (applicationUserId, appUserId)', () => {
    expect(callback(bundle, nk, { eventId: 'evtapp1', rewards: '5', userField: 'applicationUserId' }).env.ok).toBe(true);
    expect(callback(bundle, nk, { eventId: 'evtapp2', rewards: '5', userField: 'appUserId' }).env.ok).toBe(true);
    expect(coins(nk)).toBe(10);
  });

  it('a bad signature pays nothing and has no :OK', () => {
    const r = callback(bundle, nk, { eventId: 'evtbad', rewards: '60', signature: sign('202610230015', 'evtbad', USER, '60', 'wrong-key') });
    expect(r.env.ok).toBe(false);
    expect(r.env.error?.code).toBe('FORBIDDEN');
    expect(r.env.error?.details?.reason).toBe('BAD_SIGNATURE');
    expect(r.raw).not.toContain(':OK');
    // Tampering with a signed field (the amount) breaks the signature too.
    const tampered = callback(bundle, nk, { eventId: 'evtbad2', rewards: '60', signature: sign('202610230015', 'evtbad2', USER, '5') });
    expect(tampered.env.error?.code).toBe('FORBIDDEN');
    // Another user with this user's signature.
    const other = callback(bundle, nk, { eventId: 'evtbad3', rewards: '5', userId: OTHER, signature: sign('202610230015', 'evtbad3', USER, '5') });
    expect(other.env.error?.code).toBe('FORBIDDEN');
    expect(coins(nk)).toBe(0);
    expect(coins(nk, OTHER)).toBe(0);
  });

  it('with an empty secret every callback is rejected, even one signed with an empty key', () => {
    for (const env of [{}, { LEVELPLAY_S2S_PRIVATE_KEY: '' }, { LEVELPLAY_S2S_PRIVATE_KEY: '   ' }]) {
      const r = callback(bundle, nk, { eventId: 'evtnokey', rewards: '5', signature: sign('202610230015', 'evtnokey', USER, '5', '') }, env);
      expect(r.env.ok).toBe(false);
      expect(r.env.error?.code).toBe('SERVICE_UNAVAILABLE');
      expect(r.env.error?.details?.reason).toBe('NOT_CONFIGURED');
      expect(r.raw).not.toContain(':OK');
    }
    expect(coins(nk)).toBe(0);
  });

  it('a player session cannot call the callback (FORBIDDEN), even with a valid signature', () => {
    const ts = '202610230015';
    const queryParams = { userId: [USER], eventId: ['evtsess'], rewards: ['5'], timestamp: [ts], signature: [sign(ts, 'evtsess', USER, '5')] };
    const ctx = { ...FakeContext, userId: USER, env: { LEVELPLAY_S2S_PRIVATE_KEY: KEY }, queryParams } as unknown as IContext;
    expect(invoke(bundle, nk, 'ads_levelplay_callback', ctx, '{}').env.error?.code).toBe('FORBIDDEN');
    expect(coins(nk)).toBe(0);
  });

  it('missing or malformed parameters are BAD_REQUEST', () => {
    expect(callback(bundle, nk, { eventId: 'evt bad id', rewards: '5' }).env.error?.code).toBe('BAD_REQUEST');
    expect(callback(bundle, nk, { eventId: 'evtneg', rewards: '-5' }).env.error?.code).toBe('BAD_REQUEST');
    expect(coins(nk)).toBe(0);
  });

  it('an amount that is not a catalog tier is acknowledged and not paid', () => {
    const r = callback(bundle, nk, { eventId: 'evtamount', rewards: '1000' });
    expect(r.raw).toContain('evtamount:OK');
    expect(r.env.data!['status']).toBe('rejected_amount');
    expect(coins(nk)).toBe(0);
  });

  it('the daily cap (10) holds: the 11th event is acknowledged as capped and not paid', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(callback(bundle, nk, { eventId: `evtcap${i}`, rewards: '5' }).env.data!['status']).toBe('granted');
    }
    const eleventh = callback(bundle, nk, { eventId: 'evtcap10', rewards: '5' });
    expect(eleventh.raw).toContain('evtcap10:OK');
    expect(eleventh.env.data!['status']).toBe('capped');
    expect(coins(nk)).toBe(50);
  });

  it('a signed event for an unknown user is acknowledged without paying anyone', () => {
    const r = callback(bundle, nk, { eventId: 'evtnouser', rewards: '5', userId: 'not-a-nakama-id' });
    expect(r.raw).toContain('evtnouser:OK');
    expect(r.env.data!['status']).toBe('unknown_user');
  });

  it('ad_reward_status lists the caller rewards, newest first, with the daily count', () => {
    callback(bundle, nk, { eventId: 'evtst1', rewards: '5' });
    callback(bundle, nk, { eventId: 'evtst2', rewards: '30' });
    const ctx = { ...FakeContext, userId: USER } as IContext;
    const r = invoke(bundle, nk, 'ad_reward_status', ctx, '{}').env;
    expect(r.ok).toBe(true);
    const rewards = r.data!['rewards'] as Array<{ eventId: string; coins: number; status: string }>;
    expect(rewards.map((x) => x.eventId).sort()).toEqual(['evtst1', 'evtst2']);
    expect(r.data!['dailyCount']).toBe(2);
    expect(r.data!['dailyCap']).toBe(10);
    expect((r.data!['newBalance'] as { coins: number }).coins).toBe(35);
    const otherCtx = { ...FakeContext, userId: OTHER } as IContext;
    expect((invoke(bundle, nk, 'ad_reward_status', otherCtx, '{}').env.data!['rewards'] as unknown[]).length).toBe(0);
  });
});
