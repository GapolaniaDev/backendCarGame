// Phase 6 Chunk 6 — PassRecord storage helpers.
//
// Storage layout:
//   - collection `pass`, key `${userId}`, userId `${userId}`
//     (single row per player; seasonId is inside the record)
//
// Permissions: server-owned (Phase 4/5 convention).
//
// The row is LAZY-created by `pass_get` (analog of D13 for
// achievements): a player who never opened the pass has no row. The
// subscriber (Chunk 7) WILL need to write XP into it; that's why the
// module is split from the season helper so the subscriber can import
// without pulling RPC code.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import { validatePassRecord, getPassCatalog } from './catalog';
import { SERVER_OWNED_READ, SERVER_OWNED_WRITE } from './season';
import type { PassRecord } from './types';

export const PASS_COLLECTION = 'pass';

export function passRecordKey(userId: string): string {
  return userId;
}

/**
 * Result envelope returned by `ensurePassRecord`. `created=true` means
 * the lazy-write actually fired (useful for analytics + idempotency
 * tests).
 */
export interface EnsurePassResult {
  record: PassRecord;
  created: boolean;
  /** Version after the operation. */
  version: string;
}

/** Read a PassRecord. Returns null when absent. */
export function readPassRecord(
  nk: INakama,
  userId: string,
  expectedSeasonId: string,
): { record: PassRecord; version: string } | null {
  const objs = nk.storageRead([{
    collection: PASS_COLLECTION,
    key: passRecordKey(userId),
    userId,
  }]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value;
  if (!validatePassRecord(value)) return null;
  // If the record belongs to an older season we treat it as absent —
  // the chunk-6 player gets a fresh row in the new season. (Ranked
  // migration is irrelevant for the pass because XP / claimed lists
  // are per-season by the catalog definition.)
  if (value.seasonId !== expectedSeasonId) return null;
  return { record: value, version: obj.version ?? '' };
}

/**
 * Create a new PassRecord in the catalog's current season. Used by
 * `ensurePassRecord` and the subscriber when writing XP for the first
 * time in a new season.
 */
export function writePassCreate(nk: INakama, record: PassRecord): string {
  const obj: IStorageObject = {
    collection: PASS_COLLECTION,
    key: passRecordKey(record.userId),
    userId: record.userId,
    value: record as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * CAS-update an existing PassRecord. Caller must own the matching
 * `version`; throws (storage layer surfaces as runtime error → caller
 * catches → tries again with bumped version).
 */
export function writePassUpdate(
  nk: INakama,
  record: PassRecord,
  version: string,
): string {
  const obj: IStorageObject = {
    collection: PASS_COLLECTION,
    key: passRecordKey(record.userId),
    userId: record.userId,
    value: record as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
    version,
  };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Lazy-create (or return existing) PassRecord for `userId`. The new
 * row carries `seasonId = currentPassCatalog.seasonId` and zero
 * progress. Returns `{record, created, version}`.
 */
export function ensurePassRecord(
  nk: INakama,
  logger: ILogger,
  userId: string,
): EnsurePassResult {
  const catalog = getPassCatalog();
  const expectedSeasonId = catalog.seasonId;

  const existing = readPassRecord(nk, userId, expectedSeasonId);
  if (existing !== null) {
    return { record: existing.record, created: false, version: existing.version };
  }

  const fresh: PassRecord = {
    schemaVersion: 1,
    userId,
    seasonId: expectedSeasonId,
    xp: 0,
    claimedFree: [],
    claimedPremium: [],
    premiumPurchased: false,
    seasonClosed: false,
  };
  const version = writePassCreate(nk, fresh);
  logger.info(
    'pass lazy-created user=%s seasonId=%s',
    userId, expectedSeasonId,
  );
  return { record: fresh, created: true, version };
}

/**
 * Add `delta` XP to a player's PassRecord. Caller is the subscriber
 * (Chunk 7); this helper exists today so future code does not have to
 * redo the CAS loop. `delta` MUST be a non-negative integer.
 *
 * Retries up to 3 times on CAS collision; returns the new record (or
 * the original on exhausted retries so the caller can decide what to
 * do — typically log + drop).
 */
export const ADD_XP_MAX_CAS_RETRIES = 3;

export function addPassXp(
  nk: INakama,
  logger: ILogger,
  userId: string,
  delta: number,
): PassRecord | null {
  if (!Number.isInteger(delta) || delta < 0) {
    logger.warn('addPassXp: invalid delta=%s for user=%s', String(delta), userId);
    return null;
  }
  if (delta === 0) {
    // No-op: return the current record (lazy-create if missing) without
    // a storage write.
    const existing = readPassRecord(nk, userId, getPassCatalog().seasonId);
    if (existing !== null) return existing.record;
    return ensurePassRecord(nk, logger, userId).record;
  }
  const catalog = getPassCatalog();
  for (let attempt = 0; attempt < ADD_XP_MAX_CAS_RETRIES; attempt += 1) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    if (existing === null) {
      // Lazy-create first so the next attempt can mutate it.
      const fresh = ensurePassRecord(nk, logger, userId);
      // Loop again — `fresh.record.xp` will be added next iteration.
      void fresh;
      continue;
    }
    const next: PassRecord = {
      ...existing.record,
      xp: existing.record.xp + delta,
    };
    try {
      writePassUpdate(nk, next, existing.version);
      logger.info(
        'pass xp added user=%s delta=%d newXp=%d attempt=%d',
        userId, delta, next.xp, attempt + 1,
      );
      return next;
    } catch (e) {
      logger.warn(
        'addPassXp CAS conflict user=%s attempt=%d: %s',
        userId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.warn('addPassXp retries exhausted user=%s delta=%d', userId, delta);
  return null;
}