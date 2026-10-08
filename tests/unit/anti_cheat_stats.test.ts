// Phase 8 Chunk 3 — Unit tests for daily anti-cheat stats.

import { describe, it, expect } from 'vitest';

import {
  emptyStats,
  readDailyStats,
  writeDailyStats,
  bumpStats,
  incrementStats,
  ANTI_CHEAT_STATS_COLLECTION,
  ANTI_CHEAT_STATS_SYSTEM_USER,
  type DailyAntiCheatStats,
} from '../../modules/src/anti_cheat/stats';
import type { AntiCheatMark } from '../../modules/src/anti_cheat/marks';
import { FakeNakama } from '../e2e/_stubs';
import type { INakama } from '../../modules/src/nkruntime';

const NOW = 1_700_000_000_000;

function mkMark(overrides?: Partial<AntiCheatMark>): AntiCheatMark {
  return {
    id: `mk-${Math.random().toString(36).slice(2, 10)}`,
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

describe('anti_cheat stats (Phase 8 Chunk 3)', () => {
  describe('emptyStats', () => {
    it('returns a row with zero counts and the given date', () => {
      const e = emptyStats('2026-10-08');
      expect(e.utcDate).toBe('2026-10-08');
      expect(e.marksTotal).toBe(0);
      expect(e.marksByKind).toEqual({
        partial_impossible: 0,
        abrupt_improvement: 0,
        quorum_disagreement: 0,
      });
      expect(e.marksBySeverity).toEqual({ low: 0, medium: 0, high: 0 });
      expect(e.usersHidden).toBe(0);
      expect(e.usersConfirmed).toBe(0);
    });
  });

  describe('bumpStats — pure', () => {
    it('increments total + byKind + bySeverity', () => {
      const base = emptyStats('2026-10-08');
      const next = bumpStats(base, mkMark({
        kind: 'partial_impossible', severity: 'low',
      }));
      expect(next.marksTotal).toBe(1);
      expect(next.marksByKind.partial_impossible).toBe(1);
      expect(next.marksByKind.abrupt_improvement).toBe(0);
      expect(next.marksBySeverity.low).toBe(1);
      expect(next.marksBySeverity.medium).toBe(0);
      expect(next.marksBySeverity.high).toBe(0);
    });

    it('stacks across multiple bumps', () => {
      let s = emptyStats('2026-10-08');
      s = bumpStats(s, mkMark({ kind: 'abrupt_improvement', severity: 'medium' }));
      s = bumpStats(s, mkMark({ kind: 'abrupt_improvement', severity: 'medium' }));
      s = bumpStats(s, mkMark({ kind: 'quorum_disagreement', severity: 'high' }));
      expect(s.marksTotal).toBe(3);
      expect(s.marksByKind.abrupt_improvement).toBe(2);
      expect(s.marksByKind.quorum_disagreement).toBe(1);
      expect(s.marksByKind.partial_impossible).toBe(0);
      expect(s.marksBySeverity.medium).toBe(2);
      expect(s.marksBySeverity.high).toBe(1);
    });

    it('counts confirmed marks toward usersConfirmed', () => {
      const s = bumpStats(
        emptyStats('2026-10-08'),
        mkMark({ kind: 'partial_impossible', severity: 'low', confirmed: true }),
      );
      expect(s.usersConfirmed).toBe(1);
    });

    it('leaves usersConfirmed alone for unconfirmed marks', () => {
      const s = bumpStats(
        emptyStats('2026-10-08'),
        mkMark({ kind: 'partial_impossible', severity: 'low', confirmed: false }),
      );
      expect(s.usersConfirmed).toBe(0);
    });
  });

  describe('readDailyStats + writeDailyStats — storage', () => {
    it('returns emptyStats when absent', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const r = readDailyStats(nk, '2026-10-08');
      expect(r.marksTotal).toBe(0);
      expect(r.utcDate).toBe('2026-10-08');
    });

    it('round-trips via writeDailyStats + readDailyStats', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      const row: DailyAntiCheatStats = {
        schemaVersion: 1,
        utcDate: '2026-10-08',
        marksTotal: 7,
        marksByKind: {
          partial_impossible: 3,
          abrupt_improvement: 2,
          quorum_disagreement: 2,
        },
        marksBySeverity: { low: 3, medium: 2, high: 2 },
        usersHidden: 1,
        usersConfirmed: 2,
      };
      writeDailyStats(nk, row);
      const read = readDailyStats(nk, '2026-10-08');
      expect(read).toEqual(row);
    });

    it('overwrites on a second writeDailyStats (CAS retry path)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      writeDailyStats(nk, { ...emptyStats('2026-10-08'), marksTotal: 1 });
      writeDailyStats(nk, { ...emptyStats('2026-10-08'), marksTotal: 2 });
      expect(readDailyStats(nk, '2026-10-08').marksTotal).toBe(2);
    });

    it('writes are server-only (Read=1, Write=0, owner=SYSTEM)', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      writeDailyStats(nk, emptyStats('2026-10-08'));
      const stored = fake.store.get(
        `${ANTI_CHEAT_STATS_COLLECTION}/2026-10-08/${ANTI_CHEAT_STATS_SYSTEM_USER}`,
      );
      expect(stored).toBeDefined();
      expect(stored?.permissionRead).toBe(1);
      expect(stored?.permissionWrite).toBe(0);
      expect(stored?.userId).toBe(ANTI_CHEAT_STATS_SYSTEM_USER);
    });
  });

  describe('incrementStats — read+modify+write CAS', () => {
    it('lazy-creates the row on the first mark', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      incrementStats(nk, '2026-10-08', mkMark({ kind: 'partial_impossible', severity: 'low' }));
      const r = readDailyStats(nk, '2026-10-08');
      expect(r.marksTotal).toBe(1);
      expect(r.marksByKind.partial_impossible).toBe(1);
    });

    it('increments an existing row across multiple marks', () => {
      const fake = new FakeNakama();
      const nk = fake.nakama as INakama;
      incrementStats(nk, '2026-10-08', mkMark({ kind: 'abrupt_improvement', severity: 'medium' }));
      incrementStats(nk, '2026-10-08', mkMark({ kind: 'quorum_disagreement', severity: 'high' }));
      const r = readDailyStats(nk, '2026-10-08');
      expect(r.marksTotal).toBe(2);
      expect(r.marksBySeverity.medium).toBe(1);
      expect(r.marksBySeverity.high).toBe(1);
    });
  });
});