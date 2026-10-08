// Phase 7 Chunk 5 — Boot-time creation of the `club_week` leaderboard.
//
// The Nakama 3.27 JS runtime does NOT expose `registerLeaderboardReset`,
// so the weekly reset is handled at TWO levels:
//
//   1. The Nakama leaderboard table itself uses an internal cron
//      schedule (`0 0 * * 1` — Monday 00:00 UTC) so the ranked records
//      auto-zero every week without our involvement.
//   2. The per-club metadata (`clubs_metadata.weeklyPoints`) and the
//      per-member `clubs_members/{clubId}/{userId}.weeklyContribution`
//      field do NOT auto-reset — those are flattened in
//      `club_week_reset.ts` via a lazy reset on the first `club_get`
//      after the week boundary.
//
// `ensureClubWeekLeaderboard` is idempotent — the runtime returns
// `(created=false)` when the table already exists, so re-runs are
// safe.

import type { ILogger, INakama } from '../nkruntime';

export const CLUB_WEEK_LEADERBOARD_ID = 'club_week';

/** Cron expression for the weekly reset (Monday 00:00 UTC). */
export const CLUB_WEEK_RESET_SCHEDULE = '0 0 * * 1';

export interface EnsureClubWeekSummary {
  created: boolean;
  id: string;
  schedule: string;
}

/**
 * Idempotently ensure the `club_week` leaderboard table exists.
 *
 * Returns a single-row summary suitable for a boot log line. Never
 * throws — a runtime error is logged at warn and reported as a
 * no-op so a partial boot still proceeds.
 */
export function ensureClubWeekLeaderboard(
  logger: ILogger,
  nk: INakama,
): EnsureClubWeekSummary {
  try {
    const res = nk.leaderboardCreate(
      CLUB_WEEK_LEADERBOARD_ID,
      /* authoritative */ true,
      /* sortOrder */ 'desc',
      /* operator    */ 'incr',
      CLUB_WEEK_RESET_SCHEDULE,
      {
        description: 'Per-club cumulative weekly points (auto-reset Monday 00:00 UTC)',
        source: 'club_week',
        phase: 7,
        chunk: 5,
      },
      /* enableRanks */ true,
    );
    // Nakama's Go runtime returns `undefined` (not `{created:false}`) when
    // the table already exists. Treat that as "existing" so re-boots are
    // idempotent and don't log a spurious warning.
    const wasCreated = !!(res && res.created);
    logger.info(
      'club_week leaderboard ensure: id=%s created=%s schedule=%s',
      CLUB_WEEK_LEADERBOARD_ID,
      String(wasCreated),
      CLUB_WEEK_RESET_SCHEDULE,
    );
    return {
      created: wasCreated,
      id: CLUB_WEEK_LEADERBOARD_ID,
      schedule: CLUB_WEEK_RESET_SCHEDULE,
    };
  } catch (e) {
    logger.warn(
      'club_week leaderboard ensure failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return {
      created: false,
      id: CLUB_WEEK_LEADERBOARD_ID,
      schedule: CLUB_WEEK_RESET_SCHEDULE,
    };
  }
}