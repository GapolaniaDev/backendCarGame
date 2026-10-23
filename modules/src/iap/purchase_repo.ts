// Phase 9 Chunk 3 — Purchase + first-purchase storage.
//
// Three server-owned collections:
//
//   iap_purchases/{userId}/{transactionId}   (R=1/W=0)  — 90d retention
//     Audit row of a delivered purchase. Stores the granted plan so a
//     retry of the same (userId, transactionId) returns the same
//     content.
//
//   iap_first_purchase/{userId}/{packId}    (R=1/W=0)  — 90d retention
//     Marker so the next purchase of the same pack skips the
//     first-time bonus. `grantedAtUtc` is informational.
//
//   iap_transactions/{system}/{platform}:{transactionId}   (R=0/W=0)
//     T-24: which account consumed a store transaction. Created with
//     version `*` in the same transaction as the delivery, so two
//     accounts racing with one receipt cannot both get it. Kept when the
//     account is deleted (a store transaction is consumed once).
//
// T-24: the rows are written inside the purchase's wallet movement
// (`moveWallet` extra writes, the `*Write` builders below). Keys longer
// than Nakama's 128 characters (a Google purchase token can be) are
// stored as `sha256:<hex>`; the transaction id is kept in the value.

import type { IStorageObject, INakama } from '../nkruntime';
import type { IapPlatform } from './types';
import type { IapGrantPlan } from './grant';
import { listStorage } from '../core/storage';
import { idempotencyStorageKey } from '../core/idempotency';

export const PURCHASES_COLLECTION = 'iap_purchases';
export const FIRST_PURCHASE_COLLECTION = 'iap_first_purchase';
export const IAP_TRANSACTIONS_COLLECTION = 'iap_transactions';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface PurchaseRecord {
  userId: string;
  packId: string;
  platform: IapPlatform;
  productId: string;
  /** The store transaction id (T-24; the storage key may be its hash). */
  transactionId?: string;
  content: IapGrantPlan;
  grantedAtUtc: number;
  idempotencyKey: string;
  newBalance?: number | undefined;
  isFirstTime: boolean;
  /** Set by Chunk 6 admin refund flow. */
  refunded?: boolean;
  refundedAtUtc?: number;
  refundedReason?: string;
  refundedByAdminId?: string;
}

