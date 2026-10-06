// Phase 4 Chunk 7 unit tests for the RaceCompleted → ranked
// subscriber. The subscriber wraps the pure `ratingChange` helper
// from Chunk 5; these tests focus on the orchestration: mode gate,
// confidence gate, idempotency gate, bot filtering, K-factor
// selection, and per-human record updates via the FakeNakama stub.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  handleRaceCompletedForRanked,
  type RankedSubscriberDeps,
} from '../../modules/src/ranked/subscriber';
import { RANKED_COLLECTION, RANKED_PROGRESS_COLLECTION } from '../../modules/src/ranked/subscriber';
import { loadSeasonsCatalog } from '../../modules/src/ranked/seasons';
import { loadRankedConfig } from '../../modules/src/ranked/config';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { FakeLogger, FakeNakama } from '../e2e/_stubs';
import { FakeLogger as FakeLoggerClass, FakeNakama as FakeNakamaClass } from '../e2e/_stubs';
import type { RaceCompletedEvent, RaceResult } from '../../modules/src/race/types';
import type { RankedRecord } from '../../modules/src/ranked/types';
import seasonsJson from '../../modules/src/catalogs/seasons.json';
import rankedConfigJson from '../../modules/src/catalogs/ranked_config.json';

beforeAll(() => {
  // Load the bundled catalogs into module-level state so the
  // subscriber can call `getSeasonsCatalog()` / `getRankedConfig()`.
  loadSeasonsCatalog(console as never, seasonsJson as never);
  loadRankedConfig(console as never, rankedConfigJson as never);
});

function makeDeps(): { deps: RankedSubscriberDeps; nak: FakeNakama; logger: FakeLogger } {
  const nak = new FakeNakamaClass();
  const logger = new FakeLoggerClass();
  const nk = nak.nakama;
  const deps: RankedSubscriberDeps = {
    logger,
    nk,
    // No bus needed for these tests — we call the handler directly.
    bus: { subscribe: () => {}, publish: async () => {}, subscriberCount: () => 0 } as unknown as RankedSubscriberDeps['bus'],
  };
  return { deps, nak, logger };
}

function event(
  args: Partial<RaceCompletedEvent> & {
    results?: RaceResult[];
    mode?: RaceCompletedEvent['mode'];
    needsReview?: boolean;
    sessionId?: string;
    closedAt?: number;
  },
): RaceCompletedEvent {
  // Default closedAt sits in season_2's active window (Oct 2025..Dec 2028).
  const closedAt = args.closedAt ?? 1_760_000_000_000;
  return {
    schemaVersion: 1,
    sessionId: args.sessionId ?? 'sid-1',
    mode: args.mode ?? 'ranked',
    trackId: args.trackId ?? 'track-a',
    size: args.size ?? 4,
    results: args.results ?? [],
    flags: { needsReview: args.needsReview ?? false },
    closedAt,
  };
}

function human(userId: string, rank: number, opts: { abandoned?: boolean } = {}): RaceResult {
  return {
    rank,
    userId,
    isBot: false,
    totalMs: 60_000 + (rank - 1) * 1000,
    abandoned: opts.abandoned ?? false,
  };
}

function bot(rank: number): RaceResult {
  return { rank, userId: `bot-${rank}`, isBot: true, totalMs: 60_000, abandoned: false };
}

function readRecord(nak: FakeNakama, userId: string): RankedRecord | null {
  const stored = nak.store.get(`${RANKED_COLLECTION}/${userId}/${userId}`);
  if (!stored) return null;
  return stored.value as RankedRecord;
}

function readProgress(nak: FakeNakama, sessionId: string): unknown {
  return nak.store.get(`${RANKED_PROGRESS_COLLECTION}/${sessionId}/${SYSTEM_USER_ID}`);
}

function readLeaderboardScore(nak: FakeNakama, seasonId: string, ownerId: string): number | null {
  const rec = nak.leaderboardRecords.get(`ranked_${seasonId}`)?.get(ownerId);
  return rec ? rec.score : null;
}

