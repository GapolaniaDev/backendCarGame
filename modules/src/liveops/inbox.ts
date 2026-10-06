// Phase 4 liveops inbox. Server-owned "reward bucket" the lazy-close
// path writes into after every season end, and future give-back
// rewards will reuse. The client reads its own inbox via
// `nk.storageRead` with its userId; the server writes via `nk.storageWrite`
// with perms { read: 1 (owner), write: 1 (owner) }.
//
// Storage layout:
//   collection: `liveops_inbox`
//   key:        `${userId}/${rewardId}`
//   userId:     `userId` (owner — only they may read/write directly)
//   permissionRead:  1 (owner)
//   permissionWrite: 1 (owner)
//
// Phase 4 Chunk 6 ships `sendReward` + `listInbox` + a small claims
// helper. The handler-side `inbox_get` RPC lands in a later chunk.

import type { INakama } from '../nkruntime';
import type { InboxEntry, InboxRewardPayload, InboxRewardType } from '../ranked/types';

export const INBOX_COLLECTION = 'liveops_inbox';
export const INBOX_OWNER_READ = 1; // owner-only read
export const INBOX_OWNER_WRITE = 1; // owner-only write

/** Composite key for a single inbox entry. */
export function inboxKey(userId: string, rewardId: string): string {
  return `${userId}/${rewardId}`;
}

/**
 * Server-side: write a reward entry to `userId`'s inbox.
 *
 * Idempotency: the runtime refuses a write when a record with the
 * same `(userId, rewardId)` already exists with a different value —
 * but the lazy-close path uses deterministic reward ids
 * (`${seasonId}-${rank}`) so re-running the close is safe (the
 * second call sees `meta.rewardsDistributed === true` and bails
 * before reaching this helper).
 *
 * The stub `nk.storageWrite` doesn't enforce uniqueness, so the
 * caller must guard re-entry via the season-meta CAS.
 */
export function sendReward(
  nk: INakama,
  userId: string,
  type: InboxRewardType,
  payload: InboxRewardPayload,
  rewardId: string,
  nowMs: number,
  expiresAt: number | null = null,
): { version: string } {
  const entry: InboxEntry = {
    schemaVersion: 1,
    rewardId,
    userId,
    type,
    payload,
    createdAt: nowMs,
    expiresAt,
    claimed: false,
  };
  const acks = nk.storageWrite([
    {
      collection: INBOX_COLLECTION,
      key: inboxKey(userId, rewardId),
      userId,
      value: entry as unknown as Record<string, unknown>,
      permissionRead: INBOX_OWNER_READ,
      permissionWrite: INBOX_OWNER_WRITE,
    },
  ]);
  const first = acks[0];
  if (!first) {
    throw new Error(`sendReward: storageWrite returned no ack for ${userId}/${rewardId}`);
  }
  return { version: first.version };
}

/**
 * Read every reward in `userId`'s inbox. Returns an array sorted by
 * `createdAt` descending (newest on top, like a feed).
 */
export function listInbox(nk: INakama, userId: string): InboxEntry[] {
  const objects = nk.storageList({
    collection: INBOX_COLLECTION,
    userId,
  });
  const out: InboxEntry[] = [];
  for (const o of objects.objects) {
    const v = o.value as Partial<InboxEntry>;
    if (
      typeof v.rewardId === 'string' &&
      typeof v.userId === 'string' &&
      typeof v.type === 'string' &&
      typeof v.payload === 'object' &&
      v.payload !== null
    ) {
      out.push(v as InboxEntry);
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Mark a reward as claimed. CAS-free today (single-owner write under
 * the perms layer); a future chunk may add CAS for replay safety.
 */
export function claimReward(
  nk: INakama,
  userId: string,
  rewardId: string,
  expectedVersion: string,
): { version: string } {
  const reads = nk.storageRead([
    { collection: INBOX_COLLECTION, key: inboxKey(userId, rewardId), userId },
  ]);
  const obj = reads[0];
  if (!obj) throw new Error(`claimReward: ${userId}/${rewardId} not found`);
  const entry = obj.value as InboxEntry;
  if (entry.claimed) return { version: expectedVersion };
  const next: InboxEntry = { ...entry, claimed: true };
  const acks = nk.storageWrite([
    {
      collection: INBOX_COLLECTION,
      key: inboxKey(userId, rewardId),
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: INBOX_OWNER_READ,
      permissionWrite: INBOX_OWNER_WRITE,
      version: expectedVersion,
    },
  ]);
  const first = acks[0];
  if (!first) throw new Error('claimReward: storageWrite returned no ack');
  return { version: first.version };
}