// Phase 8 Chunk 9 — Test helper for the admin dashboard cache.
//
// The dashboard module keeps a 60s TTL per RPC. Tests that swap the
// fixture between cases need to flush the cache so an earlier result
// doesn't bleed into the next case.

import { clearDashboardCache } from './cache';

export function _resetAdminDashboardForTests(): void {
  clearDashboardCache();
}
