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
import { validatePassRecord, getPassCatalog, xpToLevel } from './catalog';
import { SERVER_OWNED_READ, SERVER_OWNED_WRITE } from './season';
import type { PassCatalog, PassRecord } from './types';

export const PASS_COLLECTION = 'pass';

/**
 * Per-user ledger of which `source:key` XP grants have already been applied.
 * Phase 6 Chunk 7. Race XP double-grants are guarded by checking this
 * row before incrementing. Mission / achievement XP grants don't need
 * it (the claim itself is CAS-protected), but the helper supports
 * either path via the optional `dedupeKey` arg.
 */
export const PASS_XP_LEDGER_COLLECTION = 'pass_xp_ledger';

export function passRecordKey(userId: string): string {
  return userId;
}

/**
 * Ledger row key. `source` is the `PassXPSource` (e.g. `race_quick`,
 * `mission_claim`); `dedupeId` is an opaque per-grant id (race
 * sessionId, mission id, achievement id). One row per (user, source, id).
 */
export function passXpLedgerKey(userId: string, source: string, dedupeId: string): string {
  return `${userId}/${source}/${dedupeId}`;
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
 * Result envelope returned by `addPassXp`. `applied = false` means the
 * XP grant was skipped because `dedupeKey` had already been granted
 * (idempotency hit). `applied = true` means the XP delta was applied
 * and the record + level state reflect the post-write shape.
 */
export interface AddPassXpResult {
  record: PassRecord;
  /** Levels crossed by this grant (may be empty). Always strictly ascending. */
  levelUps: number[];
  /** New level after the grant. */
  newLevel: number;
  /** `true` when XP was added; `false` when the dedupe key already existed. */
  applied: boolean;
}

/**
 * Add `delta` XP to a player's PassRecord. Caller is the subscriber
 * (race XP) or the claim RPC (mission / achievement XP). `delta` MUST
 * be a non-negative integer; anything else → `null`.
 *
 * Idempotency: when `dedupeKey` is provided, the function writes a
 * row in `pass_xp_ledger` keyed by `(user, source, dedupeKey)`. The
 * first call wins; subsequent calls with the same key are no-ops
 * returning `{ record, applied: false, ... }`. Race XP always passes
 * `sessionId` here; mission / achievement XP pass their respective
 * claim id (also fine, but not strictly required since the claim
 * itself is CAS-protected).
 *
 * Retries up to 3 times on CAS collision; on exhaustion returns a
 * record-shaped envelope with `applied: false` (caller can log + drop).
 */
export const ADD_XP_MAX_CAS_RETRIES = 3;

/** Returns `true` when a ledger row for (user, source, dedupeKey) already exists. */
export function isXpLedgerApplied(
  nk: INakama,
  userId: string,
  source: string,
  dedupeKey: string,
): boolean {
  const key = passXpLedgerKey(userId, source, dedupeKey);
  const objs = nk.storageRead([
    { collection: PASS_XP_LEDGER_COLLECTION, key, userId },
  ]);
  return objs[0] !== undefined && objs[0] !== null;
}

/**
 * Write the ledger row (server-owned) marking `userId`/`source`/`dedupeKey`
 * as applied. Returns `true` on success, `false` on storage error.
 */
function writeXpLedger(
  nk: INakama,
  userId: string,
  source: string,
  dedupeKey: string,
  amount: number,
): boolean {
  const obj: IStorageObject = {
    collection: PASS_XP_LEDGER_COLLECTION,
    key: passXpLedgerKey(userId, source, dedupeKey),
    userId,
    value: {
      schemaVersion: 1,
      userId,
      source,
      dedupeKey,
      amount,
      ts: Date.now(),
    } as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };
  try {
    nk.storageWrite([obj]);
    return true;
  } catch (e) {
    return false;
  }
}

export function addPassXp(
  nk: INakama,
  logger: ILogger,
  userId: string,
  delta: number,
  dedupeKey?: { source: string; id: string },
): AddPassXpResult | null {
  if (!Number.isInteger(delta) || delta < 0) {
    logger.warn('addPassXp: invalid delta=%s for user=%s', String(delta), userId);
    return null;
  }

  // Best-effort: the pass catalog lives in a different VM/module than
  // the source-imported subscriber (when tests call the handler
  // directly). When the catalog isn't loaded in *this* module, fail
  // silently — the subscriber must never throw.
  let catalog: Readonly<PassCatalog>;
  try {
    catalog = getPassCatalog();
  } catch (e) {
    logger.warn(
      'addPassXp: pass catalog not loaded (user=%s) — skipping XP grant: %s',
      userId, e instanceof Error ? e.message : String(e),
    );
    return null;
  }

  // 1. Idempotency check.
  if (dedupeKey !== undefined && isXpLedgerApplied(nk, userId, dedupeKey.source, dedupeKey.id)) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    const record = existing?.record ?? ensurePassRecord(nk, logger, userId).record;
    return {
      record,
      levelUps: [],
      newLevel: xpToLevel(catalog, record.xp),
      applied: false,
    };
  }

  // 2. delta === 0 fast-path: no-op, return current shape.
  if (delta === 0) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    const record = existing?.record ?? ensurePassRecord(nk, logger, userId).record;
    return {
      record,
      levelUps: [],
      newLevel: xpToLevel(catalog, record.xp),
      applied: dedupeKey === undefined ? true : false,
    };
  }

  // 3. CAS-retry loop.
  for (let attempt = 0; attempt < ADD_XP_MAX_CAS_RETRIES; attempt += 1) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    if (existing === null) {
      ensurePassRecord(nk, logger, userId);
      continue;
    }

    const beforeXp = existing.record.xp;
    const beforeLevel = xpToLevel(catalog, beforeXp);
    const nextXp = beforeXp + delta;
    const next: PassRecord = { ...existing.record, xp: nextXp };
    try {
      writePassUpdate(nk, next, existing.version);
      // 4. After the XP write succeeded, mark the ledger row.
      if (dedupeKey !== undefined) {
        writeXpLedger(nk, userId, dedupeKey.source, dedupeKey.id, delta);
      }
      const newLevel = xpToLevel(catalog, nextXp);
      const levelUps: number[] = [];
      for (let lvl = beforeLevel + 1; lvl <= newLevel; lvl += 1) {
        levelUps.push(lvl);
      }
      logger.info(
        'pass xp added user=%s delta=%d newXp=%d newLevel=%d levelUps=%d applied=true attempt=%d',
        userId, delta, nextXp, newLevel, levelUps.length, attempt + 1,
      );
      return { record: next, levelUps, newLevel, applied: true };
    } catch (e) {
      logger.warn(
        'addPassXp CAS conflict user=%s attempt=%d: %s',
        userId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  logger.warn('addPassXp retries exhausted user=%s delta=%d', userId, delta);

  // 5. CAS exhaustion — return current state with applied: false.
  const existing = readPassRecord(nk, userId, catalog.seasonId);
  const record = existing?.record ?? ensurePassRecord(nk, logger, userId).record;
  return {
    record,
    levelUps: [],
    newLevel: xpToLevel(catalog, record.xp),
    applied: false,
  };
}