// Phase 8 Chunk 8 — Pure helpers that wrap `activeEventMultipliers` for
// use in the RaceCompleted subscriber and the store pricing layer.
//
// The catalog loader already implements the "highest wins" rule (D22)
// for overlapping `xp_double` events; this module is a thin re-export
// so the call site reads as `resolveXpMultiplier(now)` instead of
// `activeEventMultipliers(now).xp`.

import { activeEventMultipliers } from '../core/active_events';

/**
 * Multiplier to apply on top of the base XP for a race that completes
 * at `nowUtc`. Returns 1 when no `xp_double` event is active. The
 * catalog enforces "highest wins" — see `activeEventMultipliers`.
 */
export function resolveXpMultiplier(nowUtc: number): number {
  return activeEventMultipliers(nowUtc).xp;
}

/**
 * Multiplier to apply on top of the base coin reward for a race. Same
 * source as `resolveXpMultiplier`; the catalog returns the same value
 * for both fields today, but a future chunk may split them.
 */
export function resolveCoinMultiplier(nowUtc: number): number {
  return activeEventMultipliers(nowUtc).coins;
}
