// Account purge (plan T-16, audit 06 f13).
//
// `purgeUserStorage` walks every collection of the central registry
// (`core/collections.ts`): it deletes the objects the user owns, then
// applies each collection's rules for objects that name the user without
// being owned by them (system rows keyed by the user id, friends' mirror
// edges, invites the user sent, leaderboard snapshots…).
//
// `purgeFromLeaderboards` removes the user's record from every Nakama
// leaderboard (3.27: `leaderboardList(limit 1-100, cursor)`).
//
// `nk.accountDeleteId` (called after both) also cascades in Postgres:
// owned storage, friends (`user_edge`), wallet ledger, notifications,
// leaderboard records and group memberships. The explicit purge covers
// what the cascade cannot see and makes the summary exact.

import type { ILogger, INakama, IStorageKey, IStorageObject } from '../nkruntime';
import { COLLECTIONS, type CollectionSpec, type PurgeRule } from '../core/collections';
import { listStorage } from '../core/storage';
import { SYSTEM_USER_ID } from '../race/constants';

const PAGE_LIMIT = 100;
/** Owned objects: 100 × 50 = 5000 per collection, over the per-user ceiling. */
const MAX_OWNER_PAGES = 50;
/** Scans of other owners' objects: 100 × 200 = 20 000 per collection. */
const MAX_SCAN_PAGES = 200;

export interface PurgeResult {
  /** Objects owned by the user, or keyed by them, that were deleted. */
  storageDeleted: number;
  /** Collections where at least one object was deleted or rewritten. */
  collectionsAffected: string[];
  /** Objects of other owners deleted or rewritten because they named the user. */
  referencesRemoved: number;
}

export function purgeUserStorage(
  nk: INakama,
  logger: ILogger,
  userId: string,
  registry: readonly CollectionSpec[] = COLLECTIONS,
): PurgeResult {
  let storageDeleted = 0;
  let referencesRemoved = 0;
  const affected = new Set<string>();

  for (const spec of registry) {
    const owned = deleteOwned(nk, spec.name, userId);
    storageDeleted += owned;
    let refs = 0;
    for (const rule of spec.purge) {
      const r = applyRule(nk, logger, spec.name, rule, userId);
      storageDeleted += r.keyed;
      refs += r.references;
    }
    referencesRemoved += refs;
    if (owned > 0 || refs > 0) affected.add(spec.name);
  }
  return { storageDeleted, collectionsAffected: Array.from(affected).sort(), referencesRemoved };
}

function deleteOwned(nk: INakama, collection: string, userId: string): number {
  let deleted = 0;
  // Deleting while paging would shift the cursor: list first, then delete.
  const keys: IStorageKey[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_OWNER_PAGES; page++) {
    const res = listStorage(nk, { collection, userId, limit: PAGE_LIMIT, cursor });
    for (const o of res.objects) {
      if (o.userId === userId) keys.push({ collection, key: o.key, userId });
    }
    cursor = res.cursor;
    if (cursor === '') break;
  }
  for (let i = 0; i < keys.length; i += PAGE_LIMIT) {
    const batch = keys.slice(i, i + PAGE_LIMIT);
    nk.storageDelete(batch);
    deleted += batch.length;
  }
  return deleted;
}

/** Every object of `collection` (all owners, or one owner), paged. */
function scan(nk: INakama, collection: string, ownerId?: string): IStorageObject[] {
  const out: IStorageObject[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const res = listStorage(nk, {
      collection,
      ...(ownerId !== undefined ? { userId: ownerId } : {}),
      limit: PAGE_LIMIT,
      cursor,
    });
    out.push(...res.objects);
    cursor = res.cursor;
    if (cursor === '') break;
  }
  return out;
}

