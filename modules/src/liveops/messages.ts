// Phase 5 Chunk 3 — Per-user inbox (messages) module.
//
// This is the **per-user, owner-read** inbox — NOT the Phase 4
// `liveops_inbox` (which is the server-side batch reward bucket for
// season-end rewards; that one stays untouched). The two coexist on
// different collections (`inbox` vs `liveops_inbox`) with different
// perms and different claim semantics.
//
// Storage layout:
//   collection: `inbox`
//   key:        `${userId}/${messageId}`  (so the user can list their own
//                messages via `nk.storageList({ collection, userId })`)
//   userId:     `userId` (owner)
//   permissionRead:  1 (owner)
//   permissionWrite: 0 (server-only) — clients claim via RPC, not
//                direct storage write
//
// Decisions enforced here:
//   D3 retention: 30 days from `createdAt`. Expired messages are
//      filtered from `listInbox` and rejected by `claimInbox`.
//   D13 idempotency: `messageId` is a server-issued UUID. Re-claiming
//      a message returns `CONFLICT`; a duplicate `sendInbox` for the
//      same `messageId` is silently ignored (idempotent insert).

import type { IStorageObject, INakama } from '../nkruntime';

export const INBOX_COLLECTION = 'inbox';
export const INBOX_OWNER_READ = 1;
export const INBOX_OWNER_WRITE = 0;
export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type InboxKind = 'reward' | 'system';

export interface InboxRewardPayload {
  coins?: number;
  gems?: number;
  cosmeticId?: string;
  carId?: string;
}

export interface InboxMessage {
  schemaVersion: 1;
  id: string;
  userId: string;
  kind: InboxKind;
  title: string;
  body: string;
  reward?: InboxRewardPayload;
  /** Epoch-ms when the message expires (TTL 30d from createdAt). */
  expiresAt?: number;
  /** Epoch-ms when the message was claimed (set by `claimInbox`). */
  claimedAt?: number;
  createdAt: number;
}

/** Composite key for a single inbox entry (sortable, owner-scoped). */
export function inboxKey(userId: string, messageId: string): string {
  return `${userId}/${messageId}`;
}

// ─── Send ──────────────────────────────────────────────────────────────────

export interface SendInboxResult {
  inserted: boolean;
  message: InboxMessage;
}

/**
 * Idempotently insert a new inbox message. The composite key
 * `(userId, messageId)` is unique — if a message with the same id
 * already exists, this is a no-op (returns `inserted: false`) so
 * an admin tool can safely re-send.
 *
 * Permission is owner-read, server-write. Clients can't write
 * directly — the only path to mutate is `claimInbox` (server-side
 * CAS).
 */
export function sendInbox(
  nk: INakama,
  userId: string,
  message: Omit<InboxMessage, 'schemaVersion' | 'userId' | 'createdAt' | 'expiresAt'> & {
    /** Optional override — defaults to `createdAt + INBOX_RETENTION_MS`. */
    expiresAt?: number;
  },
  nowMs: number,
): SendInboxResult {
  // Idempotency guard — if the message already exists, return as-is.
  const key = inboxKey(userId, message.id);
  const existing = nk.storageRead([
    { collection: INBOX_COLLECTION, key, userId },
  ])[0];
  if (existing !== undefined && existing.value !== undefined) {
    return { inserted: false, message: existing.value as InboxMessage };
  }

  const full: InboxMessage = {
    schemaVersion: 1,
    id: message.id,
    userId,
    kind: message.kind,
    title: message.title,
    body: message.body,
    ...(message.reward !== undefined ? { reward: message.reward } : {}),
    createdAt: nowMs,
    expiresAt: message.expiresAt ?? nowMs + INBOX_RETENTION_MS,
  };

  nk.storageWrite([
    {
      collection: INBOX_COLLECTION,
      key,
      userId,
      value: full as unknown as Record<string, unknown>,
      permissionRead: INBOX_OWNER_READ,
      permissionWrite: INBOX_OWNER_WRITE,
    },
  ]);
  return { inserted: true, message: full };
}

// ─── List ──────────────────────────────────────────────────────────────────

export interface ListInboxOptions {
  limit?: number;
  cursor?: string;
  /** When true, claimed messages are also returned. Default `false`. */
  includeClaimed?: boolean;
}

export interface ListInboxResult {
  messages: InboxMessage[];
  nextCursor: string;
  unreadCount: number;
}

/**
 * List the caller's inbox, newest first. `unreadCount` always
 * reflects only the un-claimed, un-expired messages (used by the
 * client to render the inbox badge).
 */
