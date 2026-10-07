// Phase 8 Chunk 2 — Unit tests for abrupt-improvement detection.

import { describe, it, expect } from 'vitest';

import {
  detectAbruptImprovement,
  readAbruptHistory,
  appendAbruptHistory,
  ABRUPT_HISTORY_COLLECTION,
  ABRUPT_HISTORY_MAX_ENTRIES,
  type AbruptHistoryEntry,
} from '../../modules/src/anti_cheat/abrupt_improvement';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

function hist(raceId: string, bestTimeMs: number, ts: number): AbruptHistoryEntry {
  return { raceId, bestTimeMs, ts };
}

describe('abrupt_improvement (Phase 8 Chunk 2)', () => {
  describe('detectAbruptImprovement — pure', () => {
    it('returns ok=true for empty history', () => {
      const r = detectAbruptImprovement([], 50_000);
      expect(r.ok).toBe(true);
    });

    it('returns ok=true when history is below the 5-race threshold', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 99_000, 2),
        hist('r3', 98_000, 3),
      ];
      const r = detectAbruptImprovement(history, 50_000); // would be 50% better
      expect(r.ok).toBe(true); // but only 3 races, so ok
    });

    it('accepts a 10% better time when history has 5+ similar races', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 100_000, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
      ];
      // median = 100_000; new = 90_000 = 10% better
      const r = detectAbruptImprovement(history, 90_000);
      expect(r.ok).toBe(true);
    });

    it('flags a 35% better time', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 100_000, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
      ];
      // median = 100_000; new = 65_000 = 35% better
      const r = detectAbruptImprovement(history, 65_000);
      expect(r.ok).toBe(false);
      expect(r.improvementPct).toBe(35);
    });

    it('flags a 50% better time', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 100_000, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
      ];
      const r = detectAbruptImprovement(history, 50_000);
      expect(r.ok).toBe(false);
      expect(r.improvementPct).toBe(50);
    });

    it('accepts a 30% time exactly (boundary, not strictly > 30)', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 100_000, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
      ];
      // 30% better = 70_000ms; pct = floor((100_000 - 70_000) / 100_000 * 100) = 30
      const r = detectAbruptImprovement(history, 70_000);
      expect(r.ok).toBe(true);
      expect(r.improvementPct).toBeUndefined();
    });

    it('uses the median of 5 (odd-count): [100, 200, 300, 400, 500] → 300', () => {
      const history = [
        hist('r1', 100, 1),
        hist('r2', 200, 2),
        hist('r3', 300, 3),
        hist('r4', 400, 4),
        hist('r5', 500, 5),
      ];
      // median = 300; new = 195 = 35% better → flagged
      const r = detectAbruptImprovement(history, 195);
      expect(r.ok).toBe(false);
      expect(r.improvementPct).toBe(35);
      expect(r.medianMs).toBe(300);
    });

    it('takes the 5 most recent by ts (sorted by ts desc)', () => {
      // History has 7 entries; the 2 oldest have low times (would skew
      // the median lower if included). The detector should pick the 5
      // most recent (ts 1..5 in this case since the array is in ts order).
      const history = [
        hist('r1', 100, 1),
        hist('r2', 100, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
        hist('r6', 100_000, 6),
        hist('r7', 100_000, 7),
      ];
      // top 5 most recent = r3..r7, all 100_000; median = 100_000
      const r = detectAbruptImprovement(history, 50_000);
      expect(r.ok).toBe(false);
      expect(r.medianMs).toBe(100_000);
    });

    it('returns ok=true for non-positive newTimeMs (defensive)', () => {
      const history = [
        hist('r1', 100_000, 1),
        hist('r2', 100_000, 2),
        hist('r3', 100_000, 3),
        hist('r4', 100_000, 4),
        hist('r5', 100_000, 5),
      ];
      expect(detectAbruptImprovement(history, 0).ok).toBe(true);
      expect(detectAbruptImprovement(history, -1).ok).toBe(true);
    });
  });

  describe('readAbruptHistory + appendAbruptHistory — storage', () => {
    it('round-trips entries', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendAbruptHistory(nk, 'u1', hist('r1', 100_000, 1));
      appendAbruptHistory(nk, 'u1', hist('r2', 99_000, 2));
      const list = readAbruptHistory(nk, 'u1');
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual(hist('r1', 100_000, 1));
      expect(list[1]).toEqual(hist('r2', 99_000, 2));
    });

    it('returns [] for a missing user', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      expect(readAbruptHistory(nk, 'ghost')).toEqual([]);
    });

    it('trims to ABRUPT_HISTORY_MAX_ENTRIES (ring buffer)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      // Push MAX + 5 entries.
      const N = ABRUPT_HISTORY_MAX_ENTRIES + 5;
      for (let i = 0; i < N; i += 1) {
        appendAbruptHistory(nk, 'u1', hist(`r${i}`, 100_000 - i, i));
      }
      const list = readAbruptHistory(nk, 'u1');
      expect(list).toHaveLength(ABRUPT_HISTORY_MAX_ENTRIES);
      // The first 5 are dropped, the last kept.
      expect(list[0]?.raceId).toBe('r5');
      expect(list[list.length - 1]?.raceId).toBe(`r${N - 1}`);
    });

    it('writes are server-only (Read=1, Write=0)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      appendAbruptHistory(nk, 'u1', hist('r1', 100_000, 1));
      const stored = fake.store.get(`${ABRUPT_HISTORY_COLLECTION}/u1/u1`);
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
    });
  });
});