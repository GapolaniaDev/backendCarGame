// Defines authoritative game server data. Loaded once at startup
// from /nakama/data/modules/ (mounted from ./modules in compose).
//
// Nakama 3.27 JS bindings: signature is (ctx, logger, nk).
// leaderboardCreate is INSERT-IF-NOT-EXISTS — to change config,
// delete first then re-create.

function InitModule(ctx, logger, nk) {
  // Delete any prior copy so the create applies the full config.
  try {
    nk.leaderboardDelete("race_score");
  } catch (e) {
    // ok if not found
  }

  nk.leaderboardCreate(
    "race_score",       // 1: id (string)
    false,              // 2: authoritative (bool, default false)
    "descending",       // 3: sort_order ('asc'|'ascending'|'desc'|'descending')
    "best",             // 4: operator ('best'|'set'|'incr'|'decr')
    "0 0 * * 1",       // 5: reset_schedule (cron, default "")
    {                   // 6: metadata (object)
      category: "racing",
      game: "CarVideoGame"
    },
    false               // 7: enable_ranks (bool, default false)
  );

  logger.info("race_score leaderboard ensured");
}
