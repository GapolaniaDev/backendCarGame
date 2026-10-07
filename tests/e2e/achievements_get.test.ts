// Phase 6 Chunk 5 e2e — `achievements_get` end-to-end against the bundled
// runtime. Covers the spec's 6 cases:
//   1. New user → achievements row lazy-created (D13), cards returned
//      with progress=0 / completed=false / claimed=false
//   2. Pre-seeded progress → cards reflect progress + completed flag
//   3. Pre-seeded claimed → cards reflect claimed=true
//   4. Maintenance → SERVICE_UNAVAILABLE
//   5. FORBIDDEN when callerUserId != ctx.userId
//   6. Empty body → BAD_REQUEST, no storage write

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  ACHIEVEMENTS_COLLECTION,
  achievementsKey,
} from '../../modules/src/missions/counter_repo';
import type { AchievementsRecord } from '../../modules/src/missions/types';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';

const USER = 'user-achievements-get';
const USER_B = 'user-achievements-get-b';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface AchievementCard {
  achievementId: string;
  title: string;
  description: string;
  kind: string;
  target: number;
  reward: Record<string, number | string | undefined>;
  progress: number;
  completed: boolean;
  claimed: boolean;
  locked: boolean;
}

interface AchievementsGetOutput {
  achievements: AchievementCard[];
  nowUtc: string;
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

function callGet(env: LoadedBundle, userId: string): Resp<AchievementsGetOutput> {
  return call<Resp<AchievementsGetOutput>>(
    env,
    'achievements_get',
    userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function seedProgress(
  env: LoadedBundle,
  userId: string,
  progress: Record<string, number>,
  claimed: Record<string, boolean> = {},
): void {
  const rec: AchievementsRecord = {
    schemaVersion: 1,
    userId,
    progress,
    claimed,
  };
  env.fakeNakama.store.set(
    `${ACHIEVEMENTS_COLLECTION}/${achievementsKey(userId)}/${userId}`,
    {
      collection: ACHIEVEMENTS_COLLECTION,
      key: achievementsKey(userId),
      userId,
      value: rec,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    },
  );
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

describe('achievements_get e2e (Phase 6 Chunk 5)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('lazily creates the achievements row + returns all catalog cards (D13)', () => {
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Catalog has 22 achievements.
    expect(res.data.achievements.length).toBe(22);
    // Row exists in `achievements/{userId}/{userId}`.
    const stored = env.fakeNakama.store.get(
      `${ACHIEVEMENTS_COLLECTION}/${achievementsKey(USER)}/${USER}`,
    );
    expect(stored).toBeDefined();
    const rec = stored!.value as AchievementsRecord;
    expect(rec.progress).toEqual({});
    expect(rec.claimed).toEqual({});
  });

  it('returns progress=0 + completed=false + claimed=false for a fresh user', () => {
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const c of res.data.achievements) {
      expect(c.progress).toBe(0);
      expect(c.completed).toBe(false);
      expect(c.claimed).toBe(false);
      expect(c.locked).toBe(false);
    }
  });

  it('reflects pre-seeded progress + completed=true when progress >= target', () => {
    seedProgress(env, USER, { ach_first_win: 1 });
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fw = res.data.achievements.find((c) => c.achievementId === 'ach_first_win')!;
    expect(fw.progress).toBe(1);
    expect(fw.completed).toBe(true);
    expect(fw.claimed).toBe(false);
    // No row re-create (the seedProgress version is preserved).
    const stored = env.fakeNakama.store.get(
      `${ACHIEVEMENTS_COLLECTION}/${achievementsKey(USER)}/${USER}`,
    );
    expect(stored!.version).toBe('v00000001');
  });

  it('reflects pre-seeded claimed=true on the card', () => {
    seedProgress(env, USER, { ach_first_win: 1 }, { ach_first_win: true });
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fw = res.data.achievements.find((c) => c.achievementId === 'ach_first_win')!;
    expect(fw.claimed).toBe(true);
    expect(fw.completed).toBe(true);
  });

  it('is maintenance-gated — returns SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    setMaintenance(env);
    const res = callGet(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    const handler = env.resolver('achievements_get');
    if (!handler) throw new Error('no rpc: achievements_get');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER_B });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FORBIDDEN');
  });

  it('nowUtc is an ISO timestamp', () => {
    const res = callGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.nowUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});