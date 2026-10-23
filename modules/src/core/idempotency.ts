// Durable idempotency records for money movements (plan T-11, audit PC-11).
//
// One storage object per (owner, key): collection `idem`, owner = the
// user whose wallet moved, key = the logical idempotency key (hashed when
// it does not fit Nakama's 128-character storage key). The record is
// written in the SAME `nk.multiUpdate` as the wallet update and its
// ledger row, so the movement and its record commit or roll back
// together, and they survive a Nakama restart (the previous flag lived in
// the process-local `localcache`).
//
// Create-only writes use version `*`: of N concurrent movements with the
// same key exactly one commits; the others abort with a version
// conflict, re-read the record and replay. A movement undone by its
// compensating movement is marked `reverted` (CAS on the record
// version), so the same key can be applied again: a purchase retried
// after a refund charges again (HT-73).

import type { INakama, IStorageObject } from '../nkruntime';

export const IDEMPOTENCY_COLLECTION = 'idem';

/** Nakama storage keys are VARCHAR(128). */
export const IDEMPOTENCY_STORAGE_KEY_MAX = 128;

export type IdempotencyState = 'applied' | 'reverted';

export interface IdempotencyRecord {
  schemaVersion: 1;
  /** The logical key (also when the storage key is its hash). */
  key: string;
  state: IdempotencyState;
  /** Net signed wallet movement the key applied (`{currencyId: amount}`). */
  changeset: Record<string, number>;
  appliedAt: number;
  revertedAt?: number;
  /** Caller payload stored with the movement and returned on a replay. */
  result?: unknown;
}

export interface StoredIdempotency {
  record: IdempotencyRecord;
  version: string;
}

/** Storage key for a logical key: itself, or `sha256:<hex>` when too long. */
export function idempotencyStorageKey(nk: INakama, key: string): string {
  if (key.length > 0 && key.length <= IDEMPOTENCY_STORAGE_KEY_MAX) return key;
  return `sha256:${nk.sha256Hash(key)}`;
}

export function readIdempotency(nk: INakama, userId: string, key: string): StoredIdempotency | null {
  const obj = nk.storageRead([
    { collection: IDEMPOTENCY_COLLECTION, key: idempotencyStorageKey(nk, key), userId },
  ])[0];
  if (!obj || typeof obj.value !== 'object' || obj.value === null) return null;
  return { record: obj.value as unknown as IdempotencyRecord, version: obj.version ?? '' };
}

/**
 * Storage write for a record. `version` is the version read (CAS), or
 * `null` to create it (`*`: fails if it exists). Server-only object.
 */
export function idempotencyWrite(
  nk: INakama,
  userId: string,
  record: IdempotencyRecord,
  version: string | null,
): IStorageObject {
  return {
    collection: IDEMPOTENCY_COLLECTION,
    key: idempotencyStorageKey(nk, record.key),
    userId,
    value: record as unknown as Record<string, unknown>,
    version: version ?? '*',
    permissionRead: 0,
    permissionWrite: 0,
  };
}

/** A storage write of the transaction lost its version check. */
export function isVersionConflict(e: unknown): boolean {
  return /version check failed/i.test(errorMessage(e));
}

/** A wallet update of the transaction would leave a negative balance. */
export function isNegativeWallet(e: unknown): boolean {
  return /rejected negative value/i.test(errorMessage(e));
}

/** Message of a thrown value (goja wraps Go errors as `GoError` objects). */
export function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  if (typeof m === 'string') return m;
  return String(e);
}
