// Phase 5 Chunk 6 — `admin_cleanup_race_sessions`.
//
// Deletes every race session whose `state === 'closed'` and every
// expired inbox row. Both lists are system-owned (race_sessions live
// under SYSTEM_USER_ID; inbox messages live under their owning user
// but with permissionWrite=0 — server-only writes).
//
// Idempotent by construction: re-running the RPC finds nothing left
// to delete and returns `{ deleted: 0 }`.
//
// Paginates at 100 per call to stay under the runtime's storageList
// ceiling; loops until the cursor is empty or we hit the safety cap.

import type { IStorageObject, IStorageKey, ILogger, INakama } from '../nkruntime';
import { RACE_SESSIONS_COLLECTION, SYSTEM_USER_ID } from '../race/constants';
import { INBOX_COLLECTION } from '../liveops/messages';
import { emitAdminAction } from '../core/admin/analytics';
import type {
  AdminCleanupRaceSessionsInput,
  AdminCleanupRaceSessionsOutput,
} from './types';

const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 100 × 50 = 5000 entries per collection per call.

export interface CleanupResult {
  ok: boolean;
  error?: { code: string; message: string };
  data?: AdminCleanupRaceSessionsOutput;
}

export function cleanupRaceSessions(
  nk: INakama,
  logger: ILogger,
  _input: AdminCleanupRaceSessionsInput,
): CleanupResult {
  let deleted = 0;

  // ─── 1. Closed race sessions ─────────────────────────────────────────────
  const closedDeletes: IStorageKey[] = [];
  let cursor = '';
  let page = 0;
  do {
    const res = nk.storageList({
      collection: RACE_SESSIONS_COLLECTION,
      limit: PAGE_LIMIT,
      cursor,
    });
    for (const o of res.objects as IStorageObject[]) {
      const v = o.value as { state?: string };
      if (v.state === 'closed') {
        closedDeletes.push({ collection: RACE_SESSIONS_COLLECTION, key: o.key, userId: SYSTEM_USER_ID });
      }
    }
    cursor = res.cursor ?? '';
    page += 1;
    if (page >= MAX_PAGES) break;
  } while (cursor !== '' && page < MAX_PAGES);
  if (closedDeletes.length > 0) {
    nk.storageDelete(closedDeletes);
    deleted += closedDeletes.length;
  }

  // ─── 2. Expired inbox messages (every owner) ────────────────────────────
  const inboxDeletes: IStorageKey[] = [];
  cursor = '';
  page = 0;
  const nowMs = Date.now();
  do {
    const res = nk.storageList({ collection: INBOX_COLLECTION, limit: PAGE_LIMIT, cursor });
    for (const o of res.objects as IStorageObject[]) {
      const v = o.value as { expiresAt?: number; userId?: string };
      if (typeof v.expiresAt === 'number' && v.expiresAt <= nowMs && typeof v.userId === 'string') {
        inboxDeletes.push({ collection: INBOX_COLLECTION, key: o.key, userId: v.userId });
      }
    }
    cursor = res.cursor ?? '';
    page += 1;
    if (page >= MAX_PAGES) break;
  } while (cursor !== '' && page < MAX_PAGES);
  if (inboxDeletes.length > 0) {
    nk.storageDelete(inboxDeletes);
    deleted += inboxDeletes.length;
  }

  emitAdminAction(nk, logger, 'admin_cleanup_race_sessions', {
    raceSessionsDeleted: closedDeletes.length,
    inboxDeleted: inboxDeletes.length,
    total: deleted,
  });
  logger.warn('admin_cleanup_race_sessions race_sessions=%d inbox=%d total=%d', closedDeletes.length, inboxDeletes.length, deleted);
  return { ok: true, data: { deleted } };
}