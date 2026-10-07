// Phase 6 Chunk 7 — mission_claim routes catalog XP into the pass.
//
// End-to-end: pre-seed a daily-missions storage row with a completed
// mission (the subscriber is hard to drive here — we set up state
// directly), call mission_claim, and verify the PassRecord's xp
// increases by `reward.xp`.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import {
  MISSIONS_DAILY_COLLECTION,
  dailyMissionsKey,
  weeklyMissionsKey,
} from '../../modules/src/missions/counter_repo';
import { utcDate, utcWeek } from '../../modules/src/core/time';

const USER = 'mission-xp-grant-user';

interface ClaimResp {
  ok: boolean;
  data?: {
    missionId: string;
    reward: { coins?: number; xp?: number; gems?: number; cosmeticId?: string };
    kind: 'daily' | 'weekly';
    xpGranted?: number;
    passLevel?: number;
    levelUps?: number[];
  };
  error?: { code: string; message: string };
}

function callMissionClaim(
  env: LoadedBundle,
  missionId: string,
  kind: 'daily' | 'weekly',
): ClaimResp {
  const handler = env.resolver('mission_claim');
  if (!handler) throw new Error('no rpc: mission_claim');
  const ctx = { ...FakeContext, userId: USER };
  const body = JSON.stringify({ callerUserId: USER, missionId, kind });
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as ClaimResp;
}

function callMissionsGet(env: LoadedBundle): {
  daily: { missions: Array<{ missionId: string; reward: { coins?: number; xp?: number; gems?: number }; progress: number; completed: boolean }> };
  weekly: { missions: Array<{ missionId: string; reward: { coins?: number; xp?: number; gems?: number }; progress: number; completed: boolean }> };
} {
  const handler = env.resolver('missions_get');
  if (!handler) throw new Error('no rpc: missions_get');
  const ctx = { ...FakeContext, userId: USER };
  const body = JSON.stringify({ callerUserId: USER });
  const res = JSON.parse(handler(ctx, env.logger, env.nak, body)) as {
    ok: true; data: {
      daily: { missions: Array<{ missionId: string; reward: { coins?: number; xp?: number; gems?: number }; progress: number; completed: boolean }> };
      weekly: { missions: Array<{ missionId: string; reward: { coins?: number; xp?: number; gems?: number }; progress: number; completed: boolean }> };
    };
  };
  return res.data;
}

/**
 * Mark the given mission as completed on the user's daily-missions
 * storage row. The row must already exist (call missions_get first).
 */
function completeMissionInStorage(
  env: LoadedBundle,
  missionId: string,
  kind: 'daily' | 'weekly',
): void {
  const collection = kind === 'daily' ? MISSIONS_DAILY_COLLECTION : 'missions_weekly';
  const key = kind === 'daily'
    ? dailyMissionsKey(USER, utcDate(Date.now()))
    : weeklyMissionsKey(USER, utcWeek(Date.now()));
  const row = env.fakeNakama.store.get(`${collection}/${key}/${USER}`);
  if (!row) throw new Error(`no ${kind} missions row for ${USER}`);
  const rec = row.value as { missions: Array<{ missionId: string; completed: boolean; claimed: boolean; progress: number }> };
  rec.missions = rec.missions.map((m) =>
    m.missionId === missionId ? { ...m, completed: true, progress: 999_999 } : m,
  );
  env.fakeNakama.store.set(`${collection}/${key}/${USER}`, { ...row, value: rec });
}

function getPassXp(env: LoadedBundle): number {
  const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${passRecordKey(USER)}/${USER}`);
  if (!stored) return 0;
  return (stored.value as { xp: number }).xp;
}

describe('mission_claim → pass XP (Phase 6 Chunk 7)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('claim with reward.xp credits pass XP', () => {
    // Materialise assignments.
    const cards = callMissionsGet(env);
    // Pick first daily mission WITH reward.xp.
    const target = cards.daily.missions.find((m) => (m.reward.xp ?? 0) > 0);
    if (target === undefined) {
      // No XP-bearing daily mission assigned — skip.
      return;
    }
    completeMissionInStorage(env, target.missionId, 'daily');
    const xpExpected = target.reward.xp!;
    const before = getPassXp(env);
    const claim = callMissionClaim(env, target.missionId, 'daily');
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data!.xpGranted).toBe(xpExpected);
    expect(getPassXp(env)).toBe(before + xpExpected);
  });

  it('claim with no reward.xp grants zero pass XP', () => {
    const cards = callMissionsGet(env);
    const target = cards.daily.missions.find((m) => (m.reward.xp ?? 0) <= 0);
    if (target === undefined) {
      // All daily missions grant XP — skip.
      return;
    }
    completeMissionInStorage(env, target.missionId, 'daily');
    const before = getPassXp(env);
    const claim = callMissionClaim(env, target.missionId, 'daily');
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data!.xpGranted).toBe(0);
    expect(getPassXp(env)).toBe(before);
  });

  it('second claim of the same missionId fails CONFLICT (no double-grant)', () => {
    const cards = callMissionsGet(env);
    const target = cards.daily.missions.find((m) => (m.reward.xp ?? 0) > 0);
    if (target === undefined) return;
    completeMissionInStorage(env, target.missionId, 'daily');
    const xpExpected = target.reward.xp!;
    const first = callMissionClaim(env, target.missionId, 'daily');
    expect(first.ok).toBe(true);
    const afterFirst = getPassXp(env);
    expect(afterFirst).toBe(xpExpected);
    const second = callMissionClaim(env, target.missionId, 'daily');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
    // Pass XP unchanged.
    expect(getPassXp(env)).toBe(afterFirst);
  });
});