export interface FirstPurchaseRecord {
  userId: string;
  packId: string;
  grantedAtUtc: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Storage key of a transaction id: itself, or `sha256:<hex>` past 128 characters. */
export function purchaseStorageKey(nk: INakama, transactionId: string): string {
  return idempotencyStorageKey(nk, transactionId);
}

export function asPurchase(v: unknown, userId: string, transactionId: string): PurchaseRecord | null {
  if (!isPlainObject(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r['packId'] !== 'string' || typeof r['grantedAtUtc'] !== 'number') return null;
  const out: PurchaseRecord = {
    userId,
    packId: r['packId'] as string,
    platform: (r['platform'] as IapPlatform) ?? 'apple',
    productId: (r['productId'] as string) ?? '',
    transactionId: typeof r['transactionId'] === 'string' ? (r['transactionId'] as string) : transactionId,
    content: r['content'] as IapGrantPlan,
    grantedAtUtc: r['grantedAtUtc'] as number,
    idempotencyKey: (r['idempotencyKey'] as string) ?? '',
    newBalance: typeof r['newBalance'] === 'number' ? (r['newBalance'] as number) : undefined,
    isFirstTime: r['isFirstTime'] === true,
  };
  if (r['refunded'] === true) {
    out.refunded = true;
    if (typeof r['refundedAtUtc'] === 'number') out.refundedAtUtc = r['refundedAtUtc'];
    if (typeof r['refundedReason'] === 'string') out.refundedReason = r['refundedReason'];
    if (typeof r['refundedByAdminId'] === 'string') out.refundedByAdminId = r['refundedByAdminId'];
  }
  return out;
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
    { collection: PURCHASES_COLLECTION, key: purchaseStorageKey(nk, transactionId), userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  return asPurchase(obj.value, userId, transactionId);
}

/**
 * Scan ALL purchases (any user) and find a row with the same
 * `transactionId`. Since T-24 the `iap_transactions` index answers this
 * for new purchases; the scan only covers rows written before the index
 * existed. Capped at 10 000 rows.
 */
export function findPurchaseAcrossUsers(
  nk: INakama,
  transactionId: string,
): { userId: string; record: PurchaseRecord } | null {
  const key = purchaseStorageKey(nk, transactionId);
  const list = listStorage(nk, { collection: PURCHASES_COLLECTION, limit: 10_000 });
  for (const r of list.objects) {
    if (r.key !== key) continue;
    const rec = asPurchase(r.value, r.userId, transactionId);
    if (rec) return { userId: r.userId, record: rec };
  }
  return null;
}

/** The create-only write of the purchase audit row (inside the delivery's movement). */
export function purchaseWrite(nk: INakama, txId: string, record: PurchaseRecord): IStorageObject {
  return {
    collection: PURCHASES_COLLECTION,
    key: purchaseStorageKey(nk, txId),
    userId: record.userId,
    value: { ...record, transactionId: txId } as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: '*',
  };
}

/** Write the purchase audit row. New write — no CAS version. */
export function writePurchase(nk: INakama, txId: string, record: PurchaseRecord): void {
  const obj = purchaseWrite(nk, txId, record);
  delete obj.version;
  nk.storageWrite([obj]);
}

/**
 * Read a purchase WITH its storage version (for CAS-update, used by
 * the admin refund flow).
 */
export function readPurchaseWithVersion(
  nk: INakama,
  userId: string,
  transactionId: string,
): { version: string; record: PurchaseRecord } | null {
  const reads = nk.storageRead([
    { collection: PURCHASES_COLLECTION, key: purchaseStorageKey(nk, transactionId), userId },
  ]);
  const obj = reads[0];
  if (!obj || obj.value === undefined) return null;
  const rec = asPurchase(obj.value, userId, transactionId);
  if (!rec) return null;
  if (typeof obj.version !== 'string') return null;
  return { version: obj.version, record: rec };
}

/** CAS-update a purchase row (used by the admin refund flow). */
export function writePurchaseUpdate(
  nk: INakama,
  txId: string,
  record: PurchaseRecord,
  expectedVersion: string,
): void {
  const obj: IStorageObject = {
    collection: PURCHASES_COLLECTION,
    key: purchaseStorageKey(nk, txId),
    userId: record.userId,
    value: { ...record, transactionId: txId } as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: expectedVersion,
  };
  nk.storageWrite([obj]);
}

/** List ALL purchases across all users, paginated. */
export function listAllPurchases(
  nk: INakama,
  limit: number = 10_000,
): Array<{ userId: string; transactionId: string; version: string; record: PurchaseRecord }> {
  const list = listStorage(nk, { collection: PURCHASES_COLLECTION, limit });
  const out: Array<{ userId: string; transactionId: string; version: string; record: PurchaseRecord }> = [];
  for (const o of list.objects) {
    const rec = asPurchase(o.value, o.userId, o.key);
    if (!rec || typeof o.version !== 'string') continue;
    out.push({ userId: o.userId, transactionId: rec.transactionId ?? o.key, version: o.version, record: rec });
  }
  return out;
}

// ─── iap_transactions ──────────────────────────────────────────────────────

export interface TransactionOwner {
  userId: string;
  platform: IapPlatform;
  transactionId: string;
  consumedAtUtc: number;
}

function transactionKey(nk: INakama, platform: IapPlatform, transactionId: string): string {
  return idempotencyStorageKey(nk, `${platform}:${transactionId}`);
}

/** The account that consumed `transactionId`, or `null` when none did yet. */
export function readTransactionOwner(
  nk: INakama,
  platform: IapPlatform,
  transactionId: string,
): TransactionOwner | null {
  const obj = nk.storageRead([
    { collection: IAP_TRANSACTIONS_COLLECTION, key: transactionKey(nk, platform, transactionId), userId: SYSTEM_USER_ID },
  ])[0];
  if (!obj || !isPlainObject(obj.value) || typeof obj.value['userId'] !== 'string') return null;
  return obj.value as unknown as TransactionOwner;
}

/** The create-only index write that binds `transactionId` to its account. */
export function transactionOwnerWrite(nk: INakama, owner: TransactionOwner): IStorageObject {
  return {
    collection: IAP_TRANSACTIONS_COLLECTION,
    key: transactionKey(nk, owner.platform, owner.transactionId),
    userId: SYSTEM_USER_ID,
    value: owner as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
    version: '*',
  };
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

/** The create-only write of the first-purchase marker (inside the delivery's movement). */
export function firstPurchaseWrite(userId: string, packId: string, grantedAtUtc: number): IStorageObject {
  return {
    collection: FIRST_PURCHASE_COLLECTION,
    key: packId,
    userId,
    value: { userId, packId, grantedAtUtc } as unknown as Record<string, unknown>,
    permissionRead: 1,
    permissionWrite: 0,
    version: '*',
  };
}

/** Mark the first purchase of a pack. Subsequent reads return the row. */
export function writeFirstPurchase(
  nk: INakama,
  userId: string,
  packId: string,
  grantedAtUtc: number,
): void {
  const obj = firstPurchaseWrite(userId, packId, grantedAtUtc);
  delete obj.version;
  nk.storageWrite([obj]);
}
