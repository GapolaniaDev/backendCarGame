// Phase 4 ranked module constants.

/** Per-client RPC rate-limit windows (calls per window per user). */
export const RATE_LIMITS = {
  // `ranked_get` runs on every UI render of the ranked badge — kept
  // generous so a chatty client never gets throttled.
  ranked_get: { maxPerWindow: 30, windowSec: 60 },
} as const;