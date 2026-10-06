// Phase 6 Chunk 3 — assignment algorithm tests.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';
import type { MissionDefinition } from '../../modules/src/missions/types';
import {
  ASSIGNMENT_SALT,
  DAILY_MISSION_COUNT,
  WEEKLY_MISSION_COUNT,
  assertCatalogHasEnoughEntries,
  buildMissionInstances,
  dailyAssignmentsFor,
  findLockedMissions,
  hexToIndex,
  rerollSingleMission,
  sha256Hex,
  shouldRerollFree,
  weeklyAssignmentsFor,
} from '../../modules/src/missions/assignment';

function makeDailyCatalog(n: number): MissionDefinition[] {
  const out: MissionDefinition[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `daily_m_${i}`,
      description: `daily mission ${i}`,
      title: `Daily ${i}`,
      kind: 'race_count',
      filters: {},
      target: 1,
      reward: { coins: 10 },
      unlockLevel: 1,
    });
  }
  return out;
}

function makeWeeklyCatalog(n: number): MissionDefinition[] {
  const out: MissionDefinition[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `weekly_m_${i}`,
      description: `weekly mission ${i}`,
      title: `Weekly ${i}`,
      kind: 'race_count',
      filters: {},
      target: 1,
      reward: { coins: 25 },
      unlockLevel: 1,
    });
  }
  return out;
}

function makeNk(): INakama {
  const fake = new FakeNakama();
  // Real sha256Hash via Node's crypto — goja doesn't expose crypto,
  // but vitest runs under Node so we use the real one.
  fake.nakama = {
    ...fake.nakama,
    sha256Hash: (s: string): string =>
      createHash('sha256').update(s).digest('hex'),
  };
  return fake.nakama;
}

