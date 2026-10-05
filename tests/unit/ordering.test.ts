// Unit tests for `race/ordering.ts` — pure result aggregation.

import { describe, it, expect } from 'vitest';
import {
  aggregateForClose,
  computeQuorum,
  computeResults,
  countHumans,
  findAbandoned,
  orderByTotalTime,
} from '../../modules/src/race/ordering';
import type { RaceReport, RosterEntry } from '../../modules/src/race/types';

const HOST = '11111111-1111-4111-1111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';
const P3 = '44444444-4444-4444-8444-444444444444';
const BOT = '55555555-5555-4555-8555-555555555555';

function report(userId: string, totalMs: number, isBot = false): RaceReport {
  return { userId, totalMs, laps: [totalMs], isBotReport: isBot };
}

function entry(
  userId: string,
  opts: { isBot?: boolean; reportedAt?: number; totalMs?: number } = {},
): RosterEntry {
  return {
    userId,
    loadout: { classId: 'C', bodyId: 'coupe' },
    isBot: opts.isBot ?? false,
    ...(opts.reportedAt !== undefined ? { reportedAt: opts.reportedAt } : {}),
    ...(opts.totalMs !== undefined ? { totalMs: opts.totalMs } : {}),
    ...(opts.totalMs !== undefined ? { laps: [opts.totalMs] } : {}),
  };
}

describe('orderByTotalTime', () => {
  it('sorts ascending by totalMs', () => {
    expect(orderByTotalTime([report(P1, 300_000), report(P2, 100_000), report(P3, 200_000)]).map((r) => r.userId)).toEqual([P2, P3, P1]);
  });
  it('is stable on ties', () => {
    const out = orderByTotalTime([report(P1, 100_000), report(P2, 100_000), report(P3, 100_000)]);
    expect(out.map((r) => r.userId)).toEqual([P1, P2, P3]);
  });
  it('returns empty for empty input', () => {
    expect(orderByTotalTime([])).toEqual([]);
  });
});

describe('countHumans / findAbandoned', () => {
  it('counts only non-bot roster entries', () => {
    expect(
      countHumans([
        entry(HOST),
        entry(P1, { isBot: true }),
        entry(P2),
      ]),
    ).toBe(2);
  });
  it('finds entries without reportedAt', () => {
    const a = findAbandoned([
      entry(P1, { reportedAt: 100 }),
      entry(P2),
      entry(P3, { reportedAt: 200 }),
    ]);
    expect(a.map((e) => e.userId)).toEqual([P2]);
  });
});

describe('computeQuorum', () => {
  it('returns "server" when 0 humans reported', () => {
    const out = computeQuorum([report(BOT, 100_000, true)], 2);
    expect(out.confidence).toBe('server');
    expect(out.needsReview).toBe(false);
  });
  it('returns "quorum" when all humans reported', () => {
    const out = computeQuorum(
      [report(P1, 100_000), report(P2, 200_000)],
      2,
    );
    expect(out.confidence).toBe('quorum');
    expect(out.needsReview).toBe(false);
  });
  it('returns "client" + needsReview when some humans did not report', () => {
    const out = computeQuorum([report(P1, 100_000)], 2);
    expect(out.confidence).toBe('client');
    expect(out.needsReview).toBe(true);
    expect(out.reviewReason).toBe('incomplete_reports');
  });
  it('returns "quorum" when bots also reported', () => {
    const out = computeQuorum(
      [report(P1, 100_000), report(P2, 200_000), report(BOT, 150_000, true)],
      2,
    );
    expect(out.confidence).toBe('quorum');
  });
});

describe('computeResults', () => {
  it('ranks reported players by totalMs and appends abandoned at the end', () => {
    const roster: RosterEntry[] = [
      entry(P1, { reportedAt: 1, totalMs: 300_000 }),
      entry(P2, { reportedAt: 2, totalMs: 100_000 }),
      entry(P3), // abandoned
    ];
    const r = computeResults(roster);
    expect(r.map((x) => [x.rank, x.userId, x.abandoned])).toEqual([
      [1, P2, false],
      [2, P1, false],
      [3, P3, true],
    ]);
  });
  it('returns empty when roster is empty', () => {
    expect(computeResults([])).toEqual([]);
  });
});

describe('aggregateForClose', () => {
  it('produces quorum + sorted results when everyone reported', () => {
    const roster: RosterEntry[] = [
      entry(P1, { reportedAt: 1, totalMs: 100_000 }),
      entry(P2, { reportedAt: 2, totalMs: 200_000 }),
    ];
    const reports = [report(P1, 100_000), report(P2, 200_000)];
    const agg = aggregateForClose({ roster, reports });
    expect(agg.confidence).toBe('quorum');
    expect(agg.results.map((r) => r.userId)).toEqual([P1, P2]);
    expect(agg.needsReview).toBe(false);
  });
  it('marks the missing player abandoned + flags client', () => {
    const roster: RosterEntry[] = [
      entry(P1, { reportedAt: 1, totalMs: 100_000 }),
      entry(P2), // abandoned
    ];
    const reports = [report(P1, 100_000)];
    const agg = aggregateForClose({ roster, reports });
    expect(agg.confidence).toBe('client');
    expect(agg.needsReview).toBe(true);
    expect(agg.reviewReason).toBe('incomplete_reports');
    expect(agg.results[1]?.abandoned).toBe(true);
  });
});