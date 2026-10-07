// Phase 6 Chunk 6 — `pass_buy_premium` e2e tests.
//
// Covers:
//   1. SUCCESS — wallet debited 800 gems, premiumPurchased=true persisted
//   2. INSUFFICIENT_FUNDS when wallet lacks gems
//   3. Idempotent — second call returns current state, no extra charge
//   4. CONFLICT when season is closed
//   5. Maintenance → SERVICE_UNAVAILABLE
//   6. FORBIDDEN caller mismatch

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';

const USER = 'user-pass-buy-premium';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface BuyPremiumOutput {
  userId: string;
  seasonId: string;
  premiumPurchased: true;
  priceGems: number;
  newGemsBalance: number;
}

function call<T>(
  env: LoadedBundle,
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

function callBuyPremium(env: LoadedBundle, userId: string): Resp<BuyPremiumOutput> {
  return call<Resp<BuyPremiumOutput>>(env, 'pass_buy_premium', userId, {
    callerUserId: userId,
    clientVersion: '1.0.0',
    platform: 'ios',
  });
}

function setGems(env: LoadedBundle, userId: string, gems: number): void {
  env.fakeNakama.wallets.set(userId, { coins: 0, gems });
}

function seedPassRecord(
  env: LoadedBundle,
  userId: string,
  data: Partial<{
    xp: number;
    claimedFree: number[];
    claimedPremium: number[];
    premiumPurchased: boolean;
    seasonClosed: boolean;
  }>,
  version = 'v00000001',
): void {
  env.fakeNakama.store.set(`${PASS_COLLECTION}/${passRecordKey(userId)}/${userId}`, {
    collection: PASS_COLLECTION,
    key: passRecordKey(userId),
    userId,
    value: {
      schemaVersion: 1,
      userId,
      seasonId: 's1',
      xp: data.xp ?? 0,
      claimedFree: data.claimedFree ?? [],
      claimedPremium: data.claimedPremium ?? [],
      premiumPurchased: data.premiumPurchased ?? false,
      seasonClosed: data.seasonClosed ?? false,
    },
    version,
    permissionRead: 1,
    permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function setMaintenance(env: LoadedBundle): void {
  const cfg = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: true },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  } as const;
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: cfg as unknown as LiveopsConfig,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: stored?.createTime ?? new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('pass_buy_premium e2e (Phase 6 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('SUCCESS — debits 800 gems + flips premiumPurchased=true', () => {
    setGems(env, USER, 1000);
    const res = callBuyPremium(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.priceGems).toBe(800);
    expect(res.data.premiumPurchased).toBe(true);
    expect(res.data.newGemsBalance).toBe(200);

    // Record persists.
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${USER}/${USER}`);
    expect((stored!.value as { premiumPurchased: boolean }).premiumPurchased).toBe(true);
  });

  it('INSUFFICIENT_FUNDS when gems < 800', () => {
    setGems(env, USER, 500);
    const res = callBuyPremium(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('idempotent — second call returns current state, no extra charge', () => {
    setGems(env, USER, 1000);
    const first = callBuyPremium(env, USER);
    expect(first.ok).toBe(true);
    const second = callBuyPremium(env, USER);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.premiumPurchased).toBe(true);
    // No double-charge.
    expect(env.fakeNakama.wallets.get(USER)?.gems).toBe(200);
  });

  it('CONFLICT when season is closed', () => {
    setGems(env, USER, 1000);
    seedPassRecord(env, USER, { seasonClosed: true });
    const res = callBuyPremium(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONFLICT');
  });

  it('is maintenance-gated — SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    setGems(env, USER, 1000);
    setMaintenance(env);
    const res = callBuyPremium(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    setGems(env, USER, 1000);
    const handler = env.resolver('pass_buy_premium');
    if (!handler) throw new Error('no rpc: pass_buy_premium');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({
      callerUserId: 'attacker',
      clientVersion: '1.0.0',
      platform: 'ios',
    });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FORBIDDEN');
  });
});