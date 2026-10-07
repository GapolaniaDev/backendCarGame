// Phase 7 Chunk 1 — Social storage helpers.
//
// Three server-owned collections:
//   - `friends_code` (key=`userId`, owner=`userId`) — permanent
//     per-user code.
//   - `friends_edge` (key=`friendId`, owner=`userId`) — mutual
//     friendship from `userId`'s perspective. Each friendship is two
//     rows (one per side).
//   - `recent_rivals` (key=`userId`, owner=`userId`) — LRU list of
//     opponents raced in the last 30 days, capped at 20.
//
// All helpers are pure functions that take `INakama` and a `userId` /
// record and surface storage. CAS retries live in `friends_repo.ts` for
// the friend-add/remove cycle and in `recent_rivals.ts` for the subscriber.
//
// Storage keys:
//   friends_code/{userId}
//   friends_edge/{friendId}        ← per side
//   recent_rivals/{userId}
//
// The friends_edge collection is queried two ways:
//   1. `storageList({collection, userId})` — list my friends.
//   2. `storageRead([{collection, key:friendId, userId}])` — does the
//      edge already exist before friend_add_by_code? (CONFLICT check)

import type { IStorageKey, IStorageObject, INakama } from '../nkruntime';
import {
  asFriendCodeWrite,
  asFriendEdgeWrite,
  asRecentRivalsWrite,
  type FriendCodeRecord,
  type FriendEdgeRecord,
  type RecentRivalsRecord,
  FRIENDS_CODE_COLLECTION,
  FRIENDS_EDGE_COLLECTION,
  RECENT_RIVALS_COLLECTION,
} from './types';

export const MAX_CAS_RETRIES = 3;

// ─── Friend code ───────────────────────────────────────────────────────────

/**
 * Read a user's permanent friend-code row. Returns `null` when absent.
 */
export function readFriendCode(
  nk: INakama,
  userId: string,
): { record: FriendCodeRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: FRIENDS_CODE_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<FriendCodeRecord>;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  return { record: value as FriendCodeRecord, version: obj.version ?? '' };
}

/**
 * Create a friend-code row. Caller must have checked absence first.
 */
export function writeFriendCode(
  nk: INakama,
  record: FriendCodeRecord,
): string {
  const obj: IStorageObject = asFriendCodeWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

// ─── Friend edges ──────────────────────────────────────────────────────────

/**
 * Read ONE side of a mutual friendship. `ownerId` is the user listing
 * the edge (storage row owner); `friendId` is the OTHER side and the
 * storage key.
 */
export function readFriendEdge(
  nk: INakama,
  ownerId: string,
  friendId: string,
): { record: FriendEdgeRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: FRIENDS_EDGE_COLLECTION, key: friendId, userId: ownerId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<FriendEdgeRecord>;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    typeof value.friendId !== 'string' ||
    typeof value.friendCode !== 'string' ||
    typeof value.since !== 'number'
  ) {
    return null;
  }
  return { record: value as FriendEdgeRecord, version: obj.version ?? '' };
}

/**
 * List every friendship edge owned by `userId`. Returns the raw records
 * (no version) — used by `friend_list_get`.
 */
export function listFriendEdges(
  nk: INakama,
  userId: string,
): FriendEdgeRecord[] {
  const res = nk.storageList({
    collection: FRIENDS_EDGE_COLLECTION,
    userId,
    limit: 200,
  });
  const out: FriendEdgeRecord[] = [];
  for (const obj of res.objects) {
    const v = obj.value as Partial<FriendEdgeRecord>;
    if (
      v &&
      typeof v === 'object' &&
      v.schemaVersion === 1 &&
      typeof v.userId === 'string' &&
      typeof v.friendId === 'string' &&
      typeof v.friendCode === 'string' &&
      typeof v.since === 'number'
    ) {
      out.push(v as FriendEdgeRecord);
    }
  }
  return out;
}

/**
 * Create (insert-if-absent) a single edge row. Does NOT CAS — the
 * `friend_add_by_code` RPC first checks via `read` and rejects with
 * CONFLICT when it already exists. (We don't try-cas-create because a
 * CONFLICT on first-write would be confusingly indistinguishable from
 * "someone added me faster".)
 */
export function writeFriendEdgeCreate(
  nk: INakama,
  record: FriendEdgeRecord,
): string {
  const obj: IStorageObject = asFriendEdgeWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Delete an edge row by composite key. Used by `friend_remove`.
 */
export function deleteFriendEdge(
  nk: INakama,
  ownerId: string,
  friendId: string,
): void {
  const keys: IStorageKey[] = [
    { collection: FRIENDS_EDGE_COLLECTION, key: friendId, userId: ownerId },
  ];
  nk.storageDelete(keys);
}

// ─── Recent rivals ─────────────────────────────────────────────────────────────────

/**
 * Read a user's recent-rivals row. Returns `null` when absent (lazy
 * creation lives in `subscribeRecentRivals`).
 */
export function readRecentRivals(
  nk: INakama,
  userId: string,
): { record: RecentRivalsRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: RECENT_RIVALS_COLLECTION, key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<RecentRivalsRecord>;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  return { record: value as RecentRivalsRecord, version: obj.version ?? '' };
}

/**
 * Create the initial (empty) recent-rivals row.
 */
export function writeRecentRivalsCreate(
  nk: INakama,
  record: RecentRivalsRecord,
): string {
  const obj: IStorageObject = asRecentRivalsWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * CAS-update an existing recent-rivals row. Caller owns `version`.
 */
export function writeRecentRivalsUpdate(
  nk: INakama,
  record: RecentRivalsRecord,
  version: string,
): string {
  const obj: IStorageObject = asRecentRivalsWrite(record);
  // Storage write needs `version` for CAS — extend the IStorageObject.
  const casObj: IStorageObject = { ...obj, version };
  const acks = nk.storageWrite([casObj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

// ─── friend-code lookup by code ────────────────────────────────────────────

/**
 * Resolve a pasted code to the user who owns it. Iterates the
 * `friends_code` collection. Production-scale (10⁴-10⁵ players) makes
 * this scan sub-ms in practice. Returns `null` when no row matches.
 */
export function lookupUserByCode(
  nk: INakama,
  code: string,
): { record: FriendCodeRecord } | null {
  const res = nk.storageList({
    collection: FRIENDS_CODE_COLLECTION,
    limit: 1000,
  });
  for (const obj of res.objects) {
    const v = obj.value as Partial<FriendCodeRecord>;
    if (v && typeof v === 'object' && v.code === code && typeof v.userId === 'string') {
      return { record: v as FriendCodeRecord };
    }
  }
  return null;
}