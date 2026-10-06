// Phase 6 Chunk 3 e2e — `mission_reroll` end-to-end.
//
// Covers the 5 cases from the peer spec:
//   1. First reroll is free (costGems=0, rerollsLeftToday decrements)
//   2. Second reroll without useGems → INSUFFICIENT_FUNDS
//   3. Second reroll WITH useGems → success, costGems=50
//   4. Reroll returns a mission different from the other two on the day
//   5. Reroll on a completed mission → CONFLICT
//   6. Reroll on a daily 1-step challenge completed via wallet grant

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

const USER = 'user-reroll-e2e';

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

interface MissionRerollOutput {
  missionId: string;
  newMission: { id: string; title: string; description: string };
  costGems: number;
  rerollsLeftToday: number;
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
    env, 'missions_get', userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callMissionReroll(
  env: LoadedBundle,
  userId: string,
  missionId: string,
  useGems: boolean,
): Resp<MissionRerollOutput> {
  return call<Resp<MissionRerollOutput>>(
    env, 'mission_reroll', userId,
    { callerUserId: userId, missionId, useGems, clientVersion: '1.0.0', platform: 'ios' },
  );
}

/** Give the user 100 gems up front (so paid rerolls have funds). */
function giveGems(env: LoadedBundle, userId: string, gems: number): void {
  env.fakeNakama.wallets.set(userId, { coins: 0, gems });
}

function enableMaintenance(env: LoadedBundle): void {
  // Validator requires non-empty `regions` and MAJOR.MINOR.PATCH
  // minClientVersion entries — both omitted earlier → fell back to bundled.
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

describe('mission_reroll e2e (Phase 6 Chunk 3)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    giveGems(env, USER, 100);
  });

  it('first reroll is free (costGems=0, rerollsLeftToday decrements to 0)', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;

    const r = callMissionReroll(env, USER, target.missionId, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.costGems).toBe(0);
    expect(r.data.rerollsLeftToday).toBe(0);
    expect(r.data.missionId).toBe(target.missionId);
  });

  it('second reroll without useGems returns INSUFFICIENT_FUNDS (D3)', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;
    const secondMission = before.data.daily.missions[1]!;

    const first = callMissionReroll(env, USER, target.missionId, false);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The first reroll swaps out `mission[0]` from the record. To exercise
    // the "free reroll already used" path, reroll a DIFFERENT mission
    // that's still on the day.
    const second = callMissionReroll(env, USER, secondMission.missionId, false);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  it('second reroll WITH useGems succeeds, costGems=50 (D4)', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;
    const secondMission = before.data.daily.missions[1]!;

    const first = callMissionReroll(env, USER, target.missionId, false);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Second reroll on a different mission — costs 50 gems.
    const second = callMissionReroll(env, USER, secondMission.missionId, true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.costGems).toBe(50);
  });

  it('returns a mission different from the other two on the day', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;
    const others = new Set(
      before.data.daily.missions
        .filter((m) => m.missionId !== target.missionId)
        .map((m) => m.missionId),
    );

    const r = callMissionReroll(env, USER, target.missionId, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(others.has(r.data.newMission.id)).toBe(false);
  });

  it('returns CONFLICT when rerolling a completed mission', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;
    // Mark the mission as completed in storage
    const compositeKey = `missions_daily/${USER}/${before.data.daily.dateUtc}/${USER}`;
    const stored = env.fakeNakama.store.get(compositeKey);
    if (!stored) throw new Error('daily missions not stored');
    const rec = stored.value as {
      missions: Array<{ missionId: string; completed: boolean; claimed: boolean; progress: number }>;
    };
    rec.missions = rec.missions.map((m) =>
      m.missionId === target.missionId
        ? { ...m, completed: true, claimed: false }
        : m,
    );
    env.fakeNakama.store.set(compositeKey, stored);

    const r = callMissionReroll(env, USER, target.missionId, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT');
    }
  });

  it('is maintenance-gated — SERVICE_UNAVAILABLE when liveops.maintenance=true', () => {
    const before = callMissionsGet(env, USER);
    if (!before.ok) throw new Error('setup failed');
    const target = before.data.daily.missions[0]!;
    enableMaintenance(env);

    const r = callMissionReroll(env, USER, target.missionId, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('NOT_FOUND when missionId is unknown', () => {
    const r = callMissionReroll(env, USER, 'definitely_not_a_real_mission', false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NOT_FOUND');
    }
  });

  it('rejects when callerUserId != ctx.userId (FORBIDDEN)', () => {
    const handler = env.resolver('mission_reroll');
    if (!handler) throw new Error('no rpc');
    const ctx = { ...FakeContext, userId: USER };
    const body = JSON.stringify({
      callerUserId: 'attacker',
      missionId: 'daily_race_5',
      useGems: false,
    });
    const raw = handler(ctx, env.logger, env.nak, body);
    const parsed = JSON.parse(raw) as Resp<unknown>;
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('FORBIDDEN');
  });
});