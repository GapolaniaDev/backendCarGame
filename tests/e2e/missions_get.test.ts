// Phase 6 Chunk 3 e2e — `missions_get` end-to-end against the bundled
// runtime.
//
// Covers the 6 cases from the peer spec:
//   1. New user level=1 → all daily/weekly missions returned with `locked: true`
//   2. Player level=3 → some unlocked, all returned
//   3. Determinism: second call returns the SAME missionId array (same dateUtc)
//   4. Different userId → different missionId array
//   5. mission_claim on a non-completed mission → INVALID_RESULT
//   6. mission_claim on a missing missionId → NOT_FOUND
//   7. missions_get is maintenance-gated (returns INTERNAL when liveops

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

const USER = 'user-missions-e2e';
const USER_B = 'user-missions-e2e-b';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface MissionCard {
  instanceId: string;
  missionId: string;
  title: string;
  description: string;
  kind: string;
  filters: Record<string, unknown>;
  target: number;
  reward: Record<string, number | string | undefined>;
  progress: number;
  completed: boolean;
  claimed: boolean;
  locked: boolean;
}

interface MissionAssignment {
  dateUtc?: string;
  weekUtc?: string;
  assignedAt: number;
  rerollsLeftToday: number;
  missions: MissionCard[];
}

interface MissionsGetOutput {
  daily: MissionAssignment;
  weekly: MissionAssignment;
  rerollsLeftToday: number;
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

function callMissionsGet(env: LoadedBundle, userId: string): Resp<MissionsGetOutput> {
  return call<Resp<MissionsGetOutput>>(
    env,
    'missions_get',
    userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callMissionClaim(
  env: LoadedBundle,
  userId: string,
  missionId: string,
  kind: 'daily' | 'weekly',
): Resp<unknown> {
  return call<Resp<unknown>>(
    env,
    'mission_claim',
    userId,
    { callerUserId: userId, missionId, kind, clientVersion: '1.0.0', platform: 'ios' },
  );
}

/** Set the player's level by writing a profile row. */
function setPlayerLevel(env: LoadedBundle, userId: string, level: number): void {
  const compositeKey = `profiles/${userId}/${userId}`;
  env.fakeNakama.store.set(compositeKey, {
    collection: 'profiles',
    key: userId,
    userId,
    value: { progression: { level, xp: 0 } },
    version: 'v00000001',
    permissionRead: 1,
    permissionWrite: 1,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

/** Enable maintenance mode by overwriting the liveops config in storage. */
function setMaintenance(env: LoadedBundle): void {
  // The boot path inserts a config at LIVEOPS_STORAGE_KEY using the bundled
  // default — replace it with the minimum VALID shape (validator requires
  // non-empty `regions`) and maintenance=true.
  const cfg = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: true },
    minClientVersion: {
      ios: '0.1.0',
      android: '0.1.0',
      windows: '0.1.0',
      macos: '0.1.0',
      linux: '0.1.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  } as const;
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: cfg as unknown as Record<string, unknown>,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: stored?.createTime ?? new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('missions_get e2e (Phase 6 Chunk 3)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('returns 3 daily + 3 weekly for a new level=1 user, all locked (D5)', () => {
    const res = callMissionsGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.daily.missions.length).toBe(3);
    expect(res.data.weekly.missions.length).toBe(3);
    // Catalog has minimum unlockLevel=3, so a level=1 player sees them all as locked.
    for (const m of res.data.daily.missions) {
      expect(m.locked).toBe(true);
    }
    for (const m of res.data.weekly.missions) {
      expect(m.locked).toBe(true);
    }
    expect(res.data.daily.rerollsLeftToday).toBe(1);
    expect(res.data.daily.dateUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.data.weekly.weekUtc).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('returns some unlocked when playerLevel=3', () => {
    setPlayerLevel(env, USER, 3);
    const res = callMissionsGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Catalog has many unlockLevel=3 missions → at least one of the 3 must be unlocked.
    const dailyUnlocked = res.data.daily.missions.filter((m) => !m.locked);
    expect(dailyUnlocked.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic — second call same dateUtc returns the same missions', () => {
    const a = callMissionsGet(env, USER);
    const b = callMissionsGet(env, USER);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.daily.missions.map((m) => m.missionId))
      .toEqual(b.data.daily.missions.map((m) => m.missionId));
    expect(a.data.weekly.missions.map((m) => m.missionId))
      .toEqual(b.data.weekly.missions.map((m) => m.missionId));
  });

  it('returns different missions for a different userId (high probability)', () => {
    // With 22 catalog entries and 3 picked per user, two distinct userIds
    // produce collision in ~5% of cases. Loop ten times to span better.
    let differed = false;
    for (let i = 0; i < 10; i++) {
      const a = callMissionsGet(env, `${USER}-${i}`);
      const b = callMissionsGet(env, `${USER_B}-${i}`);
      if (!a.ok || !b.ok) continue;
      const ai = a.data.daily.missions.map((m) => m.missionId);
      const bi = b.data.daily.missions.map((m) => m.missionId);
      if (JSON.stringify(ai) !== JSON.stringify(bi)) {
        differed = true;
        break;
      }
    }
    expect(differed).toBe(true);
  });

  it('mission_claim on a non-completed mission returns INVALID_RESULT', () => {
    const res = callMissionsGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.data.daily.missions[0]!;
    const claim = callMissionClaim(env, USER, m.missionId, 'daily');
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error.code).toBe('INVALID_RESULT');
    }
  });

  it('mission_claim on an unknown missionId returns NOT_FOUND', () => {
    const claim = callMissionClaim(env, USER, 'definitely_not_a_real_mission', 'daily');
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error.code).toBe('NOT_FOUND');
    }
  });

  it('mission_claim with kind=weekly returns NOT_FOUND for a daily-only missionId', () => {
    const res = callMissionsGet(env, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dailyMission = res.data.daily.missions[0]!;
    const claim = callMissionClaim(env, USER, dailyMission.missionId, 'weekly');
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error.code).toBe('NOT_FOUND');
    }
  });

  it('is maintenance-gated — returns SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    setMaintenance(env);
    // Verify storage was updated as expected.
    const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    if (stored) {
      const v = stored.value as { flags?: { maintenance?: boolean } };
      expect(v.flags?.maintenance).toBe(true);
    }
    const res = callMissionsGet(env, USER);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    // Caller is authenticated as USER, body claims USER_B
    const handler = env.resolver('missions_get');
    if (!handler) throw new Error('no rpc: missions_get');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({ callerUserId: USER_B });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('FORBIDDEN');
    }
  });
});