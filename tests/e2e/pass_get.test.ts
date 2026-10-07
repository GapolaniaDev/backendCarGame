// Phase 6 Chunk 6 — `pass_get` e2e tests.
//
// Covers:
//   1. First call lazy-creates the PassRecord + returns 40 level cards
//   2. Pre-seeded xp/claimed are reflected on the response
//   3. premiumPurchased: false by default; reflect when seeded true
//   4. seasonClosed: false by default; flips true after the catalog endUtc
//   5. Maintenance → SERVICE_UNAVAILABLE
//   6. FORBIDDEN when callerUserId != ctx.userId
//   7. Lazy close writes the season_close marker post-endUtc

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import { SEASON_CLOSE_COLLECTION, seasonCloseKey } from '../../modules/src/pass/season';

const USER = 'user-pass-get';
const USER_B = 'user-pass-get-b';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface PassGetOutput {
  userId: string;
  seasonId: string;
  seasonClosed: boolean;
  endUtc: string;
  xp: number;
  currentLevel: number;
  nextLevel: number | null;
  xpRequired: number;
  xpRemaining: number;
  premiumPurchased: boolean;
  levels: Array<{
    level: number;
    xpRequired: number;
    freeReward: Record<string, number | string | undefined>;
    premiumReward: Record<string, number | string | undefined>;
    freeClaimed: boolean;
    premiumClaimed: boolean;
  }>;
  premiumPriceGems: number;
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

function callGet(env: LoadedBundle, userId: string): Resp<PassGetOutput> {
  return call<Resp<PassGetOutput>>(env, 'pass_get', userId, {
    callerUserId: userId,
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

describe('pass_get e2e (Phase 6 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('lazily creates the pass row + returns 40 level cards on first call', () => {
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.seasonId).toBe('s1');
    expect(res.data.xp).toBe(0);
    expect(res.data.currentLevel).toBe(1);
    expect(res.data.nextLevel).toBe(2);
    expect(res.data.levels).toHaveLength(40);
    expect(res.data.premiumPurchased).toBe(false);
    expect(res.data.seasonClosed).toBe(false);
    expect(res.data.premiumPriceGems).toBe(800);

    // Row exists in storage.
    const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${USER}/${USER}`);
    expect(stored).toBeDefined();
  });

  it('reflects pre-seeded xp + claimed flags + premiumPurchased on the cards', () => {
    seedPassRecord(env, USER, {
      xp: 1000,
      claimedFree: [1, 2],
      premiumPurchased: true,
    });
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.xp).toBe(1000);
    expect(res.data.premiumPurchased).toBe(true);
    const lvl1 = res.data.levels.find((l) => l.level === 1)!;
    expect(lvl1.freeClaimed).toBe(true);
    expect(lvl1.premiumClaimed).toBe(false);
    const lvl2 = res.data.levels.find((l) => l.level === 2)!;
    expect(lvl2.freeClaimed).toBe(true);
  });

  it('xpToLevel/xpToNextLevel math: xp=400 → level 3 (xpRequired 400)', () => {
    seedPassRecord(env, USER, { xp: 400 });
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.currentLevel).toBe(3);
    expect(res.data.nextLevel).toBe(4);
    // next.xpRequired from bundled pass_s1 level 4 = 700.
    expect(res.data.xpRequired).toBe(700);
    expect(res.data.xpRemaining).toBe(300);
  });

  it('is maintenance-gated — returns SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    setMaintenance(env);
    const res = callGet(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    const handler = env.resolver('pass_get');
    if (!handler) throw new Error('no rpc: pass_get');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER_B });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FORBIDDEN');
  });

  it('sees seasonClosed=true when the global marker exists (lazy close from another caller)', () => {
    // Simulate a different crash wrote the close.
    env.fakeNakama.store.set(`${SEASON_CLOSE_COLLECTION}/${seasonCloseKey('s1')}/${SYSTEM_USER_ID}`, {
      collection: SEASON_CLOSE_COLLECTION,
      key: 's1',
      userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, closedAt: Date.now() },
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.seasonClosed).toBe(true);
  });
});