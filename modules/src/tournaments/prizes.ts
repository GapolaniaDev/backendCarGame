// Phase 8 Chunk 6 — Prize distribution (pure).
//
// `distributePrizes` is a pure function: given a tournament's prize
// tiers + a sorted leaderboard, return the per-user grant list. No
// I/O, no side effects. The scanner (and the tests) drive the actual
// wallet grant + inbox send separately.
//
// Tiers are non-overlapping, ordered by rank. The first user at
// position 1 with rankFrom=1, rankTo=3 receives the tier rewards;
// a tier with rankFrom=4, rankTo=10 covers positions 4..10.
//
// Returned entries are sorted by rank ascending. Users who do not
// finish within a tier's range are omitted (no prize).

import type {
  Tournament,
  TournamentPrizeTier,
  TournamentRewards,
} from './types';

export interface PrizeDistributionRow {
  userId: string;
  rank: number;
  tierRankFrom: number;
  tierRankTo: number;
  rewards: TournamentRewards;
  distributed: true;
}

/**
 * Sort the leaderboard ascending by `bestTimeMs` and assign 1-indexed
 * ranks. Ties (equal bestTimeMs) keep their insertion order; the
 * caller decides whether to break ties differently in the future.
 */
export function rankLeaderboard(
  leaderboard: ReadonlyArray<{ userId: string; bestTimeMs: number }>,
): Array<{ userId: string; rank: number; bestTimeMs: number }> {
  const sorted = [...leaderboard].sort((a, b) => a.bestTimeMs - b.bestTimeMs);
  return sorted.map((e, i) => ({ userId: e.userId, rank: i + 1, bestTimeMs: e.bestTimeMs }));
}

/**
 * Compute prize distributions. Returns one row per (tier × matched
 * user). Users not covered by any tier get nothing.
 */
export function distributePrizes(
  tournament: Pick<Tournament, 'prizes'>,
  leaderboard: ReadonlyArray<{ userId: string; bestTimeMs: number }>,
  _nowUtc: number,
): PrizeDistributionRow[] {
  const ranked = rankLeaderboard(leaderboard);
  const out: PrizeDistributionRow[] = [];

  // Sort tiers by rankFrom asc so output is deterministic.
  const tiers: ReadonlyArray<TournamentPrizeTier> = [...tournament.prizes]
    .sort((a, b) => a.rankFrom - b.rankFrom);

  for (const tier of tiers) {
    for (const r of ranked) {
      if (r.rank >= tier.rankFrom && r.rank <= tier.rankTo) {
        out.push({
          userId: r.userId,
          rank: r.rank,
          tierRankFrom: tier.rankFrom,
          tierRankTo: tier.rankTo,
          rewards: tier.rewards,
          distributed: true,
        });
      }
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}
