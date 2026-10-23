// Club membership storage (plan T-21; audit 07 f1, PC-13).
//
// Storage layout:
//   clubs_members/current/{userId}   — the player's ONE membership row
//                                       (owner = userId, read 1, write 0).
//                                       `value.clubId` names the club.
//
// A fixed key makes "one club per player" a storage invariant: the row
// is created with version '*' (must not exist), so two concurrent joins
// cannot both land. Reading it is also the O(1) "which club am I in"
// lookup the chat, the club-week subscriber and the join gate use.
//
// The roster of a club is enumerated through the Nakama group
// (`groupUsersList`, cursor-paged by the runtime) and joined with these
// rows: the group is the member list and the capacity guard
// (`groupUsersAdd` enforces `maxCount` in its transaction); the row is
// the authoritative role and weekly contribution. A group member
// without a matching row is not a member.

import type { IMultiUpdateResult, INakama, IStorageObject } from '../nkruntime';
import { type Role, type MemberRecord } from './types';

export const CLUBS_MEMBERS_COLLECTION = 'clubs_members';

/** Key of the single membership row of each player. */
export const CLUB_MEMBER_KEY = 'current';

/** Maximum club roster size (mirrors CLUB_MAX_MEMBERS in types.ts). */
export const MAX_MEMBERS_PER_CLUB = 30;

/** CAS retry cap, matching the rest of the codebase. */
export const MAX_CAS_RETRIES = 3;

/** Group states that count as members (superadmin, admin, member). */
const MEMBER_STATES: ReadonlySet<number> = new Set([0, 1, 2]);

export interface MemberReadResult {
  record: MemberRecord;
  version: string;
}

function parseMember(value: unknown): MemberRecord | null {
  const v = value as Partial<MemberRecord> | null;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.clubId !== 'string' || typeof v.userId !== 'string' ||
    typeof v.role !== 'string' ||
    typeof v.joinedAt !== 'number' || typeof v.weeklyContribution !== 'number'
  ) {
    return null;
  }
  return v as MemberRecord;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The player's membership row, whatever the club. `null` when in no club. */
export function readMembership(nk: INakama, userId: string): MemberReadResult | null {
  const obj = nk.storageRead([{ collection: CLUBS_MEMBERS_COLLECTION, key: CLUB_MEMBER_KEY, userId }])[0];
  if (!obj) return null;
  const record = parseMember(obj.value);
  return record === null ? null : { record, version: obj.version ?? '' };
}

/** The player's membership row in `clubId`; `null` when not a member of it. */
export function readMember(
  nk: INakama,
  clubId: string,
  userId: string,
): MemberReadResult | null {
  const m = readMembership(nk, userId);
  return m !== null && m.record.clubId === clubId ? m : null;
}

/** User ids of the group's members, every page of the runtime cursor. */
export function listGroupMemberIds(nk: INakama, clubId: string): string[] {
  const ids: string[] = [];
  let cursor: string | null = null;
  // The roster is capped (30), so this is one page in practice; the loop
  // keeps it correct if the cap grows.
  for (let page = 0; page < 100; page++) {
    const res = nk.groupUsersList(clubId, 100, null, cursor);
    for (const gu of res.groupUsers ?? []) {
      if (MEMBER_STATES.has(gu.state) && typeof gu.user?.userId === 'string') ids.push(gu.user.userId);
    }
    cursor = res.cursor ?? null;
    if (cursor === null || cursor === '') break;
  }
  return ids;
}

/**
 * Every member of a club: the group roster joined with the membership
 * rows (one batched read). Missing or foreign rows are skipped.
 */
export function readClubMembers(
  nk: INakama,
  clubId: string,
): MemberReadResult[] {
  let ids: string[];
  try {
    ids = listGroupMemberIds(nk, clubId);
  } catch {
    return [];
  }
  if (ids.length === 0) return [];
  const objs = nk.storageRead(ids.map((userId) => ({ collection: CLUBS_MEMBERS_COLLECTION, key: CLUB_MEMBER_KEY, userId })));
  const out: MemberReadResult[] = [];
  for (const o of objs) {
    const record = parseMember(o.value);
    if (record === null || record.clubId !== clubId) continue;
    out.push({ record, version: o.version ?? '' });
  }
  return out;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Storage object of a membership row (`version` '*' = must not exist yet). */
export function memberWrite(rec: MemberRecord, version: string): IStorageObject {
  return {
    collection: CLUBS_MEMBERS_COLLECTION,
    key: CLUB_MEMBER_KEY,
    userId: rec.userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version,
  };
}

/**
 * Create a membership row. Throws when the player already has one (in
 * this or another club): the one-club rule.
 */
export function writeMemberCreate(
  nk: INakama,
  rec: MemberRecord,
): string {
  const objs = nk.storageWrite([memberWrite(rec, '*')]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * CAS update. Caller MUST pass the version returned by the prior read.
 */
export function writeMemberUpdate(
  nk: INakama,
  rec: MemberRecord,
  version: string,
): string {
  const objs = nk.storageWrite([memberWrite(rec, version)]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Delete a membership row. With `version` the delete only applies to the
 * row that was read (a row of a club joined since is left alone).
 */
export function deleteMember(
  nk: INakama,
  userId: string,
  version?: string,
): void {
  nk.storageDelete([{
    collection: CLUBS_MEMBERS_COLLECTION,
    key: CLUB_MEMBER_KEY,
    userId,
    ...(version !== undefined && version !== '' ? { version } : {}),
  }]);
}

/**
 * Atomic batch — used for the leader-transfer path: demote current
 * leader to admin + promote target to leader + bump metadata.leaderId
 * in one `multiUpdate` (positional 3.27 shape: accounts, storage writes,
 * storage deletes, wallets, updateLedger).
 */
export function multiUpdateMembers(
  nk: INakama,
  writes: IStorageObject[],
): IMultiUpdateResult {
  return nk.multiUpdate(undefined, writes, undefined, undefined, undefined);
}

// ─── Usernames ──────────────────────────────────────────────────────────────

/**
 * Resolve a member's username from the Nakama user table. Returns
 * 'unknown' when the account is gone.
 */
export function resolveUsername(
  nk: INakama,
  userId: string,
  cachedNames: Map<string, string>,
): string {
  const cached = cachedNames.get(userId);
  if (cached !== undefined) return cached;
  try {
    const users = nk.usersGetId([userId]) as Array<{ username?: string }>;
    const username = users[0]?.username ?? 'unknown';
    cachedNames.set(userId, username);
    return username;
  } catch {
    return 'unknown';
  }
}

export type { Role, MemberRecord };
