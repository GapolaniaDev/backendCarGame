// Phase 7 Chunk 3 — Clubs storage helpers (read-side).
//
// Storage layout:
//   clubs_metadata/{clubId}    — owner=leaderId, Read=2 (public),
//                                Write=1 (server-owned). Single row per
//                                club; created in `club_create`.
//   clubs_created/{userId}     — owner=userId, Read=1/Write=1.
//                                Lifetime counter (1 row per user who
//                                has ever created a club). Lazy on
//                                write — never read for presence.
//
// Nakama 3.27 JS runtime does NOT expose `registerBeforeAddGroupUsers` —
// the spec hook is deferred to a future runtime upgrade. For Chunk 3
// we ship the `beforeJoin` pure check helper in
// `modules/src/groups/before_join.ts` (from Chunk 2) and a
// `checkClubJoinGate` wrapper here that consumes the club metadata +
// caller's level/division. Production hook wiring will land when the
// runtime binding lands.

import type { IGroup, INakama, ILogger } from '../nkruntime';
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

export const MAX_CAS_RETRIES = 3;

// ─── Read metadata ────────────────────────────────────────────────────────────

/**
 * Read club metadata by `clubId`. Returns `null` when absent or
 * malformed.
 */
export function readClubMetadata(
  nk: INakama,
  clubId: string,
): { record: ClubMetadata; version: string } | null {
  // Try reading as the leader first; if that fails, scan for any
  // owner (clubs are publicly readable per D9). The data row is keyed
  // by `clubId` and the owner is `leaderId`, but read-permission is
  // public (Read=2) so any storageRead with `userId=clubId` works in
  // practice.
  const objs = nk.storageRead([
    { collection: CLUBS_METADATA_COLLECTION, key: clubId, userId: clubId },
  ]);
  const obj = objs[0];
  if (!obj) {
    // Fallback: scan public rows. Cheap enough at our scale (catalog
    // tens of thousands) and correct because clubs_metadata is
    // public-read.
    const list = nk.storageList({
      collection: CLUBS_METADATA_COLLECTION,
      limit: 200,
    });
    for (const o of list.objects) {
      if (o.key !== clubId) continue;
      const v = o.value as Partial<ClubMetadata>;
      if (
        v && typeof v === 'object' && v.schemaVersion === 1 &&
        typeof v.clubId === 'string' && typeof v.leaderId === 'string'
      ) {
        return { record: v as ClubMetadata, version: o.version ?? '' };
      }
    }
    return null;
  }
  const value = obj.value as Partial<ClubMetadata>;
  if (
    !value || typeof value !== 'object' || value.schemaVersion !== 1 ||
    typeof value.clubId !== 'string' || typeof value.leaderId !== 'string' ||
    typeof value.motto !== 'string' || typeof value.emblemId !== 'string' ||
    typeof value.region !== 'string' || typeof value.minDivision !== 'string' ||
    typeof value.weeklyPoints !== 'number' || typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  return { record: value as ClubMetadata, version: obj.version ?? '' };
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

export function writeClubMetadataCreate(
  nk: INakama,
  record: ClubMetadata,
): string {
  // The runtime requires `userId` to match the read-side permission;
  // for clubs we set the LEADER as the row owner (write permission
  // server-owned via PermissionWrite=1) and read-permission is 2
  // (public). See `asClubMetadataWrite`.
  const objs = nk.storageWrite([
    {
      collection: CLUBS_METADATA_COLLECTION,
      key: record.clubId,
      userId: record.leaderId,
      value: record as unknown as Record<string, unknown>,
      permissionRead: 2,
      permissionWrite: 1,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeClubMetadataUpdate(
  nk: INakama,
  record: ClubMetadata,
  version: string,
): string {
  const objs = nk.storageWrite([
    {
      collection: CLUBS_METADATA_COLLECTION,
      key: record.clubId,
      userId: record.leaderId,
      value: record as unknown as Record<string, unknown>,
      permissionRead: 2,
      permissionWrite: 1,
      version,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

export function writeClubCreated(
  nk: INakama,
  record: { schemaVersion: 1; userId: string; clubId: string; createdAt: number },
): string {
  const objs = nk.storageWrite([
    {
      collection: 'clubs_created',
      key: record.userId,
      userId: record.userId,
      value: record as unknown as Record<string, unknown>,
      permissionRead: 1,
      permissionWrite: 1,
    },
  ]);
  const first = (objs as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Scan `nk.groupsList()` for a group matching `clubId`. Returns
 * `null` when not found. The scan is cheap for our scale (tens of
 * thousands at peak) — and avoids a second storage row holding the
 * group name. Chunk 4 will replace this with a dedicated `club_id`
 * index if perf demands.
 */
export function readClubGroup(
  nk: INakama,
  clubId: string,
): IGroup | null {
  // `groupsList` paginates; a 200-limit scan covers all our clubs at
  // current scale. Chunk 4 can add cursor-aware pagination.
  const res = nk.groupsList(200, '', '') as unknown;
  const list = Array.isArray(res)
    ? (res as IGroup[])
    : ((res as { groups?: IGroup[] }).groups ?? []);
  for (const g of list) {
    if (typeof g === 'object' && g !== null && g.groupId === clubId) {
      return g;
    }
  }
  return null;
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
    clubId: group.groupId,
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

  // Level check.
  const profile = readProfile(nk, joinerId);
  if (profile !== null) {
    const level = profile.progression?.level ?? 1;
    if (typeof level === 'number' && level < 8) {
      return { allowed: false, reason: 'min_level' };
    }
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