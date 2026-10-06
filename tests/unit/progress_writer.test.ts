// Phase 6 Chunk 4 — pure progress writer tests.

import { describe, it, expect } from 'vitest';
import type {
  AchievementDefinition,
  MissionDefinition,
  MissionInstance,
  AchievementsRecord,
} from '../../modules/src/missions/types';
import {
  applyIncrementsToMissions,
  applyIncrementsToAchievements,
  markCompletedIfReached,
  newlyCompleted,
  newlyCompletedAchievements,
} from '../../modules/src/missions/progress_writer';

function makeDef(id: string, target = 3): MissionDefinition {
  return {
    id,
    title: id,
    description: id,
    kind: 'race_count',
    filters: {},
    target,
    reward: { coins: 10 },
    unlockLevel: 1,
  };
}

function makeInst(missionId: string, overrides: Partial<MissionInstance> = {}): MissionInstance {
  return {
    instanceId: `daily:${missionId}@2026-10-07`,
    missionId,
    progress: 0,
    completed: false,
    claimed: false,
    ...overrides,
  };
}

describe('progress_writer (Phase 6 Chunk 4)', () => {
  describe('applyIncrementsToMissions', () => {
    it('adds increment without mutating input', () => {
      const missions = [makeInst('m1')];
      const defs = [makeDef('m1')];
      const result = applyIncrementsToMissions(missions, defs, new Map([
        ['daily:m1@2026-10-07', 1],
      ]));
      expect(result[0]!.progress).toBe(1);
      expect(missions[0]!.progress).toBe(0); // input not mutated
    });

    it('caps progress at target (does not exceed)', () => {
      const missions = [makeInst('m1', { progress: 2 })];
      const defs = [makeDef('m1', 3)];
      const result = applyIncrementsToMissions(missions, defs, new Map([
        ['daily:m1@2026-10-07', 5],
      ]));
      expect(result[0]!.progress).toBe(3);
    });

    it('claimed mission → no further progress writes', () => {
      const missions = [makeInst('m1', { claimed: true, progress: 3 })];
      const defs = [makeDef('m1', 3)];
      const result = applyIncrementsToMissions(missions, defs, new Map([
        ['daily:m1@2026-10-07', 1],
      ]));
      expect(result[0]!.progress).toBe(3);
      expect(result[0]!.claimed).toBe(true);
    });

    it('multi-increment sums (e.g. two races land same missionId)', () => {
      const missions = [makeInst('m1', { progress: 0 })];
      const defs = [makeDef('m1', 5)];
      const inc = new Map<string, number>();
      inc.set('daily:m1@2026-10-07', 2);
      const result = applyIncrementsToMissions(missions, defs, inc);
      expect(result[0]!.progress).toBe(2);
    });

    it('returns new array (input not mutated)', () => {
      const missions = [makeInst('m1'), makeInst('m2')];
      const defs = [makeDef('m1'), makeDef('m2')];
      const inc = new Map<string, number>([
        ['daily:m1@2026-10-07', 1],
      ]);
      const result = applyIncrementsToMissions(missions, defs, inc);
      expect(result).not.toBe(missions);
      expect(result.length).toBe(2);
      expect(missions[0]!.progress).toBe(0);
    });

    it('empty increments → returns input.slice() (no mutation, no copies deep)', () => {
      const missions = [makeInst('m1')];
      const defs = [makeDef('m1')];
      const result = applyIncrementsToMissions(missions, defs, new Map());
      expect(result).toEqual(missions);
      expect(result).not.toBe(missions); // new array
    });

    it('does not flip completed (that is markCompletedIfReached\'s job)', () => {
      const missions = [makeInst('m1')];
      const defs = [makeDef('m1', 1)];
      const result = applyIncrementsToMissions(missions, defs, new Map([
        ['daily:m1@2026-10-07', 1],
      ]));
      expect(result[0]!.progress).toBe(1);
      expect(result[0]!.completed).toBe(false);
    });
  });

  describe('markCompletedIfReached', () => {
    it('flips completed false → true when progress >= target', () => {
      const missions = [makeInst('m1', { progress: 3 })];
      const defs = [makeDef('m1', 3)];
      const result = markCompletedIfReached(missions, defs);
      expect(result[0]!.completed).toBe(true);
    });

    it('does NOT flip when progress < target', () => {
      const missions = [makeInst('m1', { progress: 2 })];
      const defs = [makeDef('m1', 3)];
      const result = markCompletedIfReached(missions, defs);
      expect(result[0]!.completed).toBe(false);
    });

    it('does NOT mark claimed (only completed)', () => {
      const missions = [makeInst('m1', { progress: 3 })];
      const defs = [makeDef('m1', 3)];
      const result = markCompletedIfReached(missions, defs);
      expect(result[0]!.completed).toBe(true);
      expect(result[0]!.claimed).toBe(false);
    });

    it('idempotent — already-completed stays completed', () => {
      const missions = [makeInst('m1', { progress: 3, completed: true })];
      const defs = [makeDef('m1', 3)];
      const result = markCompletedIfReached(missions, defs);
      expect(result[0]!.completed).toBe(true);
    });

    it('mission without matching definition does not crash (defensive)', () => {
      const missions = [makeInst('orphan', { progress: 99 })];
      const defs = [makeDef('m1', 3)];
      const result = markCompletedIfReached(missions, defs);
      // No def → no target → stays incomplete (infinity target)
      expect(result[0]!.completed).toBe(false);
    });
  });

  describe('newlyCompleted', () => {
    it('returns missionIds that flipped false → true', () => {
      const before = [makeInst('m1'), makeInst('m2')];
      const after = [
        makeInst('m1', { completed: true, progress: 3 }),
        makeInst('m2', { progress: 2 }),
      ];
      expect(newlyCompleted(before, after)).toEqual(['m1']);
    });

    it('returns empty when nothing flipped', () => {
      const before = [makeInst('m1', { progress: 2 })];
      const after = [makeInst('m1', { progress: 2 })];
      expect(newlyCompleted(before, after)).toEqual([]);
    });

    it('ignores missions already completed', () => {
      const before = [makeInst('m1', { completed: true, progress: 3 })];
      const after = [makeInst('m1', { completed: true, progress: 3 })];
      expect(newlyCompleted(before, after)).toEqual([]);
    });
  });

  describe('applyIncrementsToAchievements', () => {
    it('sums increments into the progress map (returns new record)', () => {
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: { ach_10_races: 3 },
        claimed: {},
      };
      const defs: AchievementDefinition[] = [{
        id: 'ach_10_races', title: 't', description: 'd', kind: 'race_count',
        filters: {}, target: 10, reward: { coins: 100 },
      }];
      const result = applyIncrementsToAchievements(
        rec, defs, new Map([['ach_10_races', 2]]),
      );
      expect(result.progress.ach_10_races).toBe(5);
      expect(rec.progress.ach_10_races).toBe(3); // input not mutated
    });

    it('does NOT mark anything completed (achievements use claimed map)', () => {
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: { ach_10_races: 0 },
        claimed: {},
      };
      const defs: AchievementDefinition[] = [{
        id: 'ach_10_races', title: 't', description: 'd', kind: 'race_count',
        filters: {}, target: 1, reward: { coins: 100 },
      }];
      const result = applyIncrementsToAchievements(
        rec, defs, new Map([['ach_10_races', 5]]),
      );
      expect(result.progress.ach_10_races).toBe(5);
      // Achievements have no `completed` field; completion is derived via
      // newlyCompletedAchievements (separate helper).
      expect((result as { completed?: unknown }).completed).toBeUndefined();
    });

    it('preserves the claimed map verbatim', () => {
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: {},
        claimed: { ach_10_races: true },
      };
      const defs: AchievementDefinition[] = [{
        id: 'ach_10_races', title: 't', description: 'd', kind: 'race_count',
        filters: {}, target: 1, reward: { coins: 100 },
      }];
      const result = applyIncrementsToAchievements(
        rec, defs, new Map([['ach_10_races', 1]]),
      );
      expect(result.claimed).toEqual({ ach_10_races: true });
    });

    it('empty increments → returns input (no new object needed)', () => {
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: { ach_10_races: 5 },
        claimed: {},
      };
      const result = applyIncrementsToAchievements(rec, [], new Map());
      expect(result).toBe(rec); // identity on no-op
    });
  });

  describe('newlyCompletedAchievements', () => {
    it('returns ids whose progress >= target AND not yet claimed', () => {
      const defs: AchievementDefinition[] = [
        { id: 'a', title: 'a', description: 'a', kind: 'race_count', filters: {}, target: 3, reward: {} },
        { id: 'b', title: 'b', description: 'b', kind: 'race_count', filters: {}, target: 3, reward: {} },
      ];
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: { a: 5, b: 1 },
        claimed: {},
      };
      expect(newlyCompletedAchievements(rec, defs)).toEqual(['a']);
    });

    it('skips already-claimed achievements', () => {
      const defs: AchievementDefinition[] = [
        { id: 'a', title: 'a', description: 'a', kind: 'race_count', filters: {}, target: 3, reward: {} },
      ];
      const rec: AchievementsRecord = {
        schemaVersion: 1,
        userId: 'u1',
        progress: { a: 5 },
        claimed: { a: true },
      };
      expect(newlyCompletedAchievements(rec, defs)).toEqual([]);
    });
  });
});