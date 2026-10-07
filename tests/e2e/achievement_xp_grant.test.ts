// Phase 6 Chunk 7 — achievement_claim routes catalog XP into the pass.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import {
  ACHIEVEMENTS_COLLECTION,
  achievementsKey,
} from '../../modules/src/missions/counter_repo';

const USER = 'achievement-xp-grant-user';

interface ClaimResp {
  ok: boolean;
  data?: {
    achievementId: string;
    reward: { coins?: number; xp?: number; gems?: number; cosmeticId?: string };
    xpGranted?: number;
    passLevel?: number;
    levelUps?: number[];
  };
  error?: { code: string; message: string };
}

function callAchievementsGet(env: LoadedBundle): Array<{
  achievementId: string;
  target: number;
  reward: { coins?: number; xp?: number; gems?: number };
}> {
  const handler = env.resolver('achievements_get');
  if (!handler) throw new Error('no rpc: achievements_get');
  const ctx = { ...FakeContext, userId: USER };
  const body = JSON.stringify({ callerUserId: USER });
  const res = JSON.parse(handler(ctx, env.logger, env.nak, body)) as {
    ok: true; data: { achievements: Array<{ achievementId: string; target: number; reward: { coins?: number; xp?: number; gems?: number } }> };
  };
  return res.data.achievements;
}

function callAchievementClaim(env: LoadedBundle, achievementId: string): ClaimResp {
  const handler = env.resolver('achievement_claim');
  if (!handler) throw new Error('no rpc: achievement_claim');
  const ctx = { ...FakeContext, userId: USER };
  const body = JSON.stringify({ callerUserId: USER, achievementId });
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as ClaimResp;
}

/**
 * Mark the given achievement as completed on the user's achievements
 * storage row. Sets progress = target + 1 to satisfy the >= check.
 */
function completeAchievementInStorage(env: LoadedBundle, achievementId: string, target: number): void {
  const key = achievementsKey(USER);
  const row = env.fakeNakama.store.get(`${ACHIEVEMENTS_COLLECTION}/${key}/${USER}`);
  if (!row) throw new Error(`no achievements row for ${USER}`);
  const rec = row.value as {
    progress: Record<string, number>;
    claimed: Record<string, boolean>;
  };
  rec.progress[achievementId] = target + 1;
  rec.claimed[achievementId] = false;
  env.fakeNakama.store.set(`${ACHIEVEMENTS_COLLECTION}/${key}/${USER}`, { ...row, value: rec });
}

function getPassXp(env: LoadedBundle): number {
  const stored = env.fakeNakama.store.get(`${PASS_COLLECTION}/${passRecordKey(USER)}/${USER}`);
  if (!stored) return 0;
  return (stored.value as { xp: number }).xp;
}

describe('achievement_claim → pass XP (Phase 6 Chunk 7)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('claim with reward.xp credits pass XP', () => {
    const cards = callAchievementsGet(env);
    const target = cards.find((c) => (c.reward.xp ?? 0) > 0);
    if (target === undefined) return;
    completeAchievementInStorage(env, target.achievementId, target.target);
    const xpExpected = target.reward.xp!;
    const before = getPassXp(env);
    const claim = callAchievementClaim(env, target.achievementId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data!.xpGranted).toBe(xpExpected);
    expect(getPassXp(env)).toBe(before + xpExpected);
  });

  it('claim with no reward.xp grants zero pass XP', () => {
    const cards = callAchievementsGet(env);
    const target = cards.find((c) => (c.reward.xp ?? 0) <= 0);
    if (target === undefined) return;
    completeAchievementInStorage(env, target.achievementId, target.target);
    const before = getPassXp(env);
    const claim = callAchievementClaim(env, target.achievementId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data!.xpGranted).toBe(0);
    expect(getPassXp(env)).toBe(before);
  });

  it('second claim of the same achievementId fails CONFLICT (no double-grant)', () => {
    const cards = callAchievementsGet(env);
    const target = cards.find((c) => (c.reward.xp ?? 0) > 0);
    if (target === undefined) return;
    completeAchievementInStorage(env, target.achievementId, target.target);
    const xpExpected = target.reward.xp!;
    const first = callAchievementClaim(env, target.achievementId);
    expect(first.ok).toBe(true);
    const afterFirst = getPassXp(env);
    expect(afterFirst).toBe(xpExpected);
    const second = callAchievementClaim(env, target.achievementId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
    expect(getPassXp(env)).toBe(afterFirst);
  });

  it('multiple XP-grants from different achievements stack', () => {
    const cards = callAchievementsGet(env);
    const targets = cards.filter((c) => (c.reward.xp ?? 0) > 0).slice(0, 3);
    if (targets.length < 2) return; // catalog variation
    const before = getPassXp(env);
    let totalXp = 0;
    for (const t of targets) {
      completeAchievementInStorage(env, t.achievementId, t.target);
      const claim = callAchievementClaim(env, t.achievementId);
      expect(claim.ok).toBe(true);
      totalXp += t.reward.xp ?? 0;
    }
    expect(getPassXp(env)).toBe(before + totalXp);
  });
});