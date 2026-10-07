// Phase 7 Chunk 5 — Pure points + reward helper tests.
//
// Covers:
//   - pointsForRaceResult: win=3, podium=2 (rank 2..3), finish=1 (≥4),
//     abandoned=0, bots=0
//   - pointsForRace: confidence gate ('client' → aborted),
//     bot/abandon filtering, total aggregation
//   - pickTopContributors: sort by weeklyContribution desc, ties
//     broken by joinedAt asc, capped at N

import { describe, it, expect } from 'vitest';

import {
  POINTS_WIN,
  POINTS_PODIUM,
  POINTS_FINISH,
  WEEKLY_REWARD_MAX_RECIPIENTS,
  pickTopContributors,
  pointsForRace,
  pointsForRaceResult,
} from '../../modules/src/clubs/club_week';
import type { RaceCompletedEvent, RaceResult } from '../../modules/src/race/types';

const NOW = 1_700_000_000_000;

function makeResult(
  rank: number,
  opts: { isBot?: boolean; abandoned?: boolean; userId?: string } = {},
): RaceResult {
  return {
    rank,
    userId: opts.userId ?? `user-${rank}`,
    isBot: opts.isBot ?? false,
    totalMs: 60_000,
    abandoned: opts.abandoned ?? false,
  };
}

function makeEvent(
  results: RaceResult[],
  needsReview: boolean = false,
): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sess-1',
    mode: 'quick',
    trackId: 'neon_blvd',
    size: results.length as 2 | 4 | 6 | 1,
    results,
    flags: { needsReview, reviewReason: needsReview ? 'incomplete_reports' : undefined },
    closedAt: NOW,
  };
}

describe('pointsForRaceResult (Phase 7 Chunk 5)', () => {
  it('win = 3', () => {
    expect(pointsForRaceResult(makeResult(1))).toBe(POINTS_WIN);
    expect(POINTS_WIN).toBe(3);
  });

  it('podium = 2 (rank 2..3)', () => {
    expect(pointsForRaceResult(makeResult(2))).toBe(POINTS_PODIUM);
    expect(pointsForRaceResult(makeResult(3))).toBe(POINTS_PODIUM);
    expect(POINTS_PODIUM).toBe(2);
  });

  it('finish = 1 (rank ≥ 4)', () => {
    expect(pointsForRaceResult(makeResult(4))).toBe(POINTS_FINISH);
    expect(pointsForRaceResult(makeResult(6))).toBe(POINTS_FINISH);
    expect(POINTS_FINISH).toBe(1);
  });

  it('abandoned → 0 regardless of rank', () => {
    expect(pointsForRaceResult(makeResult(1, { abandoned: true }))).toBe(0);
    expect(pointsForRaceResult(makeResult(2, { abandoned: true }))).toBe(0);
    expect(pointsForRaceResult(makeResult(5, { abandoned: true }))).toBe(0);
  });

  it('bots → 0 regardless of rank', () => {
    expect(pointsForRaceResult(makeResult(1, { isBot: true }))).toBe(0);
    expect(pointsForRaceResult(makeResult(4, { isBot: true }))).toBe(0);
  });
});

describe('pointsForRace (Phase 7 Chunk 5)', () => {
  it('sums points across all humans', () => {
    const event = makeEvent([
      makeResult(1, { userId: 'A' }),
      makeResult(2, { userId: 'B' }),
      makeResult(3, { userId: 'C' }),
      makeResult(4, { userId: 'D' }),
    ]);
    const out = pointsForRace(event);
    expect(out.aborted).toBe(false);
    expect(out.total).toBe(3 + 2 + 2 + 1);
  });

  it('drops the whole event when needsReview=true (client confidence)', () => {
    const event = makeEvent([
      makeResult(1, { userId: 'A' }),
      makeResult(2, { userId: 'B' }),
    ], /* needsReview */ true);
    const out = pointsForRace(event);
    expect(out.aborted).toBe(true);
    expect(out.total).toBe(0);
    expect(out.reason).toBe('confidence_client');
  });

  it('bots and abandoned contribute 0 but do not abort the event', () => {
    const event = makeEvent([
      makeResult(1, { userId: 'A' }),
      makeResult(2, { isBot: true }),
      makeResult(3, { abandoned: true, userId: 'C' }),
    ]);
    const out = pointsForRace(event);
    expect(out.aborted).toBe(false);
    expect(out.total).toBe(3); // only A
  });

  it('solo race (size=1) — only winner', () => {
    const event = makeEvent([makeResult(1, { userId: 'A' })]);
    const out = pointsForRace(event);
    expect(out.aborted).toBe(false);
    expect(out.total).toBe(3);
  });

  it('all bots → total=0 (no humans)', () => {
    const event = makeEvent([
      makeResult(1, { isBot: true }),
      makeResult(2, { isBot: true }),
    ]);
    const out = pointsForRace(event);
    expect(out.aborted).toBe(false);
    expect(out.total).toBe(0);
  });
});

describe('pickTopContributors (Phase 7 Chunk 5)', () => {
  it('sorts by weeklyContribution desc', () => {
    const out = pickTopContributors([
      { userId: 'A', weeklyContribution: 10, joinedAt: 0 },
      { userId: 'B', weeklyContribution: 30, joinedAt: 0 },
      { userId: 'C', weeklyContribution: 20, joinedAt: 0 },
    ]);
    expect(out.map((u) => u.userId)).toEqual(['B', 'C', 'A']);
  });

  it('caps the result at the requested limit', () => {
    const out = pickTopContributors(
      [
        { userId: 'A', weeklyContribution: 30, joinedAt: 0 },
        { userId: 'B', weeklyContribution: 20, joinedAt: 0 },
        { userId: 'C', weeklyContribution: 10, joinedAt: 0 },
        { userId: 'D', weeklyContribution: 5, joinedAt: 0 },
      ],
      3,
    );
    expect(out.map((u) => u.userId)).toEqual(['A', 'B', 'C']);
  });

  it('default limit is 3', () => {
    expect(WEEKLY_REWARD_MAX_RECIPIENTS).toBe(3);
    const out = pickTopContributors([
      { userId: 'A', weeklyContribution: 30, joinedAt: 0 },
      { userId: 'B', weeklyContribution: 20, joinedAt: 0 },
      { userId: 'C', weeklyContribution: 10, joinedAt: 0 },
      { userId: 'D', weeklyContribution: 5, joinedAt: 0 },
      { userId: 'E', weeklyContribution: 1, joinedAt: 0 },
    ]);
    expect(out.map((u) => u.userId)).toEqual(['A', 'B', 'C']);
  });

  it('ties broken by joinedAt (earlier wins)', () => {
    const out = pickTopContributors([
      { userId: 'A', weeklyContribution: 10, joinedAt: 200 },
      { userId: 'B', weeklyContribution: 10, joinedAt: 100 },
    ]);
    expect(out.map((u) => u.userId)).toEqual(['B', 'A']);
  });

  it('empty input → empty output', () => {
    expect(pickTopContributors([])).toEqual([]);
  });

  it('fewer contributors than cap → returns all', () => {
    const out = pickTopContributors([
      { userId: 'A', weeklyContribution: 5, joinedAt: 0 },
      { userId: 'B', weeklyContribution: 10, joinedAt: 0 },
    ]);
    expect(out.map((u) => u.userId)).toEqual(['B', 'A']);
  });
});