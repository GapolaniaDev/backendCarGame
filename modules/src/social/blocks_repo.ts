// Phase 7 Chunk 2 — Block storage helpers.
//
// Storage layout:
//   blocks/{ownerId}/{targetUserId} — owner=ownerId, key=targetUserId
//   `userId` is the OWNER (the user who blocks); `key` is who they block.
//   Read=1/Write=1 server-owned.
//
// Block is symmetric for INVITE / friend / join / chat — `isBlocked(nk,
// aId, bId)` checks both directions. Idempotent on add: insert-if-absent,
// never throws on duplicate.

import type { IStorageKey, IStorageObject, INakama } from '../nkruntime';
import {
  asBlockWrite,
  type BlockRecord,
  BLOCKS_COLLECTION,
} from './types';
import { listStorage } from '../core/storage';

export const MAX_CAS_RETRIES = 3;

// ─── Read / write ────────────────────────────────────────────────────────────

/**
 * Read a single block. Returns `null` when absent.
 */
export function readBlock(
  nk: INakama,
  ownerId: string,
  targetUserId: string,
): { record: BlockRecord; version: string } | null {
  const objs = nk.storageRead([
    { collection: BLOCKS_COLLECTION, key: targetUserId, userId: ownerId },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const value = obj.value as Partial<BlockRecord>;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.ownerId !== 'string' ||
    typeof value.targetUserId !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  return { record: value as BlockRecord, version: obj.version ?? '' };
}

/**
 * Create a block row. Caller must have checked absence first OR
 * intentionally accept no-op on duplicate (which is the
 * `block_add` RPC's contract — idempotent).
 */
export function writeBlockCreate(
  nk: INakama,
  record: BlockRecord,
): string {
  const obj: IStorageObject = asBlockWrite(record);
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * CAS-update an existing block row. Used for createdAt reset (rare;
 * default is to leave the original timestamp). Reserved.
 */
export function writeBlockUpdate(
  nk: INakama,
  record: BlockRecord,
  version: string,
): string {
  const obj: IStorageObject = { ...asBlockWrite(record), version };
  const acks = nk.storageWrite([obj]);
  const first = (acks as Array<{ version?: string }>)[0];
  return first?.version ?? '';
}

/**
 * Delete a block row. Idempotent — `storageDelete` is no-op on absent.
 */
export function deleteBlock(
  nk: INakama,
  ownerId: string,
  targetUserId: string,
): void {
  const keys: IStorageKey[] = [
    { collection: BLOCKS_COLLECTION, key: targetUserId, userId: ownerId },
  ];
  nk.storageDelete(keys);
}

/**
 * List every block owned by `userId`.
 */
export function listBlocks(
  nk: INakama,
  userId: string,
): BlockRecord[] {
  const res = listStorage(nk, {
    collection: BLOCKS_COLLECTION,
    userId,
    limit: 200,
  });
  const out: BlockRecord[] = [];
  for (const obj of res.objects) {
    const v = obj.value as Partial<BlockRecord>;
    if (
      v &&
      typeof v === 'object' &&
      v.schemaVersion === 1 &&
      typeof v.ownerId === 'string' &&
      typeof v.targetUserId === 'string' &&
      typeof v.createdAt === 'number'
    ) {
      out.push(v as BlockRecord);
    }
  }
  return out;
}

// ─── Symmetric block check ──────────────────────────────────────────────────

/**
 * Returns `true` when `ownerId` has blocked `targetUserId` (in either
 * direction). Use this for invite / friend / join / chat gates.
 *
 * Two reads; in practice the second is a cache miss only when `ownerId`
 * ≠ `targetUserId` AND the first read was positive (the second is
 * normally a no-op linear scan via storageRead).
 */
export function isBlockedEitherWay(
  nk: INakama,
  ownerId: string,
  targetUserId: string,
): boolean {
  if (ownerId === targetUserId) return false;
  const a = readBlock(nk, ownerId, targetUserId);
  if (a !== null) return true;
  const b = readBlock(nk, targetUserId, ownerId);
  return b !== null;
}
/**
 * The ids of `others` that have a block with `userId` in either direction,
 * in one batched read (plan T-22: club chat history hides them).
 */
export function blockedEitherWaySet(
  nk: INakama,
  userId: string,
  others: ReadonlyArray<string>,
): Set<string> {
  const ids = Array.from(new Set(others.filter((o) => o !== userId)));
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const keys = ids.flatMap((o) => [
    { collection: BLOCKS_COLLECTION, key: o, userId },
    { collection: BLOCKS_COLLECTION, key: userId, userId: o },
  ]);
  for (const obj of nk.storageRead(keys)) {
    if (!obj || obj.value === undefined) continue;
    out.add(obj.userId === userId ? obj.key : obj.userId);
  }
  return out;
}
