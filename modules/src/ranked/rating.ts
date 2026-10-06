// Phase 4 ranked rating math (pure, no storage, no `nk`).
//
// Elo-style update across N humans per race:
//
//   E_a(b) = 1 / (1 + 10^((R_b - R_a) / 400))
//   S_a(b) = 1 if pos_a < pos_b, 0.5 if equal, 0 if greater   (DNF/abandon == last)
//   expected_a = Σ_b E_a(b)        (over every OTHER human)
//   actual_a   = Σ_b S_a(b)
//   Δ_a = round(K_a × (actual_a - expected_a))
//
// The K-factor is supplied per-human so an "initial" player (first 10
// races of the season) uses `kFactorInitial` while a veteran uses
// `kFactorNormal`. The caller (the RaceCompleted subscriber in Chunk
// 7) computes the per-human K-factor from the record's `racesPlayed`
// count and the bundled `ranked_config.json`.
//
// Conservation: when every human uses the SAME K-factor, the total
// delta sums to 0 (E_a + E_b = 1 per pair, S_a + S_b = 1 per pair).
// When K-factors differ (mixed initial/normal), the total is
// non-zero — the stronger K moves proportionally more.
//
// Edge cases:
//   - 0 humans → empty arrays, no-op.
//   - 1 human  → no opponents, expected = 0, actual = 0, Δ = 0.
//     Should never happen in practice (a ranked race always has
//     ≥ 2 participants), but the function degrades defensively.
//
// Used by Chunk 7 (RaceCompleted → rating subscriber) and Chunk 8 (stats
// equalization hook). The function is pure so tests don't need stubs.

/** Maximum rating allowed by Nakama storage (int32). Above this we clamp. */
export const RATING_MAX = 2_147_483_647;
/** Minimum rating. We clamp negatives to 0 so the storage stays unsigned-friendly. */
export const RATING_MIN = 0;

export interface RatingChangeArgs {
  /** Current rating for each human finisher (length N). */
  ratings: ReadonlyArray<number>;
  /**
   * Finishing position per human: 1 = first, N = last. Abandoned or
   * DNF humans MUST be placed last (rank = N) — the formula treats
   * them as the worst finisher automatically (actual = 0 against
   * every opponent).
   */
  positions: ReadonlyArray<number>;
  /**
   * K-factor per human (e.g. `40` for the first 10 races of a
   * season, `24` afterwards). The caller picks this based on
   * `RankedRecord.racesPlayed` and the bundled `ranked_config.json`.
   */
  kFactors: ReadonlyArray<number>;
}

export interface RatingChangeResult {
  /** Updated ratings (clamped to [RATING_MIN, RATING_MAX]). */
  newRatings: number[];
  /** Per-human rating delta applied this race (rounded integer). */
  deltas: number[];
}

/**
 * Compute the Elo-style rating update for a multi-human ranked race.
 *
 * @throws when input arrays have mismatched sizes or zero length.
 */
export function ratingChange(args: RatingChangeArgs): RatingChangeResult {
  const { ratings, positions, kFactors } = args;
  const n = ratings.length;
  if (n !== positions.length || n !== kFactors.length) {
    throw new Error(
      `ratingChange: array length mismatch (ratings=${n} positions=${positions.length} kFactors=${kFactors.length})`,
    );
  }
  if (n === 0) return { newRatings: [], deltas: [] };

  const deltas = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const rI = ratings[i]!;
    const pI = positions[i]!;
    const kI = kFactors[i]!;
    let expected = 0;
    let actual = 0;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      expected += expectedScore(rI, ratings[j]!);
      actual += actualScore(pI, positions[j]!);
    }
    deltas[i] = Math.round(kI * (actual - expected));
  }

  const newRatings = deltas.map((d, i) => clampRating(ratings[i]! + d));
  return { newRatings, deltas };
}

/**
 * Expected score of player A vs player B given their current ratings.
 *   E_a = 1 / (1 + 10^((R_b - R_a) / 400))
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  const exponent = (ratingB - ratingA) / 400;
  return 1 / (1 + Math.pow(10, exponent));
}

/**
 * Actual score of player A vs player B given their finishing
 * positions. 1 = win, 0.5 = tie, 0 = loss. Abandoned humans occupy
 * the LAST rank in `positions` so this naturally yields 0 against
 * every opponent.
 */
export function actualScore(positionA: number, positionB: number): number {
  if (positionA < positionB) return 1;
  if (positionA === positionB) return 0.5;
  return 0;
}

/** Clamp to the safe rating range. Exposed for tests + subscribers. */
export function clampRating(rating: number): number {
  // NaN — there's nothing we can do, fall back to the floor.
  if (Number.isNaN(rating)) return RATING_MIN;
  // ±Infinity — pick the matching edge of the safe range.
  if (!Number.isFinite(rating)) {
    return rating > 0 ? RATING_MAX : RATING_MIN;
  }
  if (rating < RATING_MIN) return RATING_MIN;
  if (rating > RATING_MAX) return RATING_MAX;
  return Math.trunc(rating);
}

/**
 * Simulate `rounds` consecutive races of the same shape against an
 * infinite pool of identical opponents and return the resulting
 * rating. Used by the "no overflow in 100k partidas" test — a
 * conservative bound check.
 */
export function simulateBoundedByRatings(
  startRating: number,
  rounds: number,
  kFactor: number,
  opponentRating = startRating,
): number {
  let r = startRating;
  for (let i = 0; i < rounds; i += 1) {
    const e = expectedScore(r, opponentRating);
    // Always win (actual = 1) against the same-rated opponent.
    const delta = Math.round(kFactor * (1 - e));
    r = clampRating(r + delta);
  }
  return r;
}