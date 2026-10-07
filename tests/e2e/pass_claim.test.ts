// Phase 6 Chunk 6 — `pass_claim` e2e tests.
//
// Covers:
//   1. NOT_FOUND when level is out of catalog range
//   2. NOT_FOUND when no pass row + INVALID_RESULT after lazy-create
//   3. INVALID_RESULT when xp < level.xpRequired
//   4. FORBIDDEN premium track without premiumPurchased
//   5. SUCCESS free — coins granted, claimedFree contains level
//   6. SUCCESS premium — coins + cosmetic, claimedPremium contains level
//   7. CONFLICT when claiming the same (level, track) twice
//   8. CONFLICT when season is closed
//   9. Maintenance gate → SERVICE_UNAVAILABLE
//   10. FORBIDDEN caller mismatch

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';

const USER = 'user-pass-claim';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface ClaimOutput {
  level: number;
  track: 'free' | 'premium';
  reward: Record<string, number | string | undefined>;
  granted: {
    coins: number;
    gems: number;
    cosmetics: string[];
    skippedCosmetics: string[];
    cars: string[];
    skippedCars: string[];
  };
  newXp: number;
  currentLevel: number;
  nextLevel: number | null;
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

function callClaim(
  env: LoadedBundle,
  userId: string,
  level: number,
  track: 'free' | 'premium',
): Resp<ClaimOutput> {
  return call<Resp<ClaimOutput>>(env, 'pass_claim', userId, {
    callerUserId: userId,
    level,
    track,
    clientVersion: '1.0.0',
    platform: 'ios',
  });
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

describe('pass_claim e2e (Phase 6 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('returns NOT_FOUND for out-of-range level', () => {
    seedPassRecord(env, USER, { xp: 0 });
    const res = callClaim(env, USER, 999, 'free');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('lazy-creates the row + returns INVALID_RESULT when xp=0 (not enough XP for any level)', () => {
    const res = callClaim(env, USER, 2, 'free');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_RESULT');
    // Row exists now (lazy-create).
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${USER}/${USER}`);
    expect(stored).toBeDefined();
  });

  it('returns INVALID_RESULT when xp < level.xpRequired', () => {
    seedPassRecord(env, USER, { xp: 100 });
    // Level 2 needs xpRequired 200.
    const res = callClaim(env, USER, 2, 'free');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_RESULT');
  });

  it('returns FORBIDDEN when claiming premium track without premiumPurchased', () => {
    seedPassRecord(env, USER, { xp: 1000, premiumPurchased: false });
    const res = callClaim(env, USER, 1, 'premium');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('SUCCESS free track: coins granted + claimedFree contains level', () => {
    seedPassRecord(env, USER, { xp: 0 });
    // Level 1 has freeReward { coins: 200 } per bundled pass_s1.
    const res = callClaim(env, USER, 1, 'free');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.level).toBe(1);
    expect(res.data.track).toBe('free');
    expect(res.data.reward.coins).toBe(200);
    expect(res.data.granted.coins).toBe(200);
    expect(env.fakeNakama.wallets.get(USER)?.coins).toBe(200);

    // claimedFree=[1] persisted.
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${USER}/${USER}`);
    expect((stored!.value as { claimedFree: number[] }).claimedFree).toContain(1);
  });

  it('SUCCESS premium track (with premiumPurchased): coins granted + premium ledger', () => {
    seedPassRecord(env, USER, { xp: 0, premiumPurchased: true });
    // Level 1 premium = { coins: 500 } per bundled pass_s1.
    const res = callClaim(env, USER, 1, 'premium');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.reward.coins).toBe(500);
    expect(env.fakeNakama.wallets.get(USER)?.coins).toBe(500);
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${USER}/${USER}`);
    expect((stored!.value as { claimedPremium: number[] }).claimedPremium).toContain(1);
  });

  it('returns CONFLICT when claiming the same (level, track) twice', () => {
    seedPassRecord(env, USER, { xp: 0 });
    const first = callClaim(env, USER, 1, 'free');
    expect(first.ok).toBe(true);
    const second = callClaim(env, USER, 1, 'free');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
  });

  it('returns CONFLICT when season is closed', () => {
    seedPassRecord(env, USER, { xp: 1000, seasonClosed: true });
    const res = callClaim(env, USER, 2, 'free');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONFLICT');
  });

  it('is maintenance-gated — SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    seedPassRecord(env, USER, { xp: 1000 });
    setMaintenance(env);
    const res = callClaim(env, USER, 1, 'free');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    seedPassRecord(env, USER, { xp: 1000 });
    const handler = env.resolver('pass_claim');
    if (!handler) throw new Error('no rpc: pass_claim');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({
      callerUserId: 'attacker',
      level: 1,
      track: 'free',
      clientVersion: '1.0.0',
      platform: 'ios',
    });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FORBIDDEN');
  });
});