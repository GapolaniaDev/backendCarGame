// Unit tests for the Phase 3 progression helpers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLevelsCatalog,
  _resetLevelsForTests,
  getLevelsCatalog,
} from '../../modules/src/progression/catalog';
import {
  applyXpGain,
  buildLevelInfo,
  collectUnlocksUpTo,
  levelFromXp,
  xpFromCoins,
} from '../../modules/src/progression/leveling';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawLevelsFile } from '../../modules/src/progression/catalog';
import { MAX_LEVEL } from '../../modules/src/progression/types';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

/** Build a minimal valid 50-level table for tests. */
function makeTable(): RawLevelsFile {
  const table = [];
  let xp = 0;
  for (let lvl = 1; lvl <= 50; lvl += 1) {
    table.push({
      level: lvl,
      xpRequired: xp,
      rewards: { coins: lvl * 10 },
      unlocks: lvl === 1 ? ['class:D'] : lvl === 5 ? ['ranked_queue'] : [],
    });
    xp += 100 + lvl * 50;
  }
  return { version: 1, maxLevel: 50, xpCurve: 'table', table };
}

describe('progression/leveling — levelFromXp', () => {
  beforeEach(() => {
    _resetLevelsForTests();
    loadLevelsCatalog(SILENT_LOGGER, makeTable(), { localcachePut: () => {} } as unknown as INakama);
  });

  it('returns level 1 with full xpToNextLevel for xp=0', () => {
    const c = getLevelsCatalog();
    const r = levelFromXp(c, 0);
    expect(r.level).toBe(1);
    expect(r.xpOverflow).toBe(0);
    // xpRequired for level 2 is 100 + 1*50 = 150
    expect(r.xpToNextLevel).toBe(150);
  });

  it('returns level N for xp strictly between two thresholds', () => {
    const c = getLevelsCatalog();
    // xp = 100 — exactly at the threshold for level 2, still level 1
    const r1 = levelFromXp(c, 100);
    expect(r1.level).toBe(1);
    // xp = 151 — past level 2's threshold (150)
    const r2 = levelFromXp(c, 151);
    expect(r2.level).toBe(2);
    expect(r2.xpToNextLevel).toBeGreaterThan(0);
  });

  it('caps at MAX_LEVEL and reports overflow', () => {
    const c = getLevelsCatalog();
    const last = c.table[c.table.length - 1];
    expect(last?.level).toBe(MAX_LEVEL);
    const overflowXp = (last?.xpRequired ?? 0) + 10_000;
    const r = levelFromXp(c, overflowXp);
    expect(r.level).toBe(MAX_LEVEL);
    expect(r.xpToNextLevel).toBe(0);
    expect(r.xpOverflow).toBeGreaterThan(0);
  });

  it('handles negative or NaN inputs defensively', () => {
    const c = getLevelsCatalog();
    expect(levelFromXp(c, -1).level).toBe(1);
    expect(levelFromXp(c, Number.NaN).level).toBe(1);
  });
});

describe('progression/leveling — buildLevelInfo', () => {
  beforeEach(() => {
    _resetLevelsForTests();
    loadLevelsCatalog(SILENT_LOGGER, makeTable(), { localcachePut: () => {} } as unknown as INakama);
  });

  it('cumulatively collects unlocks across levels', () => {
    const c = getLevelsCatalog();
    const info = buildLevelInfo(c, /* big enough for level 5 */ 1_000_000);
    expect(info.unlockedLevels).toContain('class:D');
    expect(info.unlockedLevels).toContain('ranked_queue');
    expect(info.level).toBe(MAX_LEVEL);
    expect(info.xpToNextLevel).toBe(0);
  });

  it('returns an empty unlocks list for an unloaded state', () => {
    expect(collectUnlocksUpTo(getLevelsCatalog(), 0)).toEqual([]);
  });
});

describe('progression/leveling — applyXpGain', () => {
  beforeEach(() => {
    _resetLevelsForTests();
    loadLevelsCatalog(SILENT_LOGGER, makeTable(), { localcachePut: () => {} } as unknown as INakama);
  });

  it('adds XP without levelling up', () => {
    const c = getLevelsCatalog();
    const r = applyXpGain(c, 50, 20);
    expect(r.leveledUp).toBe(false);
    expect(r.newXp).toBe(70);
    expect(r.prevLevel).toBe(1);
    expect(r.newLevel).toBe(1);
    expect(r.xpOverflow).toBe(0);
    expect(r.levelUps).toHaveLength(0);
  });

  it('reports a single level-up crossing', () => {
    const c = getLevelsCatalog();
    // 0 → 200 should land on level 2 (threshold 150)
    const r = applyXpGain(c, 0, 200);
    expect(r.leveledUp).toBe(true);
    expect(r.newLevel).toBe(2);
    expect(r.levelUps).toHaveLength(1);
    expect(r.levelUps[0]?.level).toBe(2);
  });

  it('reports multi-level jumps and the level-up rewards', () => {
    const c = getLevelsCatalog();
    // 0 → 1000 should jump to whatever level 1000 sits in
    const r = applyXpGain(c, 0, 1000);
    expect(r.leveledUp).toBe(true);
    expect(r.newLevel).toBeGreaterThan(1);
    expect(r.levelUps.length).toBe(r.newLevel - 1);
    // First level-up rewards.coins should be 20 (level 2 → coins: 20)
    expect(r.levelUps[0]?.rewards.coins).toBe(20);
  });

  it('caps XP at MAX_LEVEL and discards overflow (Decision 3)', () => {
    const c = getLevelsCatalog();
    const last = c.table[c.table.length - 1];
    const atCap = last?.xpRequired ?? 0;
    const r = applyXpGain(c, atCap, 50_000);
    expect(r.newLevel).toBe(MAX_LEVEL);
    expect(r.xpOverflow).toBeGreaterThan(0);
    expect(r.newXp).toBe(last?.xpRequired ?? 0);
  });

  it('treats zero or negative gain as a no-op', () => {
    const c = getLevelsCatalog();
    expect(applyXpGain(c, 100, 0).newXp).toBe(100);
    expect(applyXpGain(c, 100, -50).newXp).toBe(100);
  });
});

describe('progression/leveling — xpFromCoins', () => {
  it('returns max(coins/divisor, floor)', () => {
    expect(xpFromCoins(100, 2, 20)).toBe(50);
    expect(xpFromCoins(20, 2, 20)).toBe(20);
    expect(xpFromCoins(10, 2, 20)).toBe(20);
  });

  it('returns 0 for non-positive coins', () => {
    expect(xpFromCoins(0, 2, 20)).toBe(0);
    expect(xpFromCoins(-5, 2, 20)).toBe(0);
  });

  it('handles weird divisor/floor inputs', () => {
    expect(xpFromCoins(100, 0, 20)).toBe(20); // divisor=0 → fall back to floor
    expect(xpFromCoins(100, 2, -5)).toBe(0); // negative floor → 0 (safer than negative xp)
    expect(xpFromCoins(100, -1, 20)).toBe(20); // negative divisor → floor
  });
});