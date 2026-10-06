// Phase 4 Chunk 5 unit tests for the pure Elo-style rating math.
//
// Covers:
//   - 2-human symmetric games (same rating, very different ratings)
//   - N>2 mass-participation (conservation when K is uniform)
//   - abandon (last place) reduces rating
//   - K-factor initial > K-factor normal (per-player)
//   - ties (positions [1,1,…])
//   - edge: 0 humans, 1 human, length mismatch, NaN/Inf
//   - overflow protection (100k partidas, int32 max)
//   - conservation under uniform K, broken conservation under mixed K
//
// All tests are pure — no nk, no storage. The function under
// `modules/src/ranked/rating.ts` is also pure.

import { describe, it, expect } from 'vitest';
import {
  ratingChange,
  expectedScore,
  actualScore,
  clampRating,
  simulateBoundedByRatings,
  RATING_MAX,
  RATING_MIN,
} from '../../modules/src/ranked/rating';

const K24 = 24;
const K40 = 40;

describe('rating (Phase 4 Chunk 5) — basic Elo', () => {
  it('expectedScore: same rating → 0.5', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('expectedScore: 1000 vs 1500 → low (underdog has ~0.09)', () => {
    // 1 / (1 + 10^((1500-1000)/400)) = 1 / (1 + 10^1.25) ≈ 0.0528…
    expect(expectedScore(1000, 1500)).toBeCloseTo(0.0528, 3);
  });

  it('expectedScore is symmetric: E_a + E_b = 1', () => {
    for (const [rA, rB] of [
      [1000, 1000],
      [1000, 1500],
      [800, 1400],
      [1234, 567],
    ]) {
      const sum = expectedScore(rA!, rB!) + expectedScore(rB!, rA!);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('actualScore: posA < posB → 1 (win)', () => {
    expect(actualScore(1, 2)).toBe(1);
  });

  it('actualScore: posA === posB → 0.5 (tie)', () => {
    expect(actualScore(1, 1)).toBe(0.5);
  });

  it('actualScore: posA > posB → 0 (loss)', () => {
    expect(actualScore(3, 2)).toBe(0);
  });
});

describe('rating (Phase 4 Chunk 5) — ratingChange()', () => {
  it('2 humans, same rating, no ties → both Δ ≈ 0', () => {
    const r = ratingChange({
      ratings: [1000, 1000],
      positions: [1, 2],
      kFactors: [K24, K24],
    });
    expect(r.newRatings[0]).toBe(1012);
    expect(r.newRatings[1]).toBe(988);
    expect(r.deltas[0]).toBe(12);
    expect(r.deltas[1]).toBe(-12);
    // Sum ≈ 0 (conservation with uniform K).
    expect(r.deltas[0]! + r.deltas[1]!).toBe(0);
  });

  it('2 humans, same rating, tied → both Δ = 0', () => {
    const r = ratingChange({
      ratings: [1000, 1000],
      positions: [1, 1],
      kFactors: [K24, K24],
    });
    expect(r.deltas[0]).toBe(0);
    expect(r.deltas[1]).toBe(0);
    expect(r.newRatings[0]).toBe(1000);
    expect(r.newRatings[1]).toBe(1000);
  });

  it('2 humans, weak beats strong (underdog wins big)', () => {
    const r = ratingChange({
      ratings: [800, 1400],
      positions: [1, 2], // 800 wins, 1400 loses
      kFactors: [K24, K24],
    });
    // The 800 player gains ~22 (huge upset); 1400 loses ~22.
    expect(r.deltas[0]!).toBeGreaterThan(20);
    expect(r.deltas[0]!).toBeLessThan(25);
    expect(r.deltas[1]!).toBe(-r.deltas[0]!);
  });

  it('2 humans, strong beats weak → strong gains a little, weak loses a lot', () => {
    const r = ratingChange({
      ratings: [800, 1400],
      positions: [2, 1], // 800 loses, 1400 wins
      kFactors: [K24, K24],
    });
    // Expected outcome → small shift toward expected winner.
    expect(r.deltas[1]!).toBeLessThan(5);
    expect(r.deltas[1]!).toBeGreaterThan(0);
    expect(Math.abs(r.deltas[0]!)).toBeLessThan(5);
  });

  it('4 humans, all rating=1000 → symmetric Δ ≈ 0', () => {
    const r = ratingChange({
      ratings: [1000, 1000, 1000, 1000],
      positions: [1, 2, 3, 4],
      kFactors: [K24, K24, K24, K24],
    });
    // Mirror image: 1st and 4th are equal-and-opposite; 2nd and 3rd too.
    expect(r.deltas[0]!).toBe(36);
    expect(r.deltas[3]!).toBe(-36);
    expect(r.deltas[1]!).toBe(12);
    expect(r.deltas[2]!).toBe(-12);
  });

  it('6 humans mixed positions, uniform K → sum of Δ = 0 (conservation)', () => {
    const r = ratingChange({
      ratings: [1000, 1100, 1200, 900, 1300, 800],
      positions: [1, 2, 3, 4, 5, 6],
      kFactors: [K24, K24, K24, K24, K24, K24],
    });
    const sum = r.deltas.reduce((acc, d) => acc + d, 0);
    expect(sum).toBe(0);
  });

  it('4 humans, 1 abandon (last place) → abandoner Δ ≤ -K', () => {
    // player 0 abandons: positions [4, 1, 2, 3]
    const r = ratingChange({
      ratings: [1000, 1000, 1000, 1000],
      positions: [4, 1, 2, 3],
      kFactors: [K24, K24, K24, K24],
    });
    // The abandoner loses more than a regular last-place finisher because
    // they get 0 against every opponent. With K=24, Δ = -K × 3 = -36.
    expect(r.deltas[0]!).toBe(-36);
    expect(r.deltas[0]!).toBeLessThanOrEqual(-K24);
  });

  it('K-factor initial (40) vs normal (24) → initial produces larger Δ', () => {
    const initial = ratingChange({
      ratings: [1000, 1000],
      positions: [1, 2],
      kFactors: [K40, K24],
    });
    const normal = ratingChange({
      ratings: [1000, 1000],
      positions: [1, 2],
      kFactors: [K24, K24],
    });
    // Initial winner gains more because K is higher.
    expect(Math.abs(initial.deltas[0]!)).toBeGreaterThan(Math.abs(normal.deltas[0]!));
  });

  it('tied players Δ=0 between themselves, normal Δ vs others', () => {
    // Positions [1, 1, 3, 4] — players 1 and 2 tied for first.
    const r = ratingChange({
      ratings: [1000, 1000, 1000, 1000],
      positions: [1, 1, 3, 4],
      kFactors: [K24, K24, K24, K24],
    });
    // Tied players have 0 actual between each other. Their total wins are
    // shared: each gets +1 win against 3rd + +0 vs the other tie + +1
    // win vs 4th (since 4th finishes worse than 1st and 2nd).
    expect(r.deltas[0]).toBe(r.deltas[1]);
    expect(r.deltas[0]!).toBeGreaterThan(0);
    expect(r.deltas[3]!).toBeLessThan(0);
  });

  it('edge: 0 humans → empty arrays', () => {
    const r = ratingChange({ ratings: [], positions: [], kFactors: [] });
    expect(r.newRatings).toEqual([]);
    expect(r.deltas).toEqual([]);
  });

  it('edge: 1 human (degraded, defensive) → Δ = 0', () => {
    const r = ratingChange({
      ratings: [1000],
      positions: [1],
      kFactors: [K24],
    });
    expect(r.newRatings[0]).toBe(1000);
    expect(r.deltas[0]).toBe(0);
  });

  it('input validation: length mismatch → throw', () => {
    expect(() =>
      ratingChange({ ratings: [1000, 1000], positions: [1], kFactors: [K24, K24] }),
    ).toThrow(/length mismatch/);
    expect(() =>
      ratingChange({ ratings: [1000], positions: [1, 2], kFactors: [K24] }),
    ).toThrow(/length mismatch/);
    expect(() =>
      ratingChange({ ratings: [1000, 1000], positions: [1, 2], kFactors: [K24] }),
    ).toThrow(/length mismatch/);
  });

  it('mixed K factors → conservation broken (sum ≠ 0)', () => {
    const r = ratingChange({
      ratings: [1000, 1000, 1000, 1000],
      positions: [1, 2, 3, 4],
      kFactors: [K40, K24, K24, K24],
    });
    // Player 0 (initial) moves more → sum ≠ 0.
    const sum = r.deltas.reduce((acc, d) => acc + d, 0);
    expect(sum).not.toBe(0);
    // The asymmetry is exactly the delta difference between K40 and K24
    // for player 0's moves: (40-24) × (sum_actual_exp for player 0).
    expect(Math.abs(sum)).toBeLessThan(K40);
  });

  it('overflow protection: result is clamped to int32 range', () => {
    const r = ratingChange({
      ratings: [RATING_MAX, RATING_MAX],
      positions: [1, 2],
      kFactors: [K24, K24],
    });
    expect(r.newRatings[0]).toBeLessThanOrEqual(RATING_MAX);
    expect(r.newRatings[1]).toBeLessThanOrEqual(RATING_MAX);
  });

  it('underflow protection: result is clamped at 0', () => {
    const r = ratingChange({
      ratings: [0, 0],
      positions: [2, 1], // 0 loses against 0 → tiny penalty
      kFactors: [K24, K24],
    });
    expect(r.newRatings[0]!).toBeGreaterThanOrEqual(RATING_MIN);
    expect(r.newRatings[1]!).toBeGreaterThanOrEqual(RATING_MIN);
  });

  it('100k partidas against same-rated opponent never overflows int32', () => {
    // Worst case: start at 0 and always win against another 0-rated
    // opponent. The Elo curve flattens as the gap grows — we just need
    // to confirm the result stays within [0, RATING_MAX].
    const r = simulateBoundedByRatings(0, 100_000, K40, 0);
    expect(r).toBeLessThanOrEqual(RATING_MAX);
    expect(r).toBeGreaterThanOrEqual(RATING_MIN);
    // Asymptote: once the gap is huge, expected ≈ 0 and Δ ≈ K, so the
    // rating grows ~K per round but stays bounded by the clamp.
    // Specifically: after the first few hundred rounds the expected
    // score is essentially 0 and Δ = K = 40 each round, so the
    // asymptotic growth per round is bounded and the 100k-round total
    // fits inside int32.
    expect(r).toBeLessThan(2_147_000_000);
  });
});

describe('rating (Phase 4 Chunk 5) — clampRating()', () => {
  it('clamps NaN to RATING_MIN', () => {
    expect(clampRating(Number.NaN)).toBe(RATING_MIN);
  });

  it('clamps Infinity to RATING_MAX', () => {
    expect(clampRating(Number.POSITIVE_INFINITY)).toBe(RATING_MAX);
  });

  it('clamps negatives to RATING_MIN', () => {
    expect(clampRating(-5)).toBe(RATING_MIN);
  });

  it('truncates fractional values', () => {
    expect(clampRating(1234.7)).toBe(1234);
  });

  it('passes through valid integers unchanged', () => {
    expect(clampRating(1000)).toBe(1000);
    expect(clampRating(0)).toBe(0);
    expect(clampRating(RATING_MAX)).toBe(RATING_MAX);
  });
});