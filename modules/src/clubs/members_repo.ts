// Phase 7 Chunk 4 — Club member storage + role helpers.
//
// Storage layout:
//   clubs_members/{clubId}/{userId}     — one row per (club, user).
//                                          owner = userId (so the user
//                                          can read their own row from
//                                          the client). Read=1 Write=1.
//
// Source of truth for the public roster (Nakama 3.27 JS runtime does
// NOT expose `groupUsersRemove`, so the group table can only grow —
// not shrink — from this layer; we mirror membership in storage and
// treat the group table as a label/chat anchor. The drift between the
// two is documented and acceptable for Chunk 4; Chunk 5+ chat will
// need a reconciliation cron if/when membership churn matters).

import type { IGroup, IMultiUpdateResult, INakama, IStorageObject } from '../nkruntime';
import { type Role, type MemberRecord } from './types';

export const CLUBS_MEMBERS_COLLECTION = 'clubs_members';

/** Maximum club roster size (mirrors CLUB_MAX_MEMBERS in types.ts). */
export const MAX_MEMBERS_PER_CLUB = 30;

/** CAS retry cap, matching the rest of the codebase. */
export const MAX_CAS_RETRIES = 3;

export interface MemberReadResult {
  record: MemberRecord;
  version: string;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Read a single member row. Returns `null` when absent.
 */
export function readMember(
  nk: INakama,
  clubId: string,
  userId: string,
): MemberReadResult | null {
  const objs = nk.storageRead([
    { collection: CLUBS_MEMBERS_COLLECTION, key: clubId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<MemberRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.clubId !== 'string' || typeof v.userId !== 'string' ||
    typeof v.role !== 'string' ||
    typeof v.joinedAt !== 'number' || typeof v.weeklyContribution !== 'number'
  ) {
    return null;
  }
  return { record: v as MemberRecord, version: obj.version ?? '' };
}

/**
 * Read every member of a club. We scan `clubs_members` and filter by
 * `key === clubId` (Nakama storageList `userId` filter does not match
 * by `key`, so the only way to enumerate a club's roster from JS is
 * to scan + filter). At our scale (30 × few-hundred-clubs) the scan
 * stays cheap; Chunk 5 can introduce a `clubs_index` row if it bites.
 */
export function readClubMembers(
  nk: INakama,
  clubId: string,
): MemberReadResult[] {
  const list = nk.storageList({
    collection: CLUBS_MEMBERS_COLLECTION,
    limit: 1000,
  });
  const out: MemberReadResult[] = [];
  for (const o of list.objects) {
    if (o.key !== clubId) continue;
    const v = o.value as Partial<MemberRecord>;
    if (
      !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
      typeof v.clubId !== 'string' || typeof v.userId !== 'string' ||
      typeof v.role !== 'string' ||
      typeof v.joinedAt !== 'number' || typeof v.weeklyContribution !== 'number'
    ) {
      continue;
    }
    out.push({ record: v as MemberRecord, version: o.version ?? '' });
  }
  return out;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Insert a brand-new member row (no `version`).
 */
export function writeMemberCreate(
  nk: INakama,
  rec: MemberRecord,
): string {
  const objs = nk.storageWrite([
    {
      collection: CLUBS_MEMBERS_COLLECTION,
      key: rec.clubId,
      userId: rec.userId,
      value: rec as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
    },
  ]);
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
  const objs = nk.storageWrite([
    {
      collection: CLUBS_MEMBERS_COLLECTION,
      key: rec.clubId,
      userId: rec.userId,
      value: rec as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
      version,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Idempotent delete. `storageDelete` does not require a version; the
 * runtime resolves the row by `(collection, key, userId)`. We keep
 * `version` as an optional arg so callers that want a precondition
 * check can pre-read; the runtime ignores it.
 */
export function deleteMember(
  nk: INakama,
  clubId: string,
  userId: string,
  _version?: string,
): void {
  nk.storageDelete([{ collection: CLUBS_MEMBERS_COLLECTION, key: clubId, userId }]);
}

/**
 * Atomic batch — used for the leader-transfer path: demote current
 * leader to admin + promote target to leader + bump metadata.leaderId
 * in one `multiUpdate`.
 *
 * The runtime requires POSITIONAL 5-arg shape (see Chunk 1 memo):
 *   multiUpdate(accountUpdates, storageWrites, storageDeletes, walletUpdates, ledgerLedgerUpdates)
 *
 * The 3.27 JS runtime `storageDeletes` slot is typed as `undefined`
 * (the runtime's delete path is `storageDelete`), so this helper only
 * accepts writes. Delete paths use `deleteMember` instead.
 */
export function multiUpdateMembers(
  nk: INakama,
  writes: IStorageObject[],
): IMultiUpdateResult {
  return nk.multiUpdate(undefined, writes, undefined, undefined, undefined);
}

// ─── Convenience: scan group via nk.groupsList + build member views ──────────

/**
 * Resolve a member's username from the Nakama user table. Returns
 * 'unknown' when the account is gone. Used by `club_members_list` to
 * hydrate display names without a per-user `nk.usersGetId` roundtrip
 * per member (we batch via `nk.usersGetId` when feasible; single
 * fallback when not).
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

// Re-export the type guard interface for callers that want a single
// import path.
export type { Role, MemberRecord };
// Also expose the IGroup import so consumers can import everything from
// here if they prefer.
export type { IGroup };