// Phase 4 ranked storage repository. Thin wrapper over
// `nk.storageRead` / `storageWrite` that speaks `RankedRecord` +
// `SeasonMeta` objects and applies schema-version migration via
// `core/storage`.
//
// Storage layout:
//   - `ranked/{userId}`              — public-read, owner-only write
//   - `ranked_seasons_meta/{seasonId}` — server-only (`SYSTEM_USER_ID`)

import type { INakama } from '../nkruntime';
import { SCHEMA_VERSION } from '../core/storage';
import { SYSTEM_USER_ID } from '../race/constants';
import type { RankedRecord, SeasonMeta } from './types';

export const RANKED_COLLECTION = 'ranked';
export const SEASON_META_COLLECTION = 'ranked_seasons_meta';
/** Public-read for the record so the lb_get profile enrichment can read it
 *  directly when a player inspects another player's rank. */
export const RANKED_OWNER_READ = 2; // public
export const RANKED_OWNER_WRITE = 1; // owner-only (server bypasses via storageWrite)

/** Persisted shape: a RankedRecord whose schemaVersion is locked to 1. */
export interface PersistedRankedRecord
  extends RankedRecord,
    Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
}

/** Persisted shape: a SeasonMeta whose schemaVersion is locked to 1. */
export interface PersistedSeasonMeta
  extends SeasonMeta,
    Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
}

export interface ReadRankedResult {
  record: PersistedRankedRecord;
  version: string;
}

export interface ReadSeasonMetaResult {
  meta: PersistedSeasonMeta;
  version: string;
}

/**
 * Read `userId`'s ranked record, or `null` if they have never
 * participated in a ranked race. Owner = userId; permissionRead=2
 * means anyone (including the lb_get profile enrichment) can read.
 */
export function readRankedRecord(
  nk: INakama,
  userId: string,
): ReadRankedResult | null {
  const reads = nk.storageRead([
    { collection: RANKED_COLLECTION, key: userId, userId },
  ]);
  const obj = reads[0];
  if (!obj) return null;
  if (obj.version === undefined) {
    throw new Error(`readRankedRecord: stored object missing version for ${userId}`);
  }
  return { record: obj.value as PersistedRankedRecord, version: obj.version };
}

/**
 * First-write create. Does NOT enforce CAS — the caller must verify
 * the record does not exist (use `readRankedRecord` first) or pass
 * `version = undefined` for an unconditional insert. The stub
 * runtime ignores `version` on insert, but the real one will reject
 * duplicate inserts with the same owner+key.
 */
export function createRankedRecord(
  nk: INakama,
  record: RankedRecord,
): { version: string } {
  const acks = nk.storageWrite([
    {
      collection: RANKED_COLLECTION,
      key: record.userId,
      userId: record.userId,
      value: record as unknown as PersistedRankedRecord,
      permissionRead: RANKED_OWNER_READ,
      permissionWrite: RANKED_OWNER_WRITE,
    },
  ]);
  const first = acks[0];
  if (!first) {
    throw new Error(`createRankedRecord: storageWrite returned no ack for ${record.userId}`);
  }
  return { version: first.version };
}

/**
 * Conditional update of an existing record. The `expectedVersion`
 * must match the version currently in storage; the stub ignores it
 * but the real runtime refuses stale writes.
 */
export function updateRankedRecord(
  nk: INakama,
  record: RankedRecord,
  expectedVersion: string,
): { version: string } {
  const acks = nk.storageWrite([
    {
      collection: RANKED_COLLECTION,
      key: record.userId,
      userId: record.userId,
      value: record as unknown as PersistedRankedRecord,
      permissionRead: RANKED_OWNER_READ,
      permissionWrite: RANKED_OWNER_WRITE,
      version: expectedVersion,
    },
  ]);
  const first = acks[0];
  if (!first) {
    throw new Error(`updateRankedRecord: storageWrite returned no ack for ${record.userId}`);
  }
  return { version: first.version };
}

/**
 * Read the server-owned meta for `seasonId`. Returns `null` when no
 * season with that id has been initialised — the handler then asks
 * `loadRankedConfig` / the bundled `seasons.json` to fall back.
 */
export function readSeasonMeta(nk: INakama, seasonId: string): ReadSeasonMetaResult | null {
  const reads = nk.storageRead([
    {
      collection: SEASON_META_COLLECTION,
      key: seasonId,
      userId: SYSTEM_USER_ID,
    },
  ]);
  const obj = reads[0];
  if (!obj) return null;
  if (obj.version === undefined) {
    throw new Error(`readSeasonMeta: stored object missing version for ${seasonId}`);
  }
  return { meta: obj.value as PersistedSeasonMeta, version: obj.version };
}

/**
 * First-write create of a season meta. Server-owned (only the runtime
 * can read/write).
 */
export function createSeasonMeta(nk: INakama, meta: SeasonMeta): { version: string } {
  const acks = nk.storageWrite([
    {
      collection: SEASON_META_COLLECTION,
      key: meta.seasonId,
      userId: SYSTEM_USER_ID,
      value: meta as unknown as PersistedSeasonMeta,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
  const first = acks[0];
  if (!first) {
    throw new Error(`createSeasonMeta: storageWrite returned no ack for ${meta.seasonId}`);
  }
  return { version: first.version };
}

/**
 * Conditional update of a season meta — used by `lazyCloseSeason`
 * to atomically set `{status: 'closed', rewardsDistributed: true}`
 * under CAS. The caller passes the version they read; on mismatch
 * the stub ignores it but the real runtime throws.
 */
export function updateSeasonMeta(
  nk: INakama,
  meta: SeasonMeta,
  expectedVersion: string,
): { version: string } {
  const acks = nk.storageWrite([
    {
      collection: SEASON_META_COLLECTION,
      key: meta.seasonId,
      userId: SYSTEM_USER_ID,
      value: meta as unknown as PersistedSeasonMeta,
      permissionRead: 0,
      permissionWrite: 0,
      version: expectedVersion,
    },
  ]);
  const first = acks[0];
  if (!first) {
    throw new Error(`updateSeasonMeta: storageWrite returned no ack for ${meta.seasonId}`);
  }
  return { version: first.version };
}

/**
 * Compute a stable reward id for a (seasonId, rank) tuple. The lazy
 * close uses it as the deterministic inbox key — re-running the
 * close writes the same id, which `claimReward` is idempotent
 * against (the meta CAS is the real lock).
 */
export function rewardIdForRank(seasonId: string, rank: number): string {
  return `${seasonId}-rank-${rank}`;
}