describe('assignment (Phase 6 Chunk 3)', () => {
  describe('ASSIGNMENT_SALT', () => {
    it('is a compile-time constant string', () => {
      expect(ASSIGNMENT_SALT).toBe('cv-missions-assignment-v1');
    });
  });

  describe('dailyAssignmentsFor', () => {
    it('returns exactly 3 missions', () => {
      const nk = makeNk();
      const result = dailyAssignmentsFor('userA', '2026-10-07', makeDailyCatalog(20), nk);
      expect(result.length).toBe(3);
    });

    it('returns the same missions on a second call (deterministic)', () => {
      const nk = makeNk();
      const a = dailyAssignmentsFor('userA', '2026-10-07', makeDailyCatalog(20), nk);
      const b = dailyAssignmentsFor('userA', '2026-10-07', makeDailyCatalog(20), nk);
      expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    });

    it('returns different missions for a different userId', () => {
      const nk = makeNk();
      const a = dailyAssignmentsFor('userA', '2026-10-07', makeDailyCatalog(20), nk);
      const b = dailyAssignmentsFor('userB', '2026-10-07', makeDailyCatalog(20), nk);
      // With a 20-entry catalog it's overwhelmingly likely they differ.
      expect(a.map((m) => m.id)).not.toEqual(b.map((m) => m.id));
    });

    it('returns different missions for a different dateUtc', () => {
      const nk = makeNk();
      const a = dailyAssignmentsFor('userA', '2026-10-07', makeDailyCatalog(20), nk);
      const b = dailyAssignmentsFor('userA', '2026-10-08', makeDailyCatalog(20), nk);
      expect(a.map((m) => m.id)).not.toEqual(b.map((m) => m.id));
    });

    it('is deterministic across 1000 runs', () => {
      const nk = makeNk();
      const first = dailyAssignmentsFor('userZ', '2026-10-07', makeDailyCatalog(20), nk);
      for (let i = 0; i < 1000; i++) {
        const r = dailyAssignmentsFor('userZ', '2026-10-07', makeDailyCatalog(20), nk);
        expect(r.map((m) => m.id)).toEqual(first.map((m) => m.id));
      }
    });

    it('throws CATALOG_INVALID when catalog has < 3 entries', () => {
      const nk = makeNk();
      expect(() => dailyAssignmentsFor('u1', '2026-10-07', makeDailyCatalog(2), nk))
        .toThrow(/catalog invalid/);
    });
  });

  describe('weeklyAssignmentsFor', () => {
    it('returns exactly 3 missions', () => {
      const nk = makeNk();
      const result = weeklyAssignmentsFor('userA', '2026-W41', makeWeeklyCatalog(15), nk);
      expect(result.length).toBe(3);
    });

    it('throws CATALOG_INVALID when catalog has < 3 entries', () => {
      const nk = makeNk();
      expect(() => weeklyAssignmentsFor('u1', '2026-W41', makeWeeklyCatalog(1), nk))
        .toThrow(/catalog invalid/);
    });
  });

  describe('buildMissionInstances', () => {
    it('initializes progress=0, completed=false, claimed=false', () => {
      const defs = makeDailyCatalog(3);
      const instances = buildMissionInstances(defs, '2026-10-07');
      expect(instances.length).toBe(3);
      for (const inst of instances) {
        expect(inst.progress).toBe(0);
        expect(inst.completed).toBe(false);
        expect(inst.claimed).toBe(false);
        expect(typeof inst.instanceId).toBe('string');
        expect(inst.missionId).toBe(inst.instanceId.split('@')[0]!.replace(/^[^:]+:/, ''));
      }
    });
  });

  describe('shouldRerollFree', () => {
    it('returns true when rerollsLeftToday > 0', () => {
      expect(shouldRerollFree({
        schemaVersion: 1, userId: 'u', dateUtc: 'd', assignedAt: 0,
        rerollsLeftToday: 1, missions: [],
      })).toBe(true);
    });
    it('returns false when rerollsLeftToday = 0', () => {
      expect(shouldRerollFree({
        schemaVersion: 1, userId: 'u', dateUtc: 'd', assignedAt: 0,
        rerollsLeftToday: 0, missions: [],
      })).toBe(false);
    });
  });

  describe('assertCatalogHasEnoughEntries', () => {
    it('passes silently when catalog is large enough', () => {
      expect(() => assertCatalogHasEnoughEntries(makeDailyCatalog(3), 3, 'test')).not.toThrow();
    });
    it('throws when catalog is too small', () => {
      expect(() => assertCatalogHasEnoughEntries(makeDailyCatalog(2), 3, 'test'))
        .toThrow(/catalog invalid/);
    });
  });

  describe('findLockedMissions', () => {
    it('marks all unlockLevel=3 as locked when playerLevel=2', () => {
      const defs: MissionDefinition[] = [
        { id: 'a', description: 'd', title: 't', kind: 'race_count', filters: {}, target: 1, reward: {}, unlockLevel: 3 },
        { id: 'b', description: 'd', title: 't', kind: 'race_count', filters: {}, target: 1, reward: {}, unlockLevel: 3 },
      ];
      const locked = findLockedMissions(defs, 2);
      expect(locked.length).toBe(2);
    });

    it('returns empty array when playerLevel=5 (all unlocked)', () => {
      const defs: MissionDefinition[] = [
        { id: 'a', description: 'd', title: 't', kind: 'race_count', filters: {}, target: 1, reward: {}, unlockLevel: 3 },
        { id: 'b', description: 'd', title: 't', kind: 'race_count', filters: {}, target: 1, reward: {}, unlockLevel: 3 },
      ];
      expect(findLockedMissions(defs, 5)).toEqual([]);
    });
  });

  describe('sha256Hex', () => {
    it('returns 64 lowercase hex chars', () => {
      const nk = makeNk();
      const h = sha256Hex('hello', nk);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
    it('strips 0x prefix if present', () => {
      const nk = makeNk();
      nk.sha256Hash = (s: string): string =>
        '0x' + createHash('sha256').update(s).digest('hex');
      const h = sha256Hex('hello', nk);
      expect(h.startsWith('0x')).toBe(false);
    });
    it('throws when nk has no sha256Hash', () => {
      const fake = new FakeNakama();
      // Remove the sha256Hash stubbed method so the function can't find one.
      const stripped = new Proxy({} as Record<string, never>, {
        get(_t, _prop) {
          return () => { throw new Error('not stubbed'); };
        },
      });
      expect(() => sha256Hex('hi', stripped as unknown as INakama)).toThrow();
    });
  });

  describe('hexToIndex', () => {
    it('parses first 8 hex chars and mods by max', () => {
      expect(hexToIndex('ffffffff', 10)).toBe(5); // 4294967295 % 10 = 5
      expect(hexToIndex('00000000', 7)).toBe(0);
    });
    it('returns 0 when hex is malformed', () => {
      expect(hexToIndex('zz', 5)).toBe(0);
    });
  });

  describe('rerollSingleMission', () => {
    it('returns a mission not in excludeIds', () => {
      const nk = makeNk();
      const catalog = makeDailyCatalog(10);
      const exclude = new Set(['daily_m_0', 'daily_m_1']);
      const result = rerollSingleMission('u1', '2026-10-07', catalog, exclude, 0, nk);
      expect(result).not.toBeNull();
      expect(exclude.has(result!.id)).toBe(false);
    });
    it('returns null when every catalog entry is excluded', () => {
      const nk = makeNk();
      const catalog = makeDailyCatalog(3);
      const exclude = new Set(['daily_m_0', 'daily_m_1', 'daily_m_2']);
      expect(rerollSingleMission('u1', '2026-10-07', catalog, exclude, 0, nk)).toBeNull();
    });
  });

  describe('constants', () => {
    it('DAILY_MISSION_COUNT = 3 (D1)', () => {
      expect(DAILY_MISSION_COUNT).toBe(3);
    });
    it('WEEKLY_MISSION_COUNT = 3 (D2)', () => {
      expect(WEEKLY_MISSION_COUNT).toBe(3);
    });
  });
});