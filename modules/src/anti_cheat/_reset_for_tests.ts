// Phase 8 Chunks 2-3 — Anti-cheat test reset hook.
//
// Central place for any module-level state the anti-cheat helpers
// accumulate between tests. Chunk 3 added a cached `mark_thresholds`
// for `severityForMarkCount`; resetting here clears it.

import { _resetMarksStateForTests } from './marks';

/**
 * Wipes any module-level state held by the anti-cheat module. Wired
 * to the catalog reset hook (`_resetAntiCheatStateForTests` is called
 * from test `beforeEach` blocks).
 */
export function _resetAntiCheatStateForTests(): void {
  _resetMarksStateForTests();
}

/** Maximum CAS retries for storage writes (3.27, same value as chat/silenced). */
export const MAX_CAS_RETRIES = 3;