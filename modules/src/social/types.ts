// Phase 7 Chunk 1 — Social types.
//
// Friend codes (stable per-user), friend edges (mutual a↔b), and recent
// rivals (LRU per-user, rolling 30 days). All records live in server-owned
// storage with `userId === ownerId` so the JS layer can write them
// without permission checks.
//
// Decisions locked (peer spec):
//   - D1: Friend code = 8 chars upper alphanumeric (A-Z minus O/I/L +
//         digits 2-9 = 31-char alphabet).
//   - D2: Friend code storage = `friends/code/{userId}`, permanent (no TTL).
//   - D3: Recent rivals cap = 20 per user (LRU).
//   - D4: Recent rivals rolling window = 30 days.
//   - D5: Mutual friendship = `friends/{userIdA}/{userIdB}` +
//         `friends/{userIdB}/{userIdA}` (two storage rows).
//   - D6: Self-add → `BAD_REQUEST`.
//   - D7: Code invalid → `NOT_FOUND`.
//   - D8: Already-friend → `CONFLICT`.

import type { IStorageObject } from '../nkruntime';

export const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 31 chars: A-Z minus O/I/L + digits 2-9 (no 0/O/1/I/L confusion). */

export const FRIEND_CODE_LENGTH = 8;
export const RECENT_RIVALS_CAP = 20;
export const RECENT_RIVALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const FRIENDS_CODE_COLLECTION = 'friends_code';
export const FRIENDS_EDGE_COLLECTION = 'friends_edge';
export const RECENT_RIVALS_COLLECTION = 'recent_rivals';

/**
 * Per-user permanent friend code. Keyed only by friends — code lives in
 * `friends_code/{userId}`. Code is **stable** (no rotation); when a
 * user wants a new code they get the same one back from
 * `generateFriendCode(userId, nk)`.
 */
export interface FriendCodeRecord {
  schemaVersion: 1;
  userId: string;
  code: string;
  /** Epoch-ms when first stored (lazy-create via friend_code_get). */
  createdAt: number;
}

export interface FriendCodeInput {
  userId: string;
}

/**
 * Mutual friendship edge. Stored twice — once per side — so the RPC
 * list can pull `storageList({collection:'friends_edge', userId})` and
 * see only that user's perspective. Owner of each row is `userId` (the
 * side that lists it).
 */
export interface FriendEdgeRecord {
  schemaVersion: 1;
  /** The owner of this edge row (= who can list it). */
  userId: string;
  /** The friend's userId (the OTHER side). */
  friendId: string;
  /** Friend's code (for client UX). Snapshot at time of accept. */
  friendCode: string;
  /** Epoch-ms when the friendship was formed. */
  since: number;
}

/**
 * Card shape returned by `friend_list_get`. Friendly view, no schema.
 */
export interface FriendCard {
  friendId: string;
  friendCode: string;
  since: number;
}

/**
 * Single recent-rival entry: a unique opponent the player has raced
 * against in the last 30 days. LRU-ordered by `lastRaceAt`.
 */
export interface RecentRivalEntry {
  userId: string;
  /** Epoch-ms of the most recent shared race. */
  lastRaceAt: number;
  /** Number of races shared with this opponent in the window. */
  raceCount: number;
}

/**
 * Per-user recent-rivals row. `entries` is sorted desc by `lastRaceAt`
 * (most recent first). Capped at `RECENT_RIVALS_CAP` (20). Aged out at
 * 30 days.
 */
export interface RecentRivalsRecord {
  schemaVersion: 1;
  userId: string;
  entries: RecentRivalEntry[];
}

/** Card shape returned by `recent_rivals_get`. */
export interface RecentRivalCard {
  userId: string;
  lastRaceAt: number;
  raceCount: number;
}

/** Output envelopes for the RPCs. */
export interface FriendCodeGetOutput {
  code: string;
  userId: string;
  createdAt: number;
}

export interface FriendAddByCodeOutput {
  friendId: string;
  friendCode: string;
  since: number;
  /** Both sides of the edge are written before this returns. */
  mutual: true;
}

export interface FriendListGetOutput {
  friends: FriendCard[];
  count: number;
}

export interface FriendRemoveOutput {
  removed: true;
  friendId: string;
}

export interface RecentRivalsGetOutput {
  rivals: RecentRivalCard[];
  count: number;
}

/** Storage write helpers — accept the typed record and return ack-shaped object. */
export function asFriendCodeWrite(rec: FriendCodeRecord): IStorageObject {
  return {
    collection: FRIENDS_CODE_COLLECTION,
    key: rec.userId,
    userId: rec.userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}

export function asFriendEdgeWrite(rec: FriendEdgeRecord): IStorageObject {
  return {
    collection: FRIENDS_EDGE_COLLECTION,
    key: rec.friendId,
    userId: rec.userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}

export function asRecentRivalsWrite(rec: RecentRivalsRecord): IStorageObject {
  return {
    collection: RECENT_RIVALS_COLLECTION,
    key: rec.userId,
    userId: rec.userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}