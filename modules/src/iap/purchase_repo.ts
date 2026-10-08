// Phase 9 Chunk 3 — Purchase + first-purchase storage.
//
// Two server-owned collections:
//
//   iap_purchases/{userId}/{transactionId}   (R=1/W=0)  — 90d retention
//     Audit row written AFTER a successful grant. Stores the granted
//     plan so a retry of the same (userId, transactionId) returns the
//     same content + new balance. Cross-user fraud check scans this
//     collection (1-arg storageList) for a `transactionId` collision.
//
//   iap_first_purchase/{userId}/{packId}    (R=1/W=0)  — 90d retention
//     Marker so the next purchase of the same pack skips the
//     first-time bonus. `grantedAtUtc` is informational.

import type { IStorageObject, INakama } from '../nkruntime';
import type { IapPlatform } from './types';
import type { IapGrantPlan } from './grant';

export const PURCHASES_COLLECTION = 'iap_purchases';
export const FIRST_PURCHASE_COLLECTION = 'iap_first_purchase';

export interface PurchaseRecord {
  userId: string;
  packId: string;
  platform: IapPlatform;
  productId: string;
  content: IapGrantPlan;
  grantedAtUtc: number;
  idempotencyKey: string;
  newBalance?: number | undefined;
  isFirstTime: boolean;
}

export interface FirstPurchaseRecord {
  userId: string;
  packId: string;
  grantedAtUtc: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPurchase(v: unknown, userId: string, transactionId: string): PurchaseRecord | null {
  if (!isPlainObject(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r['packId'] !== 'string' || typeof r['grantedAtUtc'] !== 'number') return null;
  return {
    userId,
    packId: r['packId'] as string,
    platform: (r['platform'] as IapPlatform) ?? 'apple',
    productId: (r['productId'] as string) ?? '',
    content: r['content'] as IapGrantPlan,
    grantedAtUtc: r['grantedAtUtc'] as number,
    idempotencyKey: (r['idempotencyKey'] as string) ?? '',
    newBalance: typeof r['newBalance'] === 'number' ? (r['newBalance'] as number) : undefined,
    isFirstTime: r['isFirstTime'] === true,
  };
}

// ─── iap_purchases ─────────────────────────────────────────────────────────

/**
 * Read a single purchase row for this user. Returns `null` if no row
 * exists for the given (userId, transactionId) pair. The collection
 * key is the transactionId, scoped under the userId.
 */
export function readPurchaseByTxId(
  nk: INakama,
  userId: string,
  transactionId: string,
): PurchaseRecord | null {
  const reads = nk.storageRead([
    { collection: PURCHASES_COLLECTION, key: transactionId, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asPurchase(obj.value, userId, transactionId);
}

/**
 * Scan ALL purchases (any user) and find a row with the same
 * `transactionId`. Used for cross-user fraud detection: a single
 * store transaction can only be consumed by one account. The
 * 10 000-row cap matches the `storageList` limit; if we exceed it
 * the anti-fraud index lives in Chunk 6.
 */
export function findPurchaseAcrossUsers(
  nk: INakama,
  transactionId: string,
): { userId: string; record: PurchaseRecord } | null {
  const list = nk.storageList({ collection: PURCHASES_COLLECTION, limit: 10_000 });
  for (const r of list.objects) {
    if (r.key !== transactionId) continue;
    const rec = asPurchase(r.value, r.userId, transactionId);
    if (rec) return { userId: r.userId, record: rec };
  }
  return null;
}

/** Write the purchase audit row. New write — no CAS version. */
export function writePurchase(nk: INakama, txId: string, record: PurchaseRecord): void {
  const obj: IStorageObject = {
    collection: PURCHASES_COLLECTION,
    key: txId,
    userId: record.userId,
    value: record as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

// ─── iap_first_purchase ────────────────────────────────────────────────────

/**
 * Read the first-purchase marker. Returns `null` if the user has
 * never bought this pack. The grant layer uses the absence to apply
 * the first-time bonus.
 */
export function readFirstPurchase(
  nk: INakama,
  userId: string,
  packId: string,
): FirstPurchaseRecord | null {
  const reads = nk.storageRead([
    { collection: FIRST_PURCHASE_COLLECTION, key: packId, userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  if (!isPlainObject(obj.value)) return null;
  const v = obj.value as Record<string, unknown>;
  return {
    userId,
    packId,
    grantedAtUtc: typeof v['grantedAtUtc'] === 'number' ? (v['grantedAtUtc'] as number) : 0,
  };
}

/** Mark the first purchase of a pack. Subsequent reads return the row. */
export function writeFirstPurchase(
  nk: INakama,
  userId: string,
  packId: string,
  grantedAtUtc: number,
): void {
  const obj: IStorageObject = {
    collection: FIRST_PURCHASE_COLLECTION,
    key: packId,
    userId,
    value: { userId, packId, grantedAtUtc } as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}
