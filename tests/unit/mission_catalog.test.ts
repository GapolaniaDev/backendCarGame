// Phase 6 Chunk 1 — mission + achievement catalog loader tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  getMissionsDailyCatalog,
  getMissionsWeeklyCatalog,
  getAchievementsCatalog,
  _resetMissionsCatalogsForTests,
} from '../../modules/src/missions/catalog';
import type { ILogger } from '../../modules/src/nkruntime';
import missionsDailyRaw from '../../modules/src/catalogs/missions_daily.json';
import missionsWeeklyRaw from '../../modules/src/catalogs/missions_weekly.json';
import achievementsRaw from '../../modules/src/catalogs/achievements.json';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

describe('mission_catalog (Phase 6 Chunk 1)', () => {
  beforeEach(() => _resetMissionsCatalogsForTests());

  describe('bundled JSON loads', () => {
    it('daily missions catalog loads ≥20 missions with unique ids', () => {
      loadMissionsDailyCatalog(silentLogger, missionsDailyRaw as never);
      const cat = getMissionsDailyCatalog();
      expect(cat.length).toBeGreaterThanOrEqual(20);
      const ids = new Set<string>();
      for (const m of cat) {
        expect(ids.has(m.id)).toBe(false);
        ids.add(m.id);
        expect(m.title.length).toBeGreaterThan(0);
        expect(m.target).toBeGreaterThan(0);
        expect(m.unlockLevel).toBeGreaterThanOrEqual(1);
      }
    });

    it('weekly missions catalog loads ≥10 missions', () => {
      loadMissionsWeeklyCatalog(silentLogger, missionsWeeklyRaw as never);
      const cat = getMissionsWeeklyCatalog();
      expect(cat.length).toBeGreaterThanOrEqual(10);
    });

    it('achievements catalog loads ≥20 achievements', () => {
      loadAchievementsCatalog(silentLogger, achievementsRaw as never);
      const cat = getAchievementsCatalog();
      expect(cat.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('validators reject bad input', () => {
    it('rejects invalid kind', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'm1', title: 't', description: 'd', kind: 'NOT_A_KIND',
            filters: {}, target: 1, reward: { coins: 1 }, unlockLevel: 1 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/kind/);
    });

    it('rejects target ≤ 0', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'm1', title: 't', description: 'd', kind: 'race_count',
            filters: {}, target: 0, reward: { coins: 1 }, unlockLevel: 1 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/target/);
    });

    it('rejects unlockLevel < 1', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'm1', title: 't', description: 'd', kind: 'race_count',
            filters: {}, target: 1, reward: { coins: 1 }, unlockLevel: 0 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/unlockLevel/);
    });

    it('rejects duplicate ids', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'dup', title: 'a', description: 'a', kind: 'race_count',
            filters: {}, target: 1, reward: { coins: 1 }, unlockLevel: 1 },
          { id: 'dup', title: 'b', description: 'b', kind: 'race_count',
            filters: {}, target: 1, reward: { coins: 1 }, unlockLevel: 1 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/duplicate/);
    });

    it('rejects empty reward', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'm1', title: 't', description: 'd', kind: 'race_count',
            filters: {}, target: 1, reward: {}, unlockLevel: 1 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/reward/);
    });

    it('rejects bad filter mode', () => {
      const bad = {
        version: 1,
        missions: [
          { id: 'm1', title: 't', description: 'd', kind: 'race_count',
            filters: { mode: 'INVALID' }, target: 1, reward: { coins: 1 }, unlockLevel: 1 },
        ],
      };
      expect(() => loadMissionsDailyCatalog(silentLogger, bad)).toThrow(/mode/);
    });

    it('rejects wrong version', () => {
      expect(() => loadMissionsDailyCatalog(silentLogger, { version: 99, missions: [] }))
        .toThrow(/version/);
    });
  });
});