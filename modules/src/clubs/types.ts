// Phase 7 Chunk 3 — Clubs types.
//
// Clubs are server-authoritative groups (Nakama 3.27 `nk.groupCreate`)
// with two storage layers:
//
//   1. Nakama group  (built-in)  — holds name, lang, open, maxCount,
//                                  memberList. Stored in Nakama's group
//                                  table; we never write to it directly
//                                  outside of `groupCreate` / `groupUpdate`.
//   2. clubs_metadata/{clubId}    — holds motto, emblemId, region,
//                                  minDivision, weeklyPoints, leaderId.
//                                  The Nakama group `groupId` doubles
//                                  as our `clubId` (server-owned).
//
// Members (the third axis) are tracked inside the group + verified via
// `nk.groupUsersList(groupId, ...)`. We do NOT mirror memberships in
// storage in Chunk 3; Chunk 4 will add per-member role rows.
//
// Decisions locked (peer spec):
//   D1 club_create cost = 5000 coins (configurable via liveops)
//   D2 min level to create = 8
//   D3 min division = bronce
//   D4 max members = 30
//   D5 emblems = catalog emblemas.json (~20)
//   D6 leaderId = creator (set via groupUsersAdd)
//   D7 motto length = 3..24 chars (placeholder blocked words list;
//       real moderation lands in Chunk 5/6)
//   D8 name length = 3..32 chars + uniqueness via groupsList scan
//   D9 before_join hook wires clubs/{clubId}.minLevel + minDivision +
//       block check (Phase 7 Chunk 2 helper)
//   D10 lifetime rate limit: 1 club_create per user (storage counter
//       `clubs_created/{userId}`)

import type { IStorageObject } from '../nkruntime';

export const CLUBS_METADATA_COLLECTION = 'clubs_metadata';
export const CLUBS_CREATED_COLLECTION = 'clubs_created';

export const CLUB_DEFAULT_CREATE_COST_COINS = 5000;
export const CLUB_MIN_LEVEL_TO_CREATE = 8;
export const CLUB_DEFAULT_MIN_DIVISION = 'bronce';
export const CLUB_MAX_MEMBERS = 30;

export const CLUB_NAME_MIN_LEN = 3;
export const CLUB_NAME_MAX_LEN = 32;
export const CLUB_MOTTO_MIN_LEN = 3;
export const CLUB_MOTTO_MAX_LEN = 24;

/**
 * Per-club metadata (stored alongside Nakama group).
 *
 * `leaderId` is captured at create time AND kept in sync on Chunk 4's
 * promote/demote RPCs. The Nakama group `creatorUserId` is the original
 * creator and is NOT updated.
 */
export interface ClubMetadata {
  schemaVersion: 1;
  clubId: string;
  leaderId: string;
  motto: string;
  emblemId: string;
  region: string;
  /** Default 'bronce' for new clubs; never lower. */
  minDivision: string;
  /** Cumulative weekly points (resets via weekly cron in Chunk 5). */
  weeklyPoints: number;
  /** Epoch-ms of creation. */
  createdAt: number;
}

/** Lifetime counter: 1 row per user who has created a club. */
export interface ClubCreatedRecord {
  schemaVersion: 1;
  userId: string;
  clubId: string;
  createdAt: number;
}

/**
 * Club role hierarchy (Chunk 4). Stored on every member row at
 * `clubs_members/{clubId}/{userId}.role`. The Nakama group table has
 * no role primitive, so this layer is authoritative.
 */
export type Role = 'leader' | 'admin' | 'member';

/**
 * Per-member row. Server-owned Read=1 / Write=1. The leader row is
 * updated atomically with the metadata row's `leaderId` field when a
 * transfer happens (see `roles.applyTransfer`).
 */
export interface MemberRecord {
  schemaVersion: 1;
  clubId: string;
  userId: string;
  role: Role;
  /** UTC epoch-ms when this member joined. */
  joinedAt: number;
  /** Per-week contribution (resets via Chunk 5 weekly cron). */
  weeklyContribution: number;
}

/** Emblem catalog row. */
export interface EmblemDef {
  id: string;
  name: string;
  imageUrl: string;
}

/** Shape returned by `club_get`. */
export interface ClubView {
  clubId: string;
  name: string;
  motto: string;
  emblemId: string;
  region: string;
  minDivision: string;
  leaderId: string;
  memberCount: number;
  maxMembers: number;
  weeklyPoints: number;
  createdAt: number;
  open: boolean;
}

export interface ClubMemberView {
  userId: string;
  /** Always true on thin admin-state read; Chunk 4 will surface roles. */
  isLeader: boolean;
  /** Display name from the user account; 'unknown' when not found. */
  username: string;
}

export interface ClubGetOutput {
  club: ClubView;
  members: ClubMemberView[];
  weeklyRank: number | null;
}

export interface ClubSearchOutput {
  clubs: ClubView[];
  nextCursor: string;
}

/** Card shape for `club_create` output. */
export interface ClubCreateOutput {
  clubId: string;
  name: string;
  costPaid: number;
  newBalance: number;
}

// ─── Chunk 4 output shapes ──────────────────────────────────────────────────

/** `club_update` returns just the id + the moment the write committed. */
export interface ClubUpdateOutput {
  clubId: string;
  updatedAt: number;
}

/** One row of `club_members_list` output. */
export interface ClubMemberViewV2 {
  userId: string;
  username: string;
  /** Avatar URL from the user account; null when unset. */
  avatarUrl: string | null;
  /** Authoritative role from storage (NOT from the Nakama group state). */
  role: Role;
  /** Best-effort level — read from `profiles/{userId}` if cached. */
  level: number | null;
  weeklyContribution: number;
  joinedAt: number;
}

export interface ClubMembersListOutput {
  members: ClubMemberViewV2[];
  nextCursor: string;
}

export interface ClubKickOutput {
  removed: boolean;
  clubId: string;
  targetUserId: string;
}

export interface ClubPromoteOutput {
  clubId: string;
  userId: string;
  role: Role;
}

export interface ClubDemoteOutput {
  clubId: string;
  userId: string;
  role: Role;
}

export interface ClubLeaveOutput {
  left: boolean;
  clubId: string;
  userId: string;
}

export function asClubMetadataWrite(rec: ClubMetadata): IStorageObject {
  return {
    collection: CLUBS_METADATA_COLLECTION,
    key: rec.clubId,
    userId: rec.leaderId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 2, // public
    permissionWrite: 1, // server-owned write
  };
}

export function asClubCreatedWrite(rec: ClubCreatedRecord): IStorageObject {
  return {
    collection: CLUBS_CREATED_COLLECTION,
    key: rec.userId,
    userId: rec.userId,
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}