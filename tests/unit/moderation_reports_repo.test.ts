// Phase 7 Chunk 7 — Unit tests for the reports-repo pure helpers.

import { describe, it, expect } from 'vitest';

import {
  computeNextReportsRate,
  gcReportsRecent,
  countDistinctReporters,
} from '../../modules/src/moderation/reports_repo';
import {
  AUTO_SILENCE_WINDOW_MS,
  REPORTS_RATE_WINDOW_MS,
} from '../../modules/src/moderation/types';
import type { ReportsRateRecord, ReportsRecentRecord } from '../../modules/src/moderation/types';

describe('moderation reports_repo (Phase 7 Chunk 7)', () => {
  describe('computeNextReportsRate', () => {
    it('starts a new window on the first report', () => {
      const next = computeNextReportsRate(null, 'u1', 1_000_000);
      expect(next).toEqual({
        schemaVersion: 1,
        reporterUserId: 'u1',
        windowStartTs: 1_000_000,
        count: 1,
      });
    });

    it('increments count inside the current window', () => {
      const prev: ReportsRateRecord = {
        schemaVersion: 1,
        reporterUserId: 'u1',
        windowStartTs: 1_000_000,
        count: 3,
      };
      // 1_000_000 + 30min < window length
      const next = computeNextReportsRate(prev, 'u1', 1_000_000 + 30 * 60 * 1000);
      expect(next.count).toBe(4);
      expect(next.windowStartTs).toBe(1_000_000);
    });

    it('resets count when the window has expired', () => {
      const prev: ReportsRateRecord = {
        schemaVersion: 1,
        reporterUserId: 'u1',
        windowStartTs: 1_000_000,
        count: 5,
      };
      // 1h + 1ms later — window expired
      const next = computeNextReportsRate(
        prev,
        'u1',
        1_000_000 + REPORTS_RATE_WINDOW_MS + 1,
      );
      expect(next.count).toBe(1);
      expect(next.windowStartTs).toBe(1_000_000 + REPORTS_RATE_WINDOW_MS + 1);
    });
  });

  describe('gcReportsRecent', () => {
    it('drops entries older than the window', () => {
      const now = 1_000_000_000;
      const prev: ReportsRecentRecord = {
        schemaVersion: 1,
        targetUserId: 'target',
        entries: {
          old: now - AUTO_SILENCE_WINDOW_MS - 1,    // expired
          fresh: now - 60 * 60 * 1000,                // 1h ago — inside
        },
      };
      const next = gcReportsRecent(prev, 'target', 'reporter-new', now, AUTO_SILENCE_WINDOW_MS);
      expect(next.entries['old']).toBeUndefined();
      expect(next.entries['fresh']).toBe(now - 60 * 60 * 1000);
      expect(next.entries['reporter-new']).toBe(now);
    });

    it('overwrites the timestamp when the same reporter files again', () => {
      const now = 2_000_000_000;
      const prev: ReportsRecentRecord = {
        schemaVersion: 1,
        targetUserId: 'target',
        entries: { 'same-reporter': now - 60 * 60 * 1000 },
      };
      const next = gcReportsRecent(prev, 'target', 'same-reporter', now, AUTO_SILENCE_WINDOW_MS);
      expect(next.entries['same-reporter']).toBe(now);
    });

    it('starts fresh when there is no previous record', () => {
      const next = gcReportsRecent(null, 'target', 'reporter-new', 5_000_000, AUTO_SILENCE_WINDOW_MS);
      expect(next.targetUserId).toBe('target');
      expect(next.entries).toEqual({ 'reporter-new': 5_000_000 });
    });

    it('preserves all entries inside the window', () => {
      const now = 10_000_000;
      const prev: ReportsRecentRecord = {
        schemaVersion: 1,
        targetUserId: 'target',
        entries: {
          a: now - 100,
          b: now - 200,
          c: now - 300,
        },
      };
      const next = gcReportsRecent(prev, 'target', 'd', now, AUTO_SILENCE_WINDOW_MS);
      expect(Object.keys(next.entries).sort()).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('countDistinctReporters', () => {
    it('counts unique reporter keys', () => {
      const rec: ReportsRecentRecord = {
        schemaVersion: 1,
        targetUserId: 't',
        entries: { a: 1, b: 2, c: 3 },
      };
      expect(countDistinctReporters(rec)).toBe(3);
    });
    it('returns 0 for an empty record', () => {
      const rec: ReportsRecentRecord = {
        schemaVersion: 1,
        targetUserId: 't',
        entries: {},
      };
      expect(countDistinctReporters(rec)).toBe(0);
    });
  });
});