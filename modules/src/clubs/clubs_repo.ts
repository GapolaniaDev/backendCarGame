// Phase 7 Chunk 3 — Clubs storage helpers (read-side).
//
// Storage layout:
//   clubs_metadata/{clubId}    — owner = system user, read 2 (public),
//                                write 0. One row per club, created in
//                                `club_create` in the same transaction as
//                                the charge. System-owned (plan T-21) so a
//                                leader transfer or a deleted leader never
//                                moves or cascades it.
//   clubs_created/{userId}     — owner = userId, read 1, write 0.
//                                Lifetime counter (1 row per user who
//                                has ever created a club).
//
// Join rules (level, division, blocks) live in `checkClubJoinGate`; the
// `club_join` RPC and the native JoinGroup before-hook
// (`groups/before_join.ts`) both apply them.

import type { IGroup, INakama, ILogger, IStorageObject } from '../nkruntime';
import { isBlockedEitherWay } from '../social/blocks_repo';
import {
  type ClubMetadata,
  CLUBS_METADATA_COLLECTION,
  type ClubView,
  type ClubMemberView,
} from './types';
import { readProfile } from '../profiles/storage';
import { getRankedConfig, divisionForRating } from '../ranked/config';
import { readRankedRecord } from '../ranked/ranked_repo';
import { SYSTEM_USER_ID } from '../race/constants';

export const MAX_CAS_RETRIES = 3;

// ─── Read metadata ────────────────────────────────────────────────────────────

function parseClubMetadata(value: unknown): ClubMetadata | null {
  const v = value as Partial<ClubMetadata> | null;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.clubId !== 'string' || typeof v.leaderId !== 'string' ||
    typeof v.motto !== 'string' || typeof v.emblemId !== 'string' ||
    typeof v.region !== 'string' || typeof v.minDivision !== 'string' ||
    typeof v.weeklyPoints !== 'number' || typeof v.createdAt !== 'number'
  ) {
    return null;
  }
  return v as ClubMetadata;
}

/**
 * Read club metadata by `clubId`. Returns `null` when absent or
 * malformed.
 */
export function readClubMetadata(
  nk: INakama,
  clubId: string,
): { record: ClubMetadata; version: string } | null {
  const obj = nk.storageRead([
    { collection: CLUBS_METADATA_COLLECTION, key: clubId, userId: SYSTEM_USER_ID },
  ])[0];
  if (!obj) return null;
  const record = parseClubMetadata(obj.value);
  return record === null ? null : { record, version: obj.version ?? '' };
}

/** Metadata of several clubs in one read, keyed by club id. */
export function readClubMetadataMany(
  nk: INakama,
  clubIds: readonly string[],
): Map<string, { record: ClubMetadata; version: string }> {
  const out = new Map<string, { record: ClubMetadata; version: string }>();
  if (clubIds.length === 0) return out;
  const objs = nk.storageRead(clubIds.map((key) => ({ collection: CLUBS_METADATA_COLLECTION, key, userId: SYSTEM_USER_ID })));
  for (const o of objs) {
    const record = parseClubMetadata(o.value);
    if (record !== null) out.set(record.clubId, { record, version: o.version ?? '' });
  }
  return out;
}

/**
 * Read the lifetime counter for a user. Returns `null` when absent.
 * Used by `club_create` to enforce the 1-per-user lifetime cap.
 */
