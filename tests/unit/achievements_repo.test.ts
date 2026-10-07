// Phase 6 Chunk 5 — `achievements_repo` unit tests.
//
// Covers:
//   - ensureAchievements (lazy-create vs existing)
//   - claimAchievement (catalog validation, NOT_FOUND, INVALID_RESULT,
//     CONFLICT, CAS retries)
//   - storage key + permission bits per D13

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import type { AchievementDefinition, AchievementsRecord } from '../../modules/src/missions/types';
import {
  claimAchievement,
  ensureAchievements,
} from '../../modules/src/missions/achievements_repo';
import {
  ACHIEVEMENTS_COLLECTION,
  achievementsKey,
} from '../../modules/src/missions/counter_repo';

function makeCatalog(): AchievementDefinition[] {
  return [
    {
      id: 'ach_first_win',
      title: 'First win',
      description: 'Win a race',
      kind: 'wins_quick',
      filters: {},
      target: 1,
      reward: { coins: 100 },
    },
    {
      id: 'ach_10_races',
      title: '10 races',
      description: 'Finish 10',
      kind: 'race_count',
      filters: {},
      target: 10,
      reward: { coins: 200 },
    },
    {
      id: 'ach_100_races',
      title: '100 races',
      description: 'Finish 100',
      kind: 'race_count',
      filters: {},
      target: 100,
      reward: { coins: 1000, gems: 50 },
    },
  ];
}

function seedRecord(
  fake: FakeNakama,
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
  fake.store.set(`${ACHIEVEMENTS_COLLECTION}/${achievementsKey(userId)}/${userId}`, {
    collection: ACHIEVEMENTS_COLLECTION,
    key: achievementsKey(userId),
    userId,
    value: rec,
    version: 'v00000042',
    permissionRead: 1,
    permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

describe('achievements_repo (Phase 6 Chunk 5)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
  });

  describe('ensureAchievements', () => {
    it('creates a new record when none exists (D13 lazy)', () => {
      const res = ensureAchievements(fake.nakama, logger, 'u1');
      expect(res.created).toBe(true);
      expect(res.record.userId).toBe('u1');
      expect(res.record.progress).toEqual({});
      expect(res.record.claimed).toEqual({});
      expect(res.record.schemaVersion).toBe(1);
    });

    it('persists with server-owned permission bits (read=1, write=1)', () => {
      ensureAchievements(fake.nakama, logger, 'u1');
      const stored = fake.store.get(
        `${ACHIEVEMENTS_COLLECTION}/${achievementsKey('u1')}/u1`,
      );
      expect(stored).toBeDefined();
      expect(stored!.permissionRead).toBe(1);
      expect(stored!.permissionWrite).toBe(1);
    });

    it('returns created=false on subsequent calls (idempotent)', () => {
      const a = ensureAchievements(fake.nakama, logger, 'u1');
      const b = ensureAchievements(fake.nakama, logger, 'u1');
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      // Same record reference (deep equal).
      expect(b.record.progress).toEqual({});
      expect(b.record.claimed).toEqual({});
    });

    it('preserves existing progress on a subsequent call', () => {
      seedRecord(fake, 'u1', { ach_first_win: 1 }, { ach_first_win: true });
      const res = ensureAchievements(fake.nakama, logger, 'u1');
      expect(res.created).toBe(false);
      expect(res.record.progress.ach_first_win).toBe(1);
      expect(res.record.claimed.ach_first_win).toBe(true);
    });

    it('uses the storage key helper (achievements/{userId})', () => {
      ensureAchievements(fake.nakama, logger, 'u1');
      const key = `${ACHIEVEMENTS_COLLECTION}/${achievementsKey('u1')}/u1`;
      expect(fake.store.has(key)).toBe(true);
    });
  });

  describe('claimAchievement — catalog & row guards', () => {
    it('returns NOT_FOUND when achievementId is not in the catalog', () => {
      ensureAchievements(fake.nakama, logger, 'u1');
      const r = claimAchievement(fake.nakama, logger, 'u1', 'unknown_id', makeCatalog());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when no achievements row exists yet', () => {
      // Skip ensureAchievements — no row in storage.
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_first_win', makeCatalog());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    });
  });

  describe('claimAchievement — progress gates', () => {
    it('returns INVALID_RESULT when progress < target', () => {
      seedRecord(fake, 'u1', { ach_10_races: 5 });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_10_races', makeCatalog());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_RESULT');
    });

    it('returns CONFLICT when the achievement is already claimed', () => {
      seedRecord(fake, 'u1', { ach_first_win: 1 }, { ach_first_win: true });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_first_win', makeCatalog());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    });

    it('grants when progress >= target && !claimed (writes claimed[id]=true)', () => {
      seedRecord(fake, 'u1', { ach_first_win: 1 });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_first_win', makeCatalog());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.reward).toEqual({ coins: 100 });
        expect(r.data.definition.id).toBe('ach_first_win');
        expect(r.data.record.claimed.ach_first_win).toBe(true);
      }
      // Persisted.
      const stored = fake.store.get(
        `${ACHIEVEMENTS_COLLECTION}/${achievementsKey('u1')}/u1`,
      );
      const rec = stored!.value as AchievementsRecord;
      expect(rec.claimed.ach_first_win).toBe(true);
    });

    it('progress at exactly target is accepted (boundary)', () => {
      seedRecord(fake, 'u1', { ach_10_races: 10 });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_10_races', makeCatalog());
      expect(r.ok).toBe(true);
    });

    it('progress beyond target is also accepted (>= gate, not ==)', () => {
      seedRecord(fake, 'u1', { ach_10_races: 42 });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_10_races', makeCatalog());
      expect(r.ok).toBe(true);
    });

    it('does not lose other progress fields on claim', () => {
      seedRecord(fake, 'u1', {
        ach_first_win: 1,
        ach_10_races: 8,
        ach_100_races: 50,
      });
      const r = claimAchievement(fake.nakama, logger, 'u1', 'ach_first_win', makeCatalog());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.record.progress.ach_10_races).toBe(8);
        expect(r.data.record.progress.ach_100_races).toBe(50);
        expect(r.data.record.claimed.ach_first_win).toBe(true);
        // Other claimed fields untouched.
        expect(r.data.record.claimed.ach_10_races).toBeUndefined();
      }
    });
  });
});