function applyRule(
  nk: INakama,
  logger: ILogger,
  collection: string,
  rule: PurgeRule,
  userId: string,
): { keyed: number; references: number } {
  switch (rule.kind) {
    case 'systemKey': {
      const key = rule.key(userId);
      const found = nk.storageRead([{ collection, key, userId: SYSTEM_USER_ID }]);
      if (found.length === 0) return { keyed: 0, references: 0 };
      nk.storageDelete([{ collection, key, userId: SYSTEM_USER_ID }]);
      return { keyed: 1, references: 0 };
    }
    case 'systemKeySuffix': {
      const suffix = rule.suffix(userId);
      const keys = scan(nk, collection, SYSTEM_USER_ID)
        .filter((o) => o.key.endsWith(suffix))
        .map((o) => ({ collection, key: o.key, userId: SYSTEM_USER_ID }));
      deleteKeys(nk, keys);
      return { keyed: keys.length, references: 0 };
    }
    case 'keyIsUser': {
      const keys = scan(nk, collection)
        .filter((o) => o.key === userId && o.userId !== userId)
        .map((o) => ({ collection, key: o.key, userId: o.userId ?? '' }));
      deleteKeys(nk, keys);
      return { keyed: 0, references: keys.length };
    }
    case 'valueField': {
      const keys = scan(nk, collection)
        .filter((o) => o.userId !== userId && (o.value as Record<string, unknown> | undefined)?.[rule.field] === userId)
        .map((o) => ({ collection, key: o.key, userId: o.userId ?? '' }));
      deleteKeys(nk, keys);
      return { keyed: 0, references: keys.length };
    }
    case 'entries': {
      let rewritten = 0;
      for (const o of scan(nk, collection)) {
        if (o.userId === userId) continue;
        const value = o.value as Record<string, unknown> | undefined;
        const list = value?.[rule.field];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((e) => (e as { userId?: unknown } | null)?.userId !== userId);
        if (kept.length === list.length) continue;
        try {
          nk.storageWrite([{
            collection,
            key: o.key,
            userId: o.userId ?? '',
            value: { ...value, [rule.field]: kept },
            permissionRead: o.permissionRead ?? 0,
            permissionWrite: o.permissionWrite ?? 0,
            ...(o.version !== undefined ? { version: o.version } : {}),
          }]);
          rewritten += 1;
        } catch (e) {
          // A concurrent writer won the CAS; its next write keeps the entry
          // only if it re-adds the user, which a deleted account cannot do.
          logger.warn(
            'account purge: %s/%s entries rewrite lost its CAS: %s',
            collection, o.key, e instanceof Error ? e.message : String(e),
          );
        }
      }
      return { keyed: 0, references: rewritten };
    }
  }
}

function deleteKeys(nk: INakama, keys: IStorageKey[]): void {
  for (let i = 0; i < keys.length; i += PAGE_LIMIT) {
    nk.storageDelete(keys.slice(i, i + PAGE_LIMIT));
  }
}

// ─── Leaderboards ────────────────────────────────────────────────────────────

export interface LeaderboardPurgeResult {
  boardsDeleted: number;
  boardsAffected: string[];
}

/**
 * Remove the user's record from every leaderboard (definitions stay).
 * Only boards that hold a record are touched, so the count is exact.
 */
export function purgeFromLeaderboards(
  nk: INakama,
  logger: ILogger,
  userId: string,
): LeaderboardPurgeResult {
  const affected: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_OWNER_PAGES; page++) {
    let res: { leaderboards: Array<{ id: string }>; cursor?: string | null };
    try {
      res = nk.leaderboardList(PAGE_LIMIT, cursor);
    } catch (e) {
      logger.error('account purge: leaderboardList failed: %s', e instanceof Error ? e.message : String(e));
      break;
    }
    for (const lb of res.leaderboards ?? []) {
      try {
        const owned = nk.leaderboardRecordsList(lb.id, [userId], 0);
        if ((owned.ownerRecords ?? []).length === 0) continue;
        nk.leaderboardRecordDelete(lb.id, userId);
        affected.push(lb.id);
      } catch (e) {
        logger.warn(
          'account purge: leaderboard %s for %s: %s',
          lb.id, userId, e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (typeof res.cursor !== 'string' || res.cursor.length === 0) break;
    cursor = res.cursor;
  }
  affected.sort();
  return { boardsDeleted: affected.length, boardsAffected: affected };
}