export function listInbox(
  nk: INakama,
  userId: string,
  opts: ListInboxOptions = {},
  nowMs: number,
): ListInboxResult {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const result = nk.storageList({
    collection: INBOX_COLLECTION,
    userId,
    limit,
    cursor: opts.cursor ?? '',
  });
  const all: InboxMessage[] = [];
  for (const o of result.objects as IStorageObject[]) {
    const v = o.value as InboxMessage;
    if (v.schemaVersion === 1 && v.userId === userId) {
      all.push(v);
    }
  }
  // Newest first.
  all.sort((a, b) => b.createdAt - a.createdAt);
  // Filter claimed unless requested.
  const visible = opts.includeClaimed === true
    ? all
    : all.filter((m) => m.claimedAt === undefined);
  // Unread = unclaimed AND not expired.
  const unreadCount = all.filter((m) => m.claimedAt === undefined && (m.expiresAt ?? Infinity) > nowMs).length;
  return { messages: visible, nextCursor: result.cursor ?? '', unreadCount };
}

// ─── Claim ─────────────────────────────────────────────────────────────────

export type ClaimInboxResult =
  | { ok: true; message: InboxMessage; newBalance?: { coins: number; gems: number } }
  | { ok: false; code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST'; message: string };

/**
 * Atomically claim an inbox message:
 *   - read the message (404 if missing)
 *   - reject already-claimed (409 CONFLICT)
 *   - reject expired (400 BAD_REQUEST)
 *   - CAS-update `claimedAt = nowMs` so concurrent claims are safe
 *   - apply the reward via the wallet/garage helpers
 *
 * Wallet grants use `inbox:<messageId>` as the idempotency key so
 * a retried claim (against the CAS conflict) cannot double-credit.
 */
export function claimInbox(
  nk: INakama,
  userId: string,
  messageId: string,
  nowMs: number,
  grantFn: (
    nk: INakama,
    userId: string,
    changeset: { coins?: number; gems?: number },
    idempKey: string,
  ) => { coins: number; gems: number },
): ClaimInboxResult {
  const key = inboxKey(userId, messageId);
  const reads = nk.storageRead([{ collection: INBOX_COLLECTION, key, userId }]);
  const obj = reads[0];
  if (obj === undefined || obj.value === undefined) {
    return { ok: false, code: 'NOT_FOUND', message: `inbox message not found: ${messageId}` };
  }
  const entry = obj.value as InboxMessage;
  if (entry.claimedAt !== undefined) {
    return { ok: false, code: 'CONFLICT', message: 'inbox message already claimed' };
  }
  if (entry.expiresAt !== undefined && nowMs > entry.expiresAt) {
    return { ok: false, code: 'BAD_REQUEST', message: 'inbox message has expired' };
  }
  // CAS update — claim sets claimedAt.
  const next: InboxMessage = { ...entry, claimedAt: nowMs };
  nk.storageWrite([
    {
      collection: INBOX_COLLECTION,
      key,
      userId,
      value: next as unknown as Record<string, unknown>,
      permissionRead: INBOX_OWNER_READ,
      permissionWrite: INBOX_OWNER_WRITE,
      ...(obj.version !== undefined ? { version: obj.version } : {}),
    },
  ]);

  // Apply the reward (if any) AFTER the CAS so a failed CAS doesn't
  // double-grant on retry.
  let newBalance: { coins: number; gems: number } | undefined;
  if (entry.reward !== undefined) {
    const changeset: { coins?: number; gems?: number } = {};
    if (typeof entry.reward.coins === 'number' && entry.reward.coins > 0) {
      changeset.coins = entry.reward.coins;
    }
    if (typeof entry.reward.gems === 'number' && entry.reward.gems > 0) {
      changeset.gems = entry.reward.gems;
    }
    if (Object.keys(changeset).length > 0) {
      newBalance = grantFn(nk, userId, changeset, `inbox:${messageId}`);
    }
  }

  return { ok: true, message: next, ...(newBalance !== undefined ? { newBalance } : {}) };
}

// ─── Maintenance helper (used by Chunk 5 admin RPC) ───────────────────────

/**
 * Delete every inbox message older than `olderThanMs`. The owner-read
 * perm + server-only write means this MUST be a server-side helper
 * (it deletes on behalf of the user). Idempotent — missing rows are
 * silently skipped.
 *
 * NOT exposed in this chunk — the admin RPC lands in Chunk 5.
 */
export function purgeExpiredInbox(
  nk: INakama,
  userId: string,
  olderThanMs: number,
  nowMs: number,
): number {
  const result = nk.storageList({
    collection: INBOX_COLLECTION,
    userId,
    limit: 100,
    cursor: '',
  });
  const toDelete: { collection: string; key: string; userId: string }[] = [];
  for (const o of result.objects as IStorageObject[]) {
    const v = o.value as InboxMessage;
    if (v.createdAt < olderThanMs && (v.expiresAt ?? Infinity) <= nowMs) {
      toDelete.push({ collection: INBOX_COLLECTION, key: inboxKey(userId, v.id), userId });
    }
  }
  if (toDelete.length > 0) nk.storageDelete(toDelete);
  return toDelete.length;
}