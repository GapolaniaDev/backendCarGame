// Phase 8 Chunk 2 — Anti-cheat test reset hook.
//
// Central place for any module-level state the anti-cheat helpers
// accumulate between tests. Chunk 2 ships with no in-process cache
// (all helpers are pure + storage-backed), but future chunks (3+: the
// marks aggregate cache, leaderboard_filter config) can extend this
// without changing import surfaces in tests.
//
// Usage in tests:
//   import { _resetAntiCheatStateForTests } from '../../modules/src/anti_cheat/_reset_for_tests';
//   beforeEach(() => _resetAntiCheatStateForTests());

/**
 * Wipes any module-level state held by the anti-cheat module.
 * No-op today; reserved for future chunks.
 */
export function _resetAntiCheatStateForTests(): void {
  // intentionally empty — pure helpers + storage-backed reads
}

/** Maximum CAS retries for storage writes (3.27, same value as chat/silenced). */
export const MAX_CAS_RETRIES = 3;