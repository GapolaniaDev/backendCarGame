// Phase 8 Chunk 3 — Leaderboard filter.
//
// Single entry point consulted by the ranked (P4), club_week (P7), and
// tournament (P8 Ch5) subscribers BEFORE incrementing a leaderboard.
// Returns `true` when the user is currently hidden — the subscriber
// then skips the write (and emits a 'leaderboard_filtered' analytics
// event, Chunk 4).
//
// Hot path: called 3× per race completion. NO CACHE — visibility
// changes (admin unsanction / dismissal) must take effect immediately
// and the read is a single small row.

import type { INakama } from '../nkruntime';
import { isHidden, readMarks } from './marks';

/**
 * Returns true when the user should be excluded from leaderboard
 * writes for the current race completion. Always reads fresh from
 * `anti_cheat_marks/{userId}` — never cached.
 */
export function shouldExcludeFromLeaderboards(
  nk: INakama,
  userId: string,
  nowUtc: number,
): boolean {
  const marks = readMarks(nk, userId);
  return isHidden(marks, nowUtc);
}