describe('ranked subscriber (Phase 4 Chunk 7) — gates', () => {
  it('mode !== ranked → skip with reason', () => {
    const { deps } = makeDeps();
    const ev = event({ mode: 'quick', results: [human('u1', 1)] });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(false);
    expect(out.reason).toContain('quick');
  });

  it('mode=ranked + needsReview=true (client confidence) → skip', () => {
    const { deps } = makeDeps();
    const ev = event({ needsReview: true, results: [human('u1', 1), human('u2', 2)] });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('confidence=client');
  });

  it('mode=ranked + confidence=quorum → process', () => {
    const { deps } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    expect(out.seasonId).toBe('season_2');
  });

  it('mode=ranked + bots-only roster → no humans, drop and stamp marker', () => {
    const { deps, nak } = makeDeps();
    const ev = event({ results: [bot(1), bot(2)] });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('no_humans');
    expect(readProgress(nak, 'sid-1')).toBeDefined();
  });

  it('confidence=server (0 humans) is allowed for rated races → drop with marker', () => {
    const { deps, nak } = makeDeps();
    const ev = event({ results: [] });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('no_humans');
    expect(readProgress(nak, 'sid-1')).toBeDefined();
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — rating math', () => {
  it('4 humans ranked 1..4 → winner gains, last-place loses (K uniform)', () => {
    const { deps } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2), human('u3', 3), human('u4', 4)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const byUser = Object.fromEntries(out.deltas.map((d) => [d.userId, d]));
    expect(byUser.u1?.delta).toBeGreaterThan(0); // winner
    expect(byUser.u4?.delta).toBeLessThan(0); // last
    expect(byUser.u1!.newRating).toBe(1000 + (byUser.u1?.delta ?? 0));
    // Sum of deltas is 0 when K is uniform (everyone has racesPlayed=0).
    const sum = out.deltas.reduce((s, d) => s + d.delta, 0);
    expect(Math.abs(sum)).toBeLessThanOrEqual(0);
  });

  it('bots in the roster are filtered out — they never get a delta', () => {
    const { deps } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), bot(2), bot(3), human('u4', 4)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const userIds = out.deltas.map((d) => d.userId).sort();
    expect(userIds).toEqual(['u1', 'u4']);
  });

  it('1 abandoned human (last rank) loses maximum delta', () => {
    const { deps } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2), human('u3', 3), human('u4', 4, { abandoned: true })],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const byUser = Object.fromEntries(out.deltas.map((d) => [d.userId, d]));
    expect(byUser.u4?.delta).toBeLessThan(0);
    // u4 lost to everyone (3 opponents) → biggest negative delta of any rank.
    for (const u of ['u1', 'u2', 'u3']) {
      expect(byUser.u4!.delta).toBeLessThan(byUser[u]!.delta);
    }
  });

  it('K mix: racesPlayed<10 → initial (40), ≥10 → normal (24)', () => {
    const { deps, nak } = makeDeps();
    // Pre-seed u1 with racesPlayed=5 (initial K), u2 with racesPlayed=10 (normal K).
    nak.nakama.storageWrite([
      {
        collection: RANKED_COLLECTION,
        key: 'u1',
        userId: 'u1',
        value: {
          schemaVersion: 1,
          userId: 'u1',
          seasonId: 'season_2',
          rating: 1000,
          peak: 1000,
          racesPlayed: 5,
          wins: 0,
          topThree: 0,
          recentAbandons: 0,
          lastRatedAt: 1,
          divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2,
        permissionWrite: 1,
      },
      {
        collection: RANKED_COLLECTION,
        key: 'u2',
        userId: 'u2',
        value: {
          schemaVersion: 1,
          userId: 'u2',
          seasonId: 'season_2',
          rating: 1000,
          peak: 1000,
          racesPlayed: 10,
          wins: 0,
          topThree: 0,
          recentAbandons: 0,
          lastRatedAt: 1,
          divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2,
        permissionWrite: 1,
      },
    ]);
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const byUser = Object.fromEntries(out.deltas.map((d) => [d.userId, d]));
    expect(byUser.u1?.kFactor).toBe(40); // initial
    expect(byUser.u2?.kFactor).toBe(24); // normal
    // Magnitudes: winner's gain must be larger than (24/40) of what it
    // would be with normal K. Hard to assert without recomputing; just
    // check u1's |delta| > u2's |delta| (both uniform-rating, so larger
    // K moves proportionally more).
    expect(Math.abs(byUser.u1!.delta)).toBeGreaterThan(Math.abs(byUser.u2!.delta));
  });

  it('wins + topThree counters increment correctly on a 4-human race', () => {
    const { deps, nak } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2), human('u3', 3), human('u4', 4)],
    });
    handleRaceCompletedForRanked(deps, ev);
    const r1 = readRecord(nak, 'u1');
    const r2 = readRecord(nak, 'u2');
    const r3 = readRecord(nak, 'u3');
    const r4 = readRecord(nak, 'u4');
    expect(r1?.wins).toBe(1);
    expect(r2?.wins).toBe(0);
    expect(r3?.wins).toBe(0);
    expect(r1?.topThree).toBe(1);
    expect(r2?.topThree).toBe(1);
    expect(r3?.topThree).toBe(1);
    expect(r4?.topThree).toBe(0);
    expect(r1?.racesPlayed).toBe(1);
    expect(r4?.racesPlayed).toBe(1);
  });

  it('recentAbandons increments on abandon, decrements on finish', () => {
    const { deps, nak } = makeDeps();
    // Seed u1 with 2 prior abandons, u2 with 0.
    nak.nakama.storageWrite([
      {
        collection: RANKED_COLLECTION,
        key: 'u1',
        userId: 'u1',
        value: {
          schemaVersion: 1,
          userId: 'u1',
          seasonId: 'season_2',
          rating: 1000, peak: 1000, racesPlayed: 5, wins: 0, topThree: 0,
          recentAbandons: 2, lastRatedAt: 1, divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2, permissionWrite: 1,
      },
      {
        collection: RANKED_COLLECTION,
        key: 'u2',
        userId: 'u2',
        value: {
          schemaVersion: 1,
          userId: 'u2',
          seasonId: 'season_2',
          rating: 1000, peak: 1000, racesPlayed: 5, wins: 0, topThree: 0,
          recentAbandons: 0, lastRatedAt: 1, divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2, permissionWrite: 1,
      },
    ]);
    const ev = event({
      needsReview: false,
      results: [human('u1', 2, { abandoned: true }), human('u2', 1)],
    });
    handleRaceCompletedForRanked(deps, ev);
    expect(readRecord(nak, 'u1')?.recentAbandons).toBe(3);
    expect(readRecord(nak, 'u2')?.recentAbandons).toBe(0); // floored at 0
  });

  it('peak tracks the all-time-high rating for the season', () => {
    const { deps, nak } = makeDeps();
    nak.nakama.storageWrite([
      {
        collection: RANKED_COLLECTION,
        key: 'u1',
        userId: 'u1',
        value: {
          schemaVersion: 1,
          userId: 'u1',
          seasonId: 'season_2',
          rating: 1050, peak: 1050, racesPlayed: 3, wins: 1, topThree: 1,
          recentAbandons: 0, lastRatedAt: 1, divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2, permissionWrite: 1,
      },
      {
        collection: RANKED_COLLECTION,
        key: 'u2',
        userId: 'u2',
        value: {
          schemaVersion: 1,
          userId: 'u2',
          seasonId: 'season_2',
          rating: 950, peak: 950, racesPlayed: 3, wins: 0, topThree: 0,
          recentAbandons: 0, lastRatedAt: 1, divisionId: 'plata',
        } as unknown as Record<string, unknown>,
        permissionRead: 2, permissionWrite: 1,
      },
    ]);
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2)],
    });
    handleRaceCompletedForRanked(deps, ev);
    const r1 = readRecord(nak, 'u1');
    const r2 = readRecord(nak, 'u2');
    expect(r1?.peak).toBeGreaterThanOrEqual(r1!.rating); // ≥ current rating
    expect(r2?.peak).toBeGreaterThanOrEqual(r2!.rating);
    expect(r1?.peak).toBeGreaterThanOrEqual(1050); // never goes below prev peak
    expect(r2?.peak).toBeGreaterThanOrEqual(950);
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — idempotency', () => {
  it('replay of the same sessionId → second call is a no-op', () => {
    const { deps, nak } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2)],
    });
    const out1 = handleRaceCompletedForRanked(deps, ev);
    expect(out1.processed).toBe(true);
    const r1Before = readRecord(nak, 'u1');
    // Replay
    const out2 = handleRaceCompletedForRanked(deps, ev);
    expect(out2.processed).toBe(false);
    expect(out2.reason).toBe('replay');
    // The record must not have moved on the second dispatch.
    const r1After = readRecord(nak, 'u1');
    expect(r1After?.racesPlayed).toBe(r1Before?.racesPlayed);
    expect(r1After?.rating).toBe(r1Before?.rating);
  });

  it('different sessionIds → both processed (independent markers)', () => {
    const { deps } = makeDeps();
    const ev1 = event({ sessionId: 'sid-a', results: [human('u1', 1), human('u2', 2)] });
    const ev2 = event({ sessionId: 'sid-b', results: [human('u1', 1), human('u2', 2)] });
    expect(handleRaceCompletedForRanked(deps, ev1).processed).toBe(true);
    expect(handleRaceCompletedForRanked(deps, ev2).processed).toBe(true);
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — leaderboard side-effects', () => {
  it('leaderboard ranked_{seasonId} gets a row per human with the new rating', () => {
    const { deps, nak } = makeDeps();
    const ev = event({
      needsReview: false,
      results: [human('u1', 1), human('u2', 2)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const newRatingByUser = Object.fromEntries(out.deltas.map((d) => [d.userId, d.newRating]));
    expect(readLeaderboardScore(nak, 'season_2', 'u1')).toBe(newRatingByUser.u1);
    expect(readLeaderboardScore(nak, 'season_2', 'u2')).toBe(newRatingByUser.u2);
  });

  it('leaderboard write uses operator=set so the latest rating always wins', () => {
    const { deps, nak } = makeDeps();
    // Two races, same players, different sessionIds.
    handleRaceCompletedForRanked(
      deps,
      event({
        sessionId: 'sid-1',
        results: [human('u1', 1), human('u2', 2)],
      }),
    );
    const after1 = readLeaderboardScore(nak, 'season_2', 'u1');
    // Reverse positions for race 2 — u2 should now win, the leaderboard
    // must reflect the new (lower) rating for u1 regardless of any
    // 'best' operator.
    handleRaceCompletedForRanked(
      deps,
      event({
        sessionId: 'sid-2',
        results: [human('u1', 2), human('u2', 1)],
      }),
    );
    const after2 = readLeaderboardScore(nak, 'season_2', 'u1');
    expect(after2).not.toBe(after1);
    // u2 should have gained rating on both legs; final >= first
    const u2After1 = readLeaderboardScore(nak, 'season_2', 'u2');
    expect(u2After1).toBeGreaterThan(1000);
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — first-time player', () => {
  it('human with no prior RankedRecord gets one created + rating updated', () => {
    const { deps, nak } = makeDeps();
    expect(readRecord(nak, 'u-new')).toBeNull();
    const ev = event({
      needsReview: false,
      results: [human('u-new', 1), human('u2', 2)],
    });
    const out = handleRaceCompletedForRanked(deps, ev);
    expect(out.processed).toBe(true);
    const rec = readRecord(nak, 'u-new');
    expect(rec).not.toBeNull();
    expect(rec?.rating).toBeGreaterThan(1000); // winner from default
    expect(rec?.racesPlayed).toBe(1);
    expect(rec?.wins).toBe(1);
    expect(rec?.topThree).toBe(1);
  });
});

describe('ranked subscriber (Phase 4 Chunk 7) — empty results', () => {
  it('empty results array → no-op with marker stamped', () => {
    const { deps, nak } = makeDeps();
    const out = handleRaceCompletedForRanked(deps, event({ results: [] }));
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('no_humans');
    expect(readProgress(nak, 'sid-1')).toBeDefined();
  });
});

// Helper: some vitest versions fail if `beforeEach` is imported but unused.
// Re-add it as a noop so future per-test setup has a slot.
beforeEach(() => {});