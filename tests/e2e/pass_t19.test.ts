// Plan T-19 (HT Prog-1, 3, 5, 6; audit 06 6.4.5, 6.4.6, 6.5.4): the
// battle pass through the bundle.
//   - pass_claim: the claim mark, the coins and the garage items are one
//     transaction; two racing claims pay once; a claim that loses its CAS
//     to an XP grant retries on the fresh record (no lost update);
//     reward items missing from the catalogs come back in `undelivered`.
//   - pass_buy_premium: without gems nothing changes; charge and flag
//     commit together.
//   - season close: admin_pass_season_close settles EVERY record of the
//     season, sends the unclaimed levels to the inbox once, and a closed
//     season refuses claims.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, SYSTEM_USER_ID, loadBundleForTest } from './_stubs';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type Env = ReturnType<typeof loadBundleForTest>;
type AnyFn = (...args: unknown[]) => unknown;

const ADMIN_KEY = 'test-admin-key';
const U1 = 'pass-u1';

function call<T>(env: Env, rpc: string, caller: string | null, payload: Record<string, unknown> = {}): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  return JSON.parse(handler(ctx, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function wrap(env: Env, name: string, make: (original: AnyFn) => AnyFn): () => void {
  const target = env.nak as unknown as Record<string, AnyFn>;
  const original = target[name] as AnyFn;
  target[name] = make(original.bind(env.nak));
  return () => { target[name] = original; };
}

function passRecord(env: Env, userId: string): Record<string, unknown> {
  return env.fakeNakama.store.get(`pass/${userId}/${userId}`)?.value as Record<string, unknown>;
}

/** Overwrite a pass record field as the server would (new version). */
function patchPass(env: Env, userId: string, patch: Record<string, unknown>): void {
  const cur = env.fakeNakama.store.get(`pass/${userId}/${userId}`);
  if (cur === undefined) throw new Error('no pass record');
  env.nak.storageWrite([{
    collection: 'pass', key: userId, userId,
    value: { ...(cur.value as Record<string, unknown>), ...patch },
    permissionRead: 1, permissionWrite: 0, version: cur.version as string,
  }]);
}

function coins(env: Env, userId: string): number {
  return env.fakeNakama.wallets.get(userId)?.['coins'] ?? 0;
}

function seedAdminKey(env: Env): void {
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
    version: 'v-liveops', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

describe('T-19 pass_claim', () => {
  let env: Env;
  beforeEach(() => {
    env = loadBundleForTest();
    call(env, 'pass_get', U1);
  });

  it('two racing claims of one level pay once (one ok, one CONFLICT)', () => {
    const answers: Array<Resp<unknown>> = [];
    let raced = false;
    // The second claim runs while the first is about to commit: both read
    // the same record and balance.
    wrap(env, 'multiUpdate', (original) => (...args: unknown[]) => {
      const writes = (args[1] as Array<{ collection: string }> | undefined) ?? [];
      if (!raced && writes.some((w) => w.collection === 'pass')) {
        raced = true;
        answers.push(call(env, 'pass_claim', U1, { level: 1, track: 'free' }));
      }
      return original(...args);
    });
    answers.push(call(env, 'pass_claim', U1, { level: 1, track: 'free' }));
    const codes = answers.map((a) => (a.ok ? 'ok' : a.error.code)).sort();
    expect(codes).toEqual(['CONFLICT', 'ok']);
    expect(coins(env, U1)).toBe(200);
    expect(env.fakeNakama.ledger.get(U1) ?? []).toHaveLength(1);
    expect(passRecord(env, U1)['claimedFree']).toEqual([1]);
  });

  it('a claim that loses its CAS to an XP grant keeps that XP (no lost update)', () => {
    let once = true;
    wrap(env, 'multiUpdate', (original) => (...args: unknown[]) => {
      if (once) {
        once = false;
        patchPass(env, U1, { xp: 777 }); // a race XP grant lands first
      }
      return original(...args);
    });
    const r = call<{ newXp: number }>(env, 'pass_claim', U1, { level: 1, track: 'free' });
    expect(r.ok).toBe(true);
    expect(passRecord(env, U1)).toMatchObject({ xp: 777, claimedFree: [1] });
    expect(coins(env, U1)).toBe(200);
  });

  it('a failed payout leaves the level claimable and pays nothing', () => {
    const restore = wrap(env, 'multiUpdate', () => () => {
      throw new Error('error running multi update: database unavailable');
    });
    const r = call(env, 'pass_claim', U1, { level: 1, track: 'free' });
    expect(r.ok).toBe(false);
    expect(passRecord(env, U1)['claimedFree']).toEqual([]);
    restore();
    expect(call(env, 'pass_claim', U1, { level: 1, track: 'free' }).ok).toBe(true);
    expect(coins(env, U1)).toBe(200);
  });

  it('a reward item missing from the catalogs is reported in undelivered, never invented', () => {
    env.fakeNakama.wallets.set(U1, { coins: 0, gems: 5000 });
    expect(call(env, 'pass_buy_premium', U1).ok).toBe(true);
    patchPass(env, U1, { xp: 200 }); // level 2: premium reward paint_winter01 (not in cosmetics.json)
    const r = call<{ undelivered?: string[]; granted: { skippedCosmetics: string[] } }>(
      env, 'pass_claim', U1, { level: 2, track: 'premium' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.undelivered).toEqual(['cosmetic:paint_winter01']);
    expect(r.data.granted.skippedCosmetics).toEqual(['paint_winter01']);
    expect(passRecord(env, U1)['claimedPremium']).toEqual([2]);
    expect(env.fakeLogger.lines.some((l) => /reward item not in catalog: cosmetic:paint_winter01/.test(l))).toBe(true);
  });
});

describe('T-19 pass_buy_premium', () => {
  it('without enough gems changes nothing', () => {
    const env = loadBundleForTest();
    env.fakeNakama.wallets.set(U1, { coins: 0, gems: 10 });
    const r = call(env, 'pass_buy_premium', U1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(passRecord(env, U1)['premiumPurchased']).toBe(false);
    expect(env.fakeNakama.wallets.get(U1)).toEqual({ coins: 0, gems: 10 });
    expect(env.fakeNakama.ledger.get(U1) ?? []).toHaveLength(0);
  });

  it('charges once and a second call charges nothing', () => {
    const env = loadBundleForTest();
    env.fakeNakama.wallets.set(U1, { coins: 0, gems: 2000 });
    const first = call<{ priceGems: number }>(env, 'pass_buy_premium', U1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(call(env, 'pass_buy_premium', U1).ok).toBe(true);
    expect(env.fakeNakama.wallets.get(U1)?.['gems']).toBe(2000 - first.data.priceGems);
    expect(passRecord(env, U1)['premiumPurchased']).toBe(true);
  });
});

describe('T-19 season close settles every player', () => {
  it('pays the unclaimed reached levels of all three players to the inbox, once', () => {
    const env = loadBundleForTest();
    seedAdminKey(env);
    const drill = 'drill_s0';
    const players = ['close-a', 'close-b', 'close-c'];
    for (const u of players) {
      call(env, 'pass_get', u);
      patchPass(env, u, { seasonId: drill, xp: 400 }); // levels 1-3 reached (free: 200 + 200 + 250 coins)
    }
    patchPass(env, 'close-b', { claimedFree: [1] }); // B already claimed level 1

    const run = call<{ state: string; settled: number }>(env, 'admin_pass_season_close', null, { adminKey: ADMIN_KEY, seasonId: drill });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data).toMatchObject({ state: 'settled', settled: 3 });

    const expected: Record<string, number> = { 'close-a': 650, 'close-b': 450, 'close-c': 650 };
    for (const u of players) {
      const list = call<{ messages: Array<{ id: string; reward?: { coins?: number } }> }>(env, 'inbox_list', u);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const msg = list.data.messages.find((m) => m.id === `pass_end:${drill}`);
      expect(msg?.reward?.coins).toBe(expected[u]);
      expect(passRecord(env, u)).toMatchObject({ seasonClosed: true });
      expect(call(env, 'inbox_claim', u, { messageId: `pass_end:${drill}` }).ok).toBe(true);
      expect(coins(env, u)).toBe(expected[u]);
    }

    // Running the close again sends nothing new.
    const again = call<{ state: string }>(env, 'admin_pass_season_close', null, { adminKey: ADMIN_KEY, seasonId: drill });
    expect(again.ok && again.data.state).toBe('settled');
    const msgs = [...env.fakeNakama.store.values()].filter((o) => o.collection === 'inbox' && String(o.key).includes(drill));
    expect(msgs).toHaveLength(3);
  });

  it('refuses to close the loaded season before it ends, and needs the admin key', () => {
    const env = loadBundleForTest();
    seedAdminKey(env);
    const early = call(env, 'admin_pass_season_close', null, { adminKey: ADMIN_KEY });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe('CONFLICT');
    const noKey = call(env, 'admin_pass_season_close', null, { seasonId: 'x' });
    expect(noKey.ok).toBe(false);
  });

  it('a closed season refuses pass_claim and pass_buy_premium', () => {
    const env = loadBundleForTest();
    call(env, 'pass_get', U1);
    const seasonId = String(passRecord(env, U1)['seasonId']);
    env.nak.storageWrite([{
      collection: 'season_close', key: seasonId, userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, closedAt: 1, state: 'settling', cursor: '', settled: 0 },
      permissionRead: 1, permissionWrite: 0,
    }]);
    const claim = call(env, 'pass_claim', U1, { level: 1, track: 'free' });
    expect(!claim.ok && claim.error.code).toBe('CONFLICT');
    const buy = call(env, 'pass_buy_premium', U1);
    expect(!buy.ok && buy.error.code).toBe('CONFLICT');
  });
});
