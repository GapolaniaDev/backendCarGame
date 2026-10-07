// Phase 7 Chunk 5 — Club week points + reward helpers (pure).
//
// Scoring rule (locked):
//   - win  (rank=1, !abandoned) → 3 points
//   - podium (rank ∈ {2,3}, !abandoned) → 2 points
//   - finish (rank ≥ 4, !abandoned) → 1 point
//   - abandoned → 0
//   - bots → 0 (never credited)
//
// Confidence gate (locked):
//   - only `server` or `quorum` close-outcomes credit points
//   - `client` (humans disagreed) → drop the whole event; nobody is credited
//
// Weekly reward (locked):
//   - on Monday 00:00 UTC, the winning club is the #1 row on the
//     `club_week` leaderboard
//   - the top 3 members of that club (by per-member weeklyContribution)
//     each receive an inbox reward message

import type { RaceCompletedEvent, RaceResult } from '../race/types';

/** Points awarded for a single race result. */
export const POINTS_WIN = 3;
export const POINTS_PODIUM = 2;
export const POINTS_FINISH = 1;

/** Coins credited per weekly-reward recipient (top 3 of winning club). */
export const WEEKLY_REWARD_COINS = 250;

/** Maximum number of reward recipients per week. */
export const WEEKLY_REWARD_MAX_RECIPIENTS = 3;

/** Inbox retention override — give the reward a generous TTL so players can claim it later in the week. */
export const WEEKLY_REWARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute the weekly-points credit for a single race result row.
 *
 * Pure / no I/O. Bots and abandoned entries return 0.
 */
export function pointsForRaceResult(r: RaceResult): number {
  if (r.isBot) return 0;
  if (r.abandoned) return 0;
  if (r.rank === 1) return POINTS_WIN;
  if (r.rank === 2 || r.rank === 3) return POINTS_PODIUM;
  return POINTS_FINISH;
}

/**
 * Aggregate points across every human finisher in the event.
 *
 * Returns `0` and `{ aborted: true }` when the close-confidence gate
 * is `client` — callers MUST drop the event in that case so no leaderboard
 * or storage write happens.
 */
export function pointsForRace(
  event: RaceCompletedEvent,
): { total: number; aborted: boolean; reason: string } {
  if (event.flags.needsReview) {
    // Mirrors the leaderboard writer's `client` close outcome (humans
    // disagreed). Drop the entire event.
    return { total: 0, aborted: true, reason: 'confidence_client' };
  }
  let total = 0;
  for (const r of event.results) {
    total += pointsForRaceResult(r);
  }
  return { total, aborted: false, reason: 'ok' };
}

/**
 * Pick the top-N members of a club by `weeklyContribution` descending.
 * Pure; callers pass already-loaded member rows.
 *
 * Members with `weeklyContribution > 0` win ties by `joinedAt` (earlier
 * member wins) so the result is stable across resets. Members with the
 * exact same contribution AND joinedAt fall back to userId lex order
 * (also deterministic).
 */
export interface ContributionRow {
  userId: string;
  weeklyContribution: number;
  joinedAt: number;
}

export function pickTopContributors(
  rows: ReadonlyArray<ContributionRow>,
  limit: number = WEEKLY_REWARD_MAX_RECIPIENTS,
): ContributionRow[] {
  const sorted = rows.slice().sort((a, b) => {
    if (a.weeklyContribution !== b.weeklyContribution) {
      return b.weeklyContribution - a.weeklyContribution;
    }
    if (a.joinedAt !== b.joinedAt) {
      return a.joinedAt - b.joinedAt;
    }
    if (a.userId < b.userId) return -1;
    if (a.userId > b.userId) return 1;
    return 0;
  });
  return sorted.slice(0, limit);
}