export function readClubCreated(
  nk: INakama,
  userId: string,
): { record: { schemaVersion: 1; userId: string; clubId: string; createdAt: number }; version: string } | null {
  const objs = nk.storageRead([
    { collection: 'clubs_created', key: userId, userId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<{ schemaVersion: 1; userId: string; clubId: string; createdAt: number }>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.userId !== 'string' || typeof v.clubId !== 'string' ||
    typeof v.createdAt !== 'number'
  ) {
    return null;
  }
  return { record: v as { schemaVersion: 1; userId: string; clubId: string; createdAt: number }, version: obj.version ?? '' };
}

// ─── Write metadata ───────────────────────────────────────────────────────────

/** Storage object of the metadata row (`version` '*' = must not exist yet). */
export function clubMetadataWrite(record: ClubMetadata, version?: string): IStorageObject {
  return {
    collection: CLUBS_METADATA_COLLECTION,
    key: record.clubId,
    userId: SYSTEM_USER_ID,
    value: record as unknown as Record<string, unknown>,
    permissionRead: 2,
    permissionWrite: 0,
    ...(version !== undefined ? { version } : {}),
  };
}

export function writeClubMetadataCreate(
  nk: INakama,
  record: ClubMetadata,
): string {
  const objs = nk.storageWrite([clubMetadataWrite(record, '*')]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeClubMetadataUpdate(
  nk: INakama,
  record: ClubMetadata,
  version: string,
): string {
  const objs = nk.storageWrite([clubMetadataWrite(record, version)]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/** Delete the metadata row (club dissolved). */
export function deleteClubMetadata(nk: INakama, clubId: string): void {
  nk.storageDelete([{ collection: CLUBS_METADATA_COLLECTION, key: clubId, userId: SYSTEM_USER_ID }]);
}

/** Storage object of the lifetime counter row (created once: version '*'). */
export function clubCreatedWrite(
  record: { schemaVersion: 1; userId: string; clubId: string; createdAt: number },
): IStorageObject {
  return {
    collection: 'clubs_created',
    key: record.userId,
    userId: record.userId,
    value: record as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: '*',
  };
}

export function writeClubCreated(
  nk: INakama,
  record: { schemaVersion: 1; userId: string; clubId: string; createdAt: number },
): string {
  const objs = nk.storageWrite([clubCreatedWrite(record)]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/** The Nakama group of a club; `null` when it does not exist. */
export function readClubGroup(
  nk: INakama,
  clubId: string,
): IGroup | null {
  try {
    const groups = nk.groupsGetId([clubId]);
    return groups.find((g) => g.id === clubId) ?? null;
  } catch {
    return null;
  }
}

// ─── Helper: build ClubView from Nakama group + metadata ─────────────────────

/**
 * Compose the public-facing ClubView from a Nakama group + stored
 * metadata. Pure (no storage access).
 */
export function buildClubView(
  group: IGroup,
  meta: ClubMetadata,
  memberCount: number,
): ClubView {
  return {
    clubId: group.id,
    name: group.name,
    motto: meta.motto,
    emblemId: meta.emblemId,
    region: meta.region,
    minDivision: meta.minDivision,
    leaderId: meta.leaderId,
    memberCount,
    maxMembers: group.maxCount,
    weeklyPoints: meta.weeklyPoints,
    createdAt: meta.createdAt,
    open: group.open,
  };
}

/**
 * Resolve a member list from the Nakama group. The stub returns one
 * synthetic member per `(userId, isLeader)` pair — for Chunk 3 the
 * list only contains the leader. Chunk 4 will replace this with a
 * full member scan + role lookup.
 */
export function buildMemberView(
  members: ReadonlyArray<{ userId: string }>,
  leaderId: string,
): ClubMemberView[] {
  const out: ClubMemberView[] = [];
  for (const m of members) {
    out.push({
      userId: m.userId,
      isLeader: m.userId === leaderId,
      username: 'unknown',
    });
  }
  return out;
}

// ─── Helper: before-join gate ─────────────────────────────────────────────────

export interface ClubJoinGateDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Composite gate for `before_join`. Reads:
 *   - club metadata (minLevel/8 + minDivision)
 *   - caller's profile (level)
 *   - ranked config + caller's rating (division compare)
 *   - block check (Chunk 2 helper, symmetric)
 *
 * Defensive: any storage hiccup fails OPEN (allow). Mirrors the
 * chat send stub convention.
 */
export function checkClubJoinGate(
  nk: INakama,
  logger: ILogger | undefined,
  joinerId: string,
  meta: ClubMetadata,
): ClubJoinGateDecision {
  // Block check (either-side).
  try {
    if (isBlockedEitherWay(nk, joinerId, meta.leaderId)) {
      return { allowed: false, reason: 'blocked' };
    }
  } catch (e) {
    if (logger) {
      logger.warn('club join block check failed: %s', e instanceof Error ? e.message : String(e));
    }
  }

  // Level check. A player without a profile is level 1 (plan T-21: the
  // gate used to skip the check and let them in).
  const profile = readProfile(nk, joinerId);
  const level = profile?.progression?.level ?? 1;
  if (typeof level !== 'number' || level < 8) {
    return { allowed: false, reason: 'min_level' };
  }

  // Division check. If the club's minDivision is the default 'bronce',
  // anyone qualifies. Otherwise compare the joiner's rating-derived
  // division.
  if (meta.minDivision !== 'bronce') {
    const rankedCfg = getRankedConfig();
    const rankedRec = readRankedRecord(nk, joinerId);
    const joinerRating = rankedRec !== null ? rankedRec.record.rating : 0;
    const joinerDivision = divisionForRating(rankedCfg, joinerRating);
    if (!isDivisionAtOrAbove(joinerDivision, meta.minDivision, rankedCfg)) {
      return { allowed: false, reason: 'min_division' };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Pure: is `actual` at or above `required` in the divisions list?
 * Index in `rankedCfg.divisions` ascending = better.
 */
export function isDivisionAtOrAbove(
  actual: string,
  required: string,
  rankedCfg: { divisions: ReadonlyArray<{ id: string }> },
): boolean {
  const aIdx = rankedCfg.divisions.findIndex((d) => d.id === actual);
  const rIdx = rankedCfg.divisions.findIndex((d) => d.id === required);
  if (aIdx === -1 || rIdx === -1) return false;
  return aIdx >= rIdx;
}