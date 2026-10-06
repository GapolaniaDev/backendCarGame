// Phase 6 Chunk 3 — missions_repo (storage CAS) tests.
//
// The repo owns the per-user daily/weekly mission records. Pure helpers
// (consumeReroll) are tested in isolation; storage-backed helpers are
// driven against the FakeNakama store.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import type { MissionDefinition } from '../../modules/src/missions/types';
import {
  PAID_REROLL_COST_GEMS,
  claimDailyMission,
  consumeReroll,
  ensureDailyMissions,
  ensureWeeklyMissions,
  rerollDailyMission,
} from '../../modules/src/missions/missions_repo';
import {
  MISSIONS_DAILY_COLLECTION,
  MISSIONS_WEEKLY_COLLECTION,
  dailyMissionsKey,
  weeklyMissionsKey,
} from '../../modules/src/missions/counter_repo';

function makeCatalog(n: number): MissionDefinition[] {
  const out: MissionDefinition[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m_${i}`,
      description: `m ${i}`,
      title: `M ${i}`,
      kind: 'race_count',
      filters: {},
      target: 1,
      reward: { coins: 10 },
      unlockLevel: 1,
    });
  }
  return out;
}

describe('missions_repo (Phase 6 Chunk 3)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
  });

  describe('consumeReroll (pure)', () => {
    it('returns costGems=0 + decrement when useGems=false && rerollsLeftToday>0', () => {
      const r = consumeReroll(
        {
          schemaVersion: 1, userId: 'u', dateUtc: 'd', assignedAt: 0,
          rerollsLeftToday: 1, missions: [],
        },
        false,
      );
      expect(r.costGems).toBe(0);
      expect(r.rerollsLeftToday).toBe(0);
    });
    it('returns costGems=PAID_REROLL_COST_GEMS when rerollsLeftToday=0 && useGems=false', () => {
      const r = consumeReroll(
        {
          schemaVersion: 1, userId: 'u', dateUtc: 'd', assignedAt: 0,
          rerollsLeftToday: 0, missions: [],
        },
        false,
      );
      expect(r.costGems).toBe(PAID_REROLL_COST_GEMS);
      expect(r.rerollsLeftToday).toBe(0);
    });
    it('returns costGems=PAID_REROLL_COST_GEMS when useGems=true even if free reroll available', () => {
      const r = consumeReroll(
        {
          schemaVersion: 1, userId: 'u', dateUtc: 'd', assignedAt: 0,
          rerollsLeftToday: 1, missions: [],
        },
        true,
      );
      expect(r.costGems).toBe(PAID_REROLL_COST_GEMS);
      expect(r.rerollsLeftToday).toBe(1);
    });
  });

  describe('PAID_REROLL_COST_GEMS', () => {
    it('is 50 (D4)', () => {
      expect(PAID_REROLL_COST_GEMS).toBe(50);
    });
  });

  describe('ensureDailyMissions', () => {
    it('creates a new record when none exists', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      expect(res.created).toBe(true);
      expect(res.record.missions.length).toBe(3);
      expect(res.record.rerollsLeftToday).toBe(1);
    });

    it('returns existing record on a second call same dateUtc', () => {
      const first = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const second = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      expect(second.created).toBe(false);
      expect(second.justReset).toBe(false);
      expect(second.record.dateUtc).toBe(first.record.dateUtc);
      expect(second.record.missions.map((m) => m.missionId))
        .toEqual(first.record.missions.map((m) => m.missionId));
    });

    it('creates a fresh record when dateUtc changes (per-day storage row, D12)', () => {
      const first = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const second = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-08', 1, makeCatalog(20));
      // The key includes dateUtc, so a new date → new storage row.
      // created=true because the prior record lives under a different key.
      expect(second.created).toBe(true);
      expect(second.record.dateUtc).toBe('2026-10-08');
      expect(second.record.rerollsLeftToday).toBe(1);
      expect(first.record.dateUtc).toBe('2026-10-07');
    });

    it('persists to the daily collection with the right key', () => {
      ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const stored = fake.store.get(
        `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey('u1', '2026-10-07')}/u1`,
      );
      expect(stored).toBeDefined();
      expect(stored!.value).toHaveProperty('dateUtc', '2026-10-07');
    });
  });

  describe('ensureWeeklyMissions', () => {
    it('creates a new weekly record', () => {
      const res = ensureWeeklyMissions(fake.nakama, logger, 'u1', '2026-W41', 1, makeCatalog(20));
      expect(res.created).toBe(true);
      expect(res.record.missions.length).toBe(3);
    });
    it('persists to the weekly collection', () => {
      ensureWeeklyMissions(fake.nakama, logger, 'u1', '2026-W41', 1, makeCatalog(20));
      const stored = fake.store.get(
        `${MISSIONS_WEEKLY_COLLECTION}/${weeklyMissionsKey('u1', '2026-W41')}/u1`,
      );
      expect(stored).toBeDefined();
    });
    it('creates a fresh record on a new week (per-week storage row)', () => {
      ensureWeeklyMissions(fake.nakama, logger, 'u1', '2026-W41', 1, makeCatalog(20));
      const next = ensureWeeklyMissions(fake.nakama, logger, 'u1', '2026-W42', 1, makeCatalog(20));
      expect(next.created).toBe(true);
      expect(next.record.weekUtc).toBe('2026-W42');
    });
  });

  describe('claimDailyMission', () => {
    beforeEach(() => {
      ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
    });

    it('returns NOT_FOUND when missionId is not in the catalog', () => {
      const r = claimDailyMission(fake.nakama, logger, 'u1', '2026-10-07', 'does_not_exist', makeCatalog(20));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_RESULT when the mission is not completed', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const r = claimDailyMission(fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, makeCatalog(20));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_RESULT');
    });

    it('grants the reward when completed && !claimed (returns reward object)', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const def = makeCatalog(20).find((d) => d.id === firstMission.missionId)!;

      // Flip completed=true via a CAS update — easiest path is to overwrite
      // the storage row.
      const key = `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey('u1', '2026-10-07')}/u1`;
      const existing = fake.store.get(key)!;
      fake.store.set(key, {
        ...existing,
        value: {
          ...(existing.value as Record<string, unknown>),
          missions: res.record.missions.map((m) =>
            m.missionId === firstMission.missionId
              ? { ...m, completed: true, claimed: false }
              : m,
          ),
        },
      });

      const claim = claimDailyMission(fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, makeCatalog(20));
      expect(claim.ok).toBe(true);
      if (claim.ok) {
        expect(claim.data.reward).toEqual(def.reward);
      }
    });

    it('returns CONFLICT when already claimed', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const key = `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey('u1', '2026-10-07')}/u1`;
      const existing = fake.store.get(key)!;
      fake.store.set(key, {
        ...existing,
        value: {
          ...(existing.value as Record<string, unknown>),
          missions: res.record.missions.map((m) =>
            m.missionId === firstMission.missionId
              ? { ...m, completed: true, claimed: true }
              : m,
          ),
        },
      });

      const r = claimDailyMission(fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, makeCatalog(20));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    });
  });

  describe('rerollDailyMission', () => {
    beforeEach(() => {
      ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
    });

    it('uses the free reroll when useGems=false (costGems=0)', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const r = rerollDailyMission(
        fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, false, makeCatalog(20),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.costGems).toBe(0);
        expect(r.data.record.rerollsLeftToday).toBe(0);
      }
    });

    it('charges PAID_REROLL_COST_GEMS when free reroll is used up', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const secondMission = res.record.missions[1]!;
      // Use up the free reroll on the first mission.
      rerollDailyMission(
        fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, false, makeCatalog(20),
      );
      // Now a second reroll (on a DIFFERENT mission — the original first one
      // has been swapped out of the record) without useGems must reject.
      const r2 = rerollDailyMission(
        fake.nakama, logger, 'u1', '2026-10-07', secondMission.missionId, false, makeCatalog(20),
      );
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('returns CONFLICT when the mission is completed', () => {
      const res = ensureDailyMissions(fake.nakama, logger, 'u1', '2026-10-07', 1, makeCatalog(20));
      const firstMission = res.record.missions[0]!;
      const key = `${MISSIONS_DAILY_COLLECTION}/${dailyMissionsKey('u1', '2026-10-07')}/u1`;
      const existing = fake.store.get(key)!;
      fake.store.set(key, {
        ...existing,
        value: {
          ...(existing.value as Record<string, unknown>),
          missions: res.record.missions.map((m) =>
            m.missionId === firstMission.missionId
              ? { ...m, completed: true, claimed: false }
              : m,
          ),
        },
      });

      const r = rerollDailyMission(
        fake.nakama, logger, 'u1', '2026-10-07', firstMission.missionId, false, makeCatalog(20),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    });

    it('returns NOT_FOUND for unknown missionId', () => {
      const r = rerollDailyMission(
        fake.nakama, logger, 'u1', '2026-10-07', 'does_not_exist', false, makeCatalog(20),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    });
  });
});