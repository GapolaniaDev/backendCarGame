// Phase 7 Chunk 8 — Party types + storage helpers.
//
// Parties are pre-race rosters: a small (≤6) group of friends who
// queue into the matchmaker as a unit. The 3.27 JS runtime has NO
// party API (verified at `nkruntime.d.ts`), so we implement parties
// as plain storage rows — same workaround used for clubs in Chunk 3.
//
// Storage layout:
//   parties/{partyId}              — one row per party (server-owned
//                                    Read=1 Write=1 so the creator can
//                                    read+update; the runtime's
//                                    "owner-can-write" model gives us
//                                    a clean concurrency story).
//   active_party/{userId}          — inverse index: user → partyId.
//                                    Lazily updated on join/leave.
//
// Decision locked (D1-D3):
//   D1: max party size = 6 (roster limits)
//   D2: party leader = creator; transfer NOT in this chunk
//   D3: state machine 'open' | 'closed' — matchmaker can stamp 'closed'
//        when a party ticket matches; manual close is a future chunk.

import type { IStorageObject } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';

export const PARTY_MAX_SIZE = 6;
export const PARTY_DEFAULT_SIZE = 4;
export const VALID_PARTY_SIZES: ReadonlyArray<2 | 4 | 6> = [2, 4, 6];

export const PARTY_STATE_OPEN = 'open' as const;
export const PARTY_STATE_CLOSED = 'closed' as const;
export type PartyState = 'open' | 'closed';

export const PARTIES_COLLECTION = 'parties';
export const ACTIVE_PARTY_COLLECTION = 'active_party';

// ─── Records ────────────────────────────────────────────────────────────────

export interface PartyMember {
  userId: string;
  /** Epoch-ms when the member joined the party. */
  joinedAt: number;
}

export interface PartyRecord {
  schemaVersion: 1;
  partyId: string;
  leaderUserId: string;
  maxSize: 2 | 4 | 6;
  state: PartyState;
  createdAt: number;
  members: PartyMember[];
}

/**
 * Inverse index: userId → partyId. Lets us find "what party is this
 * user in?" without scanning `parties`. Server-owned, since the
 * canonical mapping is server-managed.
 */
export interface ActivePartyRecord {
  schemaVersion: 1;
  userId: string;
  partyId: string;
  joinedAt: number;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

export interface PartyMemberCard {
  userId: string;
  joinedAt: number;
}

export interface PartyCard {
  partyId: string;
  leaderUserId: string;
  maxSize: 2 | 4 | 6;
  state: PartyState;
  createdAt: number;
  members: PartyMemberCard[];
}

// ─── Storage write helpers ──────────────────────────────────────────────────

export function asPartyWrite(rec: PartyRecord): IStorageObject {
  return {
    collection: PARTIES_COLLECTION,
    key: rec.partyId,
    userId: SYSTEM_USER_ID, // system-owned
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}

export function asActivePartyWrite(rec: ActivePartyRecord): IStorageObject {
  return {
    collection: ACTIVE_PARTY_COLLECTION,
    key: rec.userId,
    userId: rec.userId, // owner-scoped so storageRead(userId=user) works
    value: rec as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 1,
  };
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

export function isValidPartySize(n: unknown): n is 2 | 4 | 6 {
  return n === 2 || n === 4 || n === 6;
}

/**
 * Pure: can `userId` join the party given current roster + max size?
 * Excludes the case where the user is already a member.
 */
export function canAddMember(party: PartyRecord, userId: string): boolean {
  if (party.state !== PARTY_STATE_OPEN) return false;
  if (party.members.length >= party.maxSize) return false;
  if (party.members.some((m) => m.userId === userId)) return false;
  return true;
}

/**
 * Pure: does the party's roster already contain `userId`?
 */
export function hasMember(party: PartyRecord, userId: string): boolean {
  return party.members.some((m) => m.userId === userId);
}

/**
 * Pure: produce a new party with `userId` appended.
 */
export function withAddedMember(party: PartyRecord, userId: string, nowMs: number): PartyRecord {
  if (hasMember(party, userId)) return party;
  return {
    ...party,
    members: [...party.members, { userId, joinedAt: nowMs }],
  };
}

/**
 * Pure: produce a new party without `userId`.
 */
export function withoutMember(party: PartyRecord, userId: string): PartyRecord {
  return {
    ...party,
    members: party.members.filter((m) => m.userId !== userId),
  };
}

/**
 * Pure: produce the public card from the stored record.
 */
export function asPartyCard(party: PartyRecord): PartyCard {
  return {
    partyId: party.partyId,
    leaderUserId: party.leaderUserId,
    maxSize: party.maxSize,
    state: party.state,
    createdAt: party.createdAt,
    members: party.members.map((m) => ({ userId: m.userId, joinedAt: m.joinedAt })),
  };
}