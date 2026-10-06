// Phase 6 Chunk 1 — UTC date / week / reset helper tests.

import { describe, it, expect } from 'vitest';
import {
  utcDate,
  utcWeek,
  utcNextResetMs,
  utcNextWeekResetMs,
} from '../../modules/src/core/time';

describe('time (Phase 6 Chunk 1)', () => {
  describe('utcDate', () => {
    it('2026-01-15T00:00:00Z → 2026-01-15', () => {
      expect(utcDate(Date.UTC(2026, 0, 15))).toBe('2026-01-15');
    });
    it('mid-month UTC → padded', () => {
      expect(utcDate(Date.UTC(2026, 6, 5))).toBe('2026-07-05');
    });
    it('end of year UTC', () => {
      expect(utcDate(Date.UTC(2026, 11, 31))).toBe('2026-12-31');
    });
    it('epoch', () => {
      expect(utcDate(0)).toBe('1970-01-01');
    });
  });

  describe('utcWeek', () => {
    it('2026-01-05 (Monday) → 2026-W02', () => {
      expect(utcWeek(Date.UTC(2026, 0, 5))).toBe('2026-W02');
    });
    it('2026-01-01 (Thursday) belongs to ISO week 1', () => {
      // Per ISO 8601, the week containing the first Thursday of the
      // year is week 1. 2026-01-01 is a Thursday → week 1.
      expect(utcWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    });
    it('2026-01-04 (Sunday) → still week 1', () => {
      // Sunday is the last day of an ISO week. 2026-01-04 belongs to
      // the week starting 2025-12-29 — but ISO week 1 of 2026.
      // Actually: 2026-01-04 is the Sunday before the Thursday
      // 2026-01-01, so it belongs to W01.
      expect(utcWeek(Date.UTC(2026, 0, 4))).toBe('2026-W01');
    });
    it('2026-01-12 (Monday) → 2026-W03', () => {
      expect(utcWeek(Date.UTC(2026, 0, 12))).toBe('2026-W03');
    });
    it('2025-12-31 (Wednesday) → 2026-W01', () => {
      // 2025-12-31 is the Wednesday in the week of 2025-12-29..2026-01-04.
      // The Thursday is 2026-01-01 → ISO week 1 of 2026.
      expect(utcWeek(Date.UTC(2025, 11, 31))).toBe('2026-W01');
    });
  });

  describe('utcNextResetMs', () => {
    it('mid-day UTC → next midnight UTC', () => {
      const noon = Date.UTC(2026, 0, 15, 12, 0, 0);
      const expected = Date.UTC(2026, 0, 16, 0, 0, 0);
      expect(utcNextResetMs(noon)).toBe(expected);
    });
    it('exactly midnight UTC → next midnight UTC (24h later)', () => {
      const midnight = Date.UTC(2026, 0, 15, 0, 0, 0);
      const expected = Date.UTC(2026, 0, 16, 0, 0, 0);
      expect(utcNextResetMs(midnight)).toBe(expected);
    });
    it('end-of-year noon → next year midnight', () => {
      const eoy = Date.UTC(2026, 11, 31, 23, 59, 59);
      const expected = Date.UTC(2027, 0, 1, 0, 0, 0);
      expect(utcNextResetMs(eoy)).toBe(expected);
    });
  });

  describe('utcNextWeekResetMs', () => {
    it('Monday UTC → returns same instant (idempotent boundary)', () => {
      const mon = Date.UTC(2026, 0, 5, 0, 0, 0); // 2026-01-05 is Monday
      expect(utcNextWeekResetMs(mon)).toBe(mon);
    });
    it('Tuesday UTC → next Monday UTC', () => {
      const tue = Date.UTC(2026, 0, 6, 12, 0); // 2026-01-06 is Tuesday
      const expected = Date.UTC(2026, 0, 12, 0, 0, 0); // 2026-01-12 is Monday
      expect(utcNextWeekResetMs(tue)).toBe(expected);
    });
    it('Sunday UTC → next Monday UTC', () => {
      const sun = Date.UTC(2026, 0, 11, 23, 59); // 2026-01-11 is Sunday
      const expected = Date.UTC(2026, 0, 12, 0, 0, 0); // 2026-01-12 is Monday
      expect(utcNextWeekResetMs(sun)).toBe(expected);
    });
    it('Wednesday UTC → next Monday (5 days later)', () => {
      const wed = Date.UTC(2026, 0, 7, 0, 0); // 2026-01-07 is Wednesday
      const expected = Date.UTC(2026, 0, 12, 0, 0, 0);
      expect(utcNextWeekResetMs(wed)).toBe(expected);
    });
  });
});