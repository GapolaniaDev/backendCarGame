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

/**
 * Active-session index (plan T-08, audit PC-08): one system-owned object
 * per player, key = userId, value `{ sessionId, since }`. Written when the
 * player creates, joins or is matched into a session; removed when that
 * session closes. `race_session_get` without a `sessionId` resolves it.
 */
export const RACE_ACTIVE_COLLECTION = 'race_active';

/**
 * A `created` session the player never started stops being "active"
 * after this long (a matchmaker session nobody used, plan T-09).
 */
export const CREATED_SESSION_TTL_MS = 10 * 60_000;

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
 * Grace period after the first human report during which non-reporting
 * players are still considered in-flight. After this window, the
 * server marks them `abandoned: true` (DNF) and closes the session
 * (plan T-06, audit PC-06): lazily in `race_session_get` /
 * `race_submit_result`, and from the service ticker. Shorter than the
 * client's close timeout (`RaceBackendConfig.closeTimeoutSeconds`, 45 s).
 */
export const CLOSE_GRACE_MS = 30_000;

/**
 * A started session where no human ever reports closes this long after
 * `startedAt`, with every player DNF, so it does not stay open forever.
 */
export const ABANDONED_SESSION_MS = 30 * 60_000;

/**
 * Open-session index (plan T-06): one system-owned object per started,
 * not yet closed session (key = sessionId), so the service ticker can find
 * the sessions whose grace expired without scanning every race object.
 */
export const RACE_OPEN_COLLECTION = 'race_open';

/**
 * Phase 4 Chunk 4 — host-claim grace window. After this many seconds
 * since `disconnectReportedAt` was stamped on the host's roster entry,
 * a new claim is rejected (the host is treated as abandoned and the
 * session is closed by the abandon tracker in Chunk 9). Aligned with
 * `ranked_config.graceSeconds` = 20.
 *
 * The validation tolerates +5s of clock drift on top of this so the
 * relay's reportedAt and the server's nowMs don't race.
 */
export const HOST_CLAIM_GRACE_SECONDS = 20;
export const HOST_CLAIM_GRACE_TOLERANCE_MS = 5_000;

/**
 * Plan T-07 (audit PC-07): the host counts as gone, and the next live
 * player in `hostSuccession` may claim it, when the server has had no
 * contact from the host (`race_session_get`, `race_submit_result`) for
 * longer than this. The client polls every 2 s
 * (`RaceBackendConfig.pollSeconds`), so 10 s is five missed polls.
 */
export const HOST_STALE_MS = 10_000;

/**
 * Last-contact index (plan T-07): one system-owned object per participant,
 * key `{sessionId}/{userId}`, value `{ lastSeenMs }`. Kept apart from the
 * session document so a poll never races a submit on the session CAS.
 */
export const RACE_PRESENCE_COLLECTION = 'race_presence';

/** Per-client RPC rate-limit windows (calls per window per user). */
export const RATE_LIMITS = {
  config_get: { maxPerWindow: 60, windowSec: 60 },
  race_session_create: { maxPerWindow: 6, windowSec: 60 },
  race_session_join: { maxPerWindow: 30, windowSec: 60 },
  race_session_start: { maxPerWindow: 6, windowSec: 60 },
  race_session_get: { maxPerWindow: 60, windowSec: 60 },
  race_submit_result: { maxPerWindow: 6, windowSec: 60 },
  race_session_quick_bots: { maxPerWindow: 6, windowSec: 60 },
  race_host_claim: { maxPerWindow: 3, windowSec: 60 },
} as const;

/**
 * Supported RPC names. Used by the event_bus `RaceCompleted` key and
 * by the test harness to enumerate handlers.
 */
export const RACE_EVENT_RACE_COMPLETED = 'RaceCompleted';