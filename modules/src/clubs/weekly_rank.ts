// Plan B2 (D-02) — the real weekly rank of a club on `club_week`.

import type { INakama } from '../nkruntime';
import { CLUB_WEEK_LEADERBOARD_ID } from './leaderboard_init';

/** Rank of the club on `club_week` this week (Nakama's rank, table order), or null without a record (plan B2, D-02). Never throws: a failed read is null. */
export function readClubWeeklyRank(nk: INakama, clubId: string): number | null {
  try {
    const own = nk
      .leaderboardRecordsList(CLUB_WEEK_LEADERBOARD_ID, [clubId], 0)
      .ownerRecords.find((r) => r.ownerId === clubId);
    return own && typeof own.rank === 'number' && own.rank > 0 ? own.rank : null;
  } catch {
    // Contract: a failed read (missing table, runtime error) means "no rank".
    return null;
  }
}
