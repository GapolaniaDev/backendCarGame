// Phase 6 Chunk 1 — battle pass catalog loader + helpers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadPassCatalog,
  getPassCatalog,
  findLevel,
  xpToLevel,
  xpToNextLevel,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import type { ILogger } from '../../modules/src/nkruntime';
import passS1Raw from '../../modules/src/catalogs/pass_s1.json';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

describe('pass_catalog (Phase 6 Chunk 1)', () => {
  beforeEach(() => _resetPassCatalogForTests());

  describe('bundled JSON loads', () => {
    it('pass_s1.json loads with 40 levels', () => {
      loadPassCatalog(silentLogger, passS1Raw as unknown as RawPassFile);
      const cat = getPassCatalog();
      expect(cat.levels.length).toBe(40);
      expect(cat.maxLevel).toBe(40);
      expect(cat.seasonId).toBe('s1');
      expect(cat.premiumPriceGems).toBe(800);
    });
  });

  describe('findLevel', () => {
    beforeEach(() => {
      loadPassCatalog(silentLogger, passS1Raw as unknown as RawPassFile);
    });

    it('returns level 1 for xpRequired 0', () => {
      const cat = getPassCatalog();
      const lvl = findLevel(cat, 1);
      expect(lvl).not.toBeNull();
      expect(lvl?.level).toBe(1);
      expect(lvl?.xpRequired).toBe(0);
    });

    it('returns level 40 for the maxLevel entry', () => {
      const cat = getPassCatalog();
      const lvl = findLevel(cat, 40);
      expect(lvl).not.toBeNull();
      expect(lvl?.level).toBe(40);
    });

    it('returns null for level 0', () => {
      expect(findLevel(getPassCatalog(), 0)).toBeNull();
    });

    it('returns null for level 999', () => {
      expect(findLevel(getPassCatalog(), 999)).toBeNull();
    });
  });

  describe('xpToLevel', () => {
    beforeEach(() => {
      loadPassCatalog(silentLogger, passS1Raw as unknown as RawPassFile);
    });

    it('xp=0 → level 1', () => {
      expect(xpToLevel(getPassCatalog(), 0)).toBe(1);
    });

    it('xp below first threshold → level 1', () => {
      // First non-1 threshold is level 2 (xpRequired=200). xp=199 → still 1.
      expect(xpToLevel(getPassCatalog(), 199)).toBe(1);
    });

    it('xp at first threshold → level 2', () => {
      expect(xpToLevel(getPassCatalog(), 200)).toBe(2);
    });

    it('xp just below last threshold → level 39', () => {
      const cat = getPassCatalog();
      const last = cat.levels[cat.levels.length - 1]!;
      expect(xpToLevel(cat, last.xpRequired - 1)).toBe(39);
    });

    it('xp at max threshold → maxLevel (40)', () => {
      const cat = getPassCatalog();
      const last = cat.levels[cat.levels.length - 1]!;
      expect(xpToLevel(cat, last.xpRequired)).toBe(40);
    });

    it('xp above max threshold → maxLevel (40)', () => {
      expect(xpToLevel(getPassCatalog(), 999_999)).toBe(40);
    });
  });

  describe('xpToNextLevel', () => {
    beforeEach(() => {
      loadPassCatalog(silentLogger, passS1Raw as unknown as RawPassFile);
    });

    it('xp=0 → next=2 remaining=200', () => {
      const r = xpToNextLevel(getPassCatalog(), 0);
      expect(r.currentLevel).toBe(1);
      expect(r.nextLevel).toBe(2);
      expect(r.xpRequired).toBe(200);
      expect(r.xpRemaining).toBe(200);
    });

    it('xp at max → nextLevel=null remaining=0', () => {
      const cat = getPassCatalog();
      const last = cat.levels[cat.levels.length - 1]!;
      const r = xpToNextLevel(cat, last.xpRequired + 10_000);
      expect(r.currentLevel).toBe(40);
      expect(r.nextLevel).toBeNull();
      expect(r.xpRemaining).toBe(0);
    });
  });

  describe('validators reject bad input', () => {
    it('rejects maxLevel ≠ levels.length', () => {
      const bad = { ...(passS1Raw as unknown as RawPassFile), maxLevel: 39 };
      expect(() => loadPassCatalog(silentLogger, bad)).toThrow(/levels\.length/);
    });

    it('rejects non-monotonic xpRequired', () => {
      const bad = JSON.parse(JSON.stringify(passS1Raw)) as RawPassFile;
      // Make level 5 lower than level 4.
      bad.levels[4]!.xpRequired = 100; // lower than level 4 (700)
      expect(() => loadPassCatalog(silentLogger, bad)).toThrow(/ascending/);
    });

    it('rejects premiumPriceGems ≤ 0', () => {
      const bad = { ...(passS1Raw as unknown as RawPassFile), premiumPriceGems: 0 };
      expect(() => loadPassCatalog(silentLogger, bad)).toThrow(/premiumPriceGems/);
    });

    it('rejects endUtc ≤ startUtc', () => {
      const raw = passS1Raw as unknown as RawPassFile;
      const bad = { ...raw, endUtc: raw.startUtc };
      expect(() => loadPassCatalog(silentLogger, bad)).toThrow(/endUtc/);
    });

    it('rejects wrong version', () => {
      const raw = passS1Raw as unknown as RawPassFile;
      expect(() => loadPassCatalog(silentLogger, { ...raw, version: 99 }))
        .toThrow(/version/);
    });
  });
});