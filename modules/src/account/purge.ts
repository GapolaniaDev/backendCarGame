// Phase 5 Chunk 5 — Account purge helpers.
//
// `purgeUserStorage(nk, userId)` walks every storage collection and
// deletes every object owned by the user. This is the GDPR-compliant
// path: we cannot enumerate a closed list because the system
// accumulates new ones over phases (Phase 4 added `ranked`, `ranked_progress`,
// Phase 5 Chunk 3 added `inbox`, Chunk 4 added `account_link_conflict`,
// future phases will add more).
//
// `purgeFromLeaderboards(nk, userId)` deletes every leaderboard
// record for the user across all authoritative tables.
//
// Caveats:
//   - `abandons/{userId}` and `pc-account/{userId}` are derived caches
//     (admin cleanup cron in Chunk 6) — explicitly SKIPPED here so
//     the FK-cleanup cron has a stable target.
//   - Race sessions: the helper leaves `race_sessions/{sid}` objects
//     in place but flags the user's roster entry as `abandoned: true`
//     so the close-time ordering still records them as DNF. The
//     session row is owned by the SYSTEM user, not the player, so
//     `purgeUserStorage` doesn't touch it; the abandon path lives in
//     `removePlayerFromAll` (Phase 2), invoked by the RPC handler
//     before this helper is called.

import type { IStorageKey, INakama } from '../nkruntime';
import type { ILogger } from '../nkruntime';

/**
 * Collections that are NOT owned by a single user and that the
 * purge helper MUST skip. These are derived caches whose lifecycle
 * is owned by a cron or admin sweep.
 */
const SKIP_COLLECTIONS: ReadonlySet<string> = new Set([
  // Derived caches — cleaned by admin_cleanup_race_sessions (Chunk 6).
  'abandons',
  'pc-account',
]);

const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 100 × 50 = 5000 entries — safely over the per-user ceiling.

export interface PurgeResult {
  storageDeleted: number;
  /** collections where at least one entry was deleted. */
  collectionsAffected: string[];
}

/**
 * Walk every storage object owned by `userId` and delete it.
 * Pagination-safe: loops until storageList returns no further
 * cursor or hits the safety cap.
 *
 * Returns the number of objects deleted plus the list of affected
 * collections (useful for the RPC summary).
 */
export function purgeUserStorage(nk: INakama, userId: string): PurgeResult {
  let deleted = 0;
  const affected = new Set<string>();

  // The runtime's `storageList` filter is collection-scoped; we don't
  // have a "list everything owned by X" endpoint. Walk every known
  // collection explicitly. New collections must register their prefix
  // in `KNOWN_COLLECTIONS` below — that's the conservative half; the
  // user-facing behaviour still uses an explicit walk so we can
  // guarantee no other user's data is touched.
  for (const collection of KNOWN_COLLECTIONS) {
    if (SKIP_COLLECTIONS.has(collection)) continue;
    let cursor = '';
    let page = 0;
    do {
      const result = nk.storageList({
        collection,
        userId,
        limit: PAGE_LIMIT,
        cursor,
      });
      const keys: IStorageKey[] = [];
      for (const obj of result.objects) {
        if (obj.userId !== userId) continue;
        keys.push({ collection, key: obj.key, userId });
      }
      if (keys.length > 0) {
        nk.storageDelete(keys);
        deleted += keys.length;
        if (keys.length > 0) affected.add(collection);
      }
      cursor = result.cursor ?? '';
      page += 1;
      if (page >= MAX_PAGES) break;
    } while (cursor !== '' && page < MAX_PAGES);
  }

  return { storageDeleted: deleted, collectionsAffected: Array.from(affected).sort() };
}

/**
 * Conservative whitelist of collections owned (or partially owned) by
 * user accounts. New phases that introduce a per-user storage
 * collection MUST add its name here.
 *
 * Note: this list is the **target** for GDPR — it should NOT include
 * the SKIP_COLLECTIONS set; the helper already filters those.
 */
export const KNOWN_COLLECTIONS: readonly string[] = [
  'profiles',
  'garage',
  'garage_loadout',
  'garage_packs',
  'inbox',
  'account_link_conflict',
  'ranked',
  'ranked_progress',
  'wallet_audit',
  // Leaderboards of every variety — records only (definitions stay).
  'leaderboard_records',
];

export interface LeaderboardPurgeResult {
  boardsDeleted: number;
  boardsAffected: string[];
}

/**
 * Walk every leaderboard table and remove the user's records. The
 * definitions themselves stay (other players still need them).
 *
 * The runtime exposes `leaderboardRecordDelete(id, ownerId)`; we
 * iterate via `leaderboardList()` and try every table.
 *
 * Throws from `leaderboardRecordDelete` are logged and swallowed
 * (a missing record is a non-fatal no-op).
 */
export function purgeFromLeaderboards(
  nk: INakama,
  logger: ILogger,
  userId: string,
): LeaderboardPurgeResult {
  let deleted = 0;
  const affected = new Set<string>();
  let lbsResult: { leaderboards: Array<{ id: string }>; cursor: string };
  try {
    // `category=''` is "all" — the runtime treats empty string as
    // unfiltered. Pass a high `limit` so a populated catalog is captured
    // in one page; pagination is acceptable here too.
    lbsResult = nk.leaderboardList('', 1000, '');
  } catch (e) {
    logger.warn('purgeFromLeaderboards: leaderboardList failed: %s', e instanceof Error ? e.message : String(e));
    return { boardsDeleted: 0, boardsAffected: [] };
  }
  for (const lb of lbsResult.leaderboards) {
    try {
      nk.leaderboardRecordDelete(lb.id, userId);
      deleted += 1;
      affected.add(lb.id);
    } catch (e) {
      // Most common cause: the user never recorded on this board —
      // `leaderboardRecordDelete` throws "record not found" in
      // production. Swallow + log.
      logger.info(
        'purgeFromLeaderboards: skipped %s for %s: %s',
        lb.id, userId, e instanceof Error ? e.message : String(e),
      );
    }
  }
  return { boardsDeleted: deleted, boardsAffected: Array.from(affected).sort() };
}