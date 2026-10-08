// Phase 8 Chunk 3 — Unit tests for per-mark CRUD + aggregate helpers.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  readMarks,
  appendMark,
  confirmMark,
  dismissMark,
  setHiddenUntilUtc,
  clearHiddenUntilUtc,
  severityForMarkCount,
  isHidden,
  visibleMarkCount,
  setMarkThresholds,
  _resetMarksStateForTests,
  ANTI_CHEAT_MARKS_COLLECTION,
  ANTI_CHEAT_MARKS_SYSTEM_USER,
  type AntiCheatMark,
} from '../../modules/src/anti_cheat/marks';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const NOW = 1_700_000_000_000;

function mkMark(overrides?: Partial<AntiCheatMark>): AntiCheatMark {
  return {
    id: overrides?.id ?? `mk-${Math.random().toString(36).slice(2, 10)}`,
    userId: 'u1',
    raceId: 'race-1',
    kind: 'partial_impossible',
    severity: 'low',
    detectedAt: NOW,
    confirmed: false,
    dismissed: false,
    ...overrides,
  };
}

describe('marks (Phase 8 Chunk 3)', () => {
  beforeEach(() => {
    _resetMarksStateForTests();
  });

  describe('severityForMarkCount — pure', () => {
    it('maps counts to low/medium/high per catalog thresholds', () => {
      // Defaults are 1=low, 2=medium, 4=high.
      expect(severityForMarkCount(0)).toBe('low');
      expect(severityForMarkCount(1)).toBe('low');
      expect(severityForMarkCount(2)).toBe('medium');
      expect(severityForMarkCount(3)).toBe('medium');
      expect(severityForMarkCount(4)).toBe('high');
      expect(severityForMarkCount(10)).toBe('high');
    });

    it('honours non-default setMarkThresholds', () => {
      setMarkThresholds({ low: 2, medium: 5, high: 10 });
      expect(severityForMarkCount(1)).toBe('low');
      expect(severityForMarkCount(2)).toBe('low');
      expect(severityForMarkCount(5)).toBe('medium');
      expect(severityForMarkCount(10)).toBe('high');
    });

    it('rejects non-increasing thresholds (defensive)', () => {
      expect(() => setMarkThresholds({ low: 5, medium: 5, high: 10 })).toThrow();
      expect(() => setMarkThresholds({ low: 5, medium: 10, high: 10 })).toThrow();
    });

    it('defensive for non-integer counts (returns low)', () => {
      expect(severityForMarkCount(-1)).toBe('low');
      expect(severityForMarkCount(1.5)).toBe('low');
    });
  });

  describe('isHidden — pure', () => {
    it('returns false for an empty list', () => {
      expect(isHidden([], NOW)).toBe(false);
    });

    it('returns false for 4 medium marks (medium is NOT high)', () => {
      const marks = Array.from({ length: 4 }, () => mkMark({ severity: 'medium' }));
      expect(isHidden(marks, NOW)).toBe(false);
    });

    it('returns true for 1 high mark', () => {
      expect(isHidden([mkMark({ severity: 'high' })], NOW)).toBe(true);
    });

    it('returns false for 1 dismissed high mark', () => {
      expect(isHidden([mkMark({ severity: 'high', dismissed: true })], NOW)).toBe(false);
    });

    it('returns true when any mark has hiddenUntilUtc in the future', () => {
      const marks = [
        mkMark({ severity: 'low' }),
        mkMark({ id: 'm2', severity: 'low', hiddenUntilUtc: NOW + 1000 }),
      ];
      expect(isHidden(marks, NOW)).toBe(true);
    });

    it('returns false when hiddenUntilUtc has already expired', () => {
      const marks = [
        mkMark({ severity: 'low', hiddenUntilUtc: NOW - 1000 }),
      ];
      expect(isHidden(marks, NOW)).toBe(false);
    });
  });

  describe('visibleMarkCount — pure', () => {
    it('counts non-dismissed, non-hidden marks', () => {
      const marks = [
        mkMark({ id: 'a', severity: 'low' }),
        mkMark({ id: 'b', severity: 'medium', dismissed: true }),
        mkMark({ id: 'c', severity: 'low', hiddenUntilUtc: NOW + 5000 }),
        mkMark({ id: 'd', severity: 'medium' }),
      ];
      expect(visibleMarkCount(marks, NOW)).toBe(2); // a + d
    });

    it('returns 0 for an empty list', () => {
      expect(visibleMarkCount([], NOW)).toBe(0);
    });

    it('counts a high mark even though it implies hidden', () => {
      expect(visibleMarkCount([mkMark({ severity: 'high' })], NOW)).toBe(1);
    });
  });

  describe('readMarks + appendMark — storage', () => {
    it('returns [] when the row is absent', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(readMarks(nk, 'u1')).toEqual([]);
    });

    it('append + read returns the mark', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const m = mkMark({ id: 'm1' });
      appendMark(nk, 'u1', m);
      expect(readMarks(nk, 'u1')).toEqual([m]);
    });

    it('multiple appends preserve insertion order', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const m1 = mkMark({ id: 'm1', detectedAt: NOW - 100 });
      const m2 = mkMark({ id: 'm2', detectedAt: NOW });
      const m3 = mkMark({ id: 'm3', detectedAt: NOW + 100 });
      appendMark(nk, 'u1', m2);
      appendMark(nk, 'u1', m1);
      appendMark(nk, 'u1', m3);
      // Insertion order (not sorted by detectedAt — that's the caller's job).
      expect(readMarks(nk, 'u1').map((m) => m.id)).toEqual(['m2', 'm1', 'm3']);
    });

    it('writes are server-only (Read=1, Write=0, owner=SYSTEM)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendMark(nk, 'u1', mkMark({ id: 'm1' }));
      const stored = fake.store.get(
        `${ANTI_CHEAT_MARKS_COLLECTION}/u1/${ANTI_CHEAT_MARKS_SYSTEM_USER}`,
      );
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
      expect(stored?.userId).toBe(ANTI_CHEAT_MARKS_SYSTEM_USER);
    });
  });

  describe('confirmMark + dismissMark + setHiddenUntilUtc + clearHiddenUntilUtc', () => {
    it('confirmMark flips confirmed on a specific mark by id', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendMark(nk, 'u1', mkMark({ id: 'a', confirmed: false }));
      appendMark(nk, 'u1', mkMark({ id: 'b', confirmed: false }));
      confirmMark(nk, 'u1', 'a');
      const list = readMarks(nk, 'u1');
      expect(list.find((m) => m.id === 'a')?.confirmed).toBe(true);
      expect(list.find((m) => m.id === 'b')?.confirmed).toBe(false);
    });

    it('dismissMark flips dismissed on a specific mark by id', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendMark(nk, 'u1', mkMark({ id: 'a' }));
      appendMark(nk, 'u1', mkMark({ id: 'b' }));
      dismissMark(nk, 'u1', 'b');
      const list = readMarks(nk, 'u1');
      expect(list.find((m) => m.id === 'a')?.dismissed).toBe(false);
      expect(list.find((m) => m.id === 'b')?.dismissed).toBe(true);
    });

    it('setHiddenUntilUtc + clearHiddenUntilUtc round-trip', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendMark(nk, 'u1', mkMark({ id: 'a' }));
      setHiddenUntilUtc(nk, 'u1', 'a', NOW + 60_000);
      expect(readMarks(nk, 'u1').find((m) => m.id === 'a')?.hiddenUntilUtc).toBe(NOW + 60_000);
      clearHiddenUntilUtc(nk, 'u1', 'a');
      expect(readMarks(nk, 'u1').find((m) => m.id === 'a')?.hiddenUntilUtc).toBeUndefined();
    });

    it('throws when the row is missing', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(() => confirmMark(nk, 'ghost', 'missing')).toThrow(/row missing/);
    });

    it('throws when the mark id is absent', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendMark(nk, 'u1', mkMark({ id: 'a' }));
      expect(() => dismissMark(nk, 'u1', 'missing')).toThrow(/mark not found/);
    });
  });
});