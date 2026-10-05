// Race module constants. Numbers come from the Phase 1 spec; bumping
// them requires updating the README and `docs/race-protocol-ops.md`.

/**
 * System-owned userId used as the owner for server-only storage objects
 * (race_sessions/{sid}, catalogs/*, liveops/config). Clients cannot read
 * these because perms are 0/0.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Storage collection for race sessions. */
export const RACE_SESSIONS_COLLECTION = 'race_sessions';

/** Storage sub-collection (key in session doc) for per-user reports. */
export const RACE_REPORTS_COLLECTION = 'race_sessions';

/** Sub-key inside `race_sessions` whose value is a server-side reports list. */
export const REPORTS_INDEX_KEY = '__reports_index';

/**
 * Tolerance for the player's reported totalMs vs. the wall clock
 * (`startedAt + totalMs <= now + CLOCK_SKEW_TOLERANCE_MS`). 500 ms
 * covers normal jitter from the client loop and network latency.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 500;

/**
 * Grace period after the first report during which non-reporting
 * players are still considered in-flight. After this window, the
 * server marks them `abandoned: true` and closes the session.
 */
export const CLOSE_GRACE_MS = 30_000;

/** Per-client RPC rate-limit windows (calls per window per user). */
export const RATE_LIMITS = {
  config_get: { maxPerWindow: 60, windowSec: 60 },
  race_session_create: { maxPerWindow: 6, windowSec: 60 },
  race_session_join: { maxPerWindow: 30, windowSec: 60 },
  race_session_start: { maxPerWindow: 6, windowSec: 60 },
  race_session_get: { maxPerWindow: 60, windowSec: 60 },
  race_submit_result: { maxPerWindow: 6, windowSec: 60 },
} as const;

/**
 * Supported RPC names. Used by the event_bus `RaceCompleted` key and
 * by the test harness to enumerate handlers.
 */
export const RACE_EVENT_RACE_COMPLETED = 'RaceCompleted';