// The player's inbox — the ONLY inbox (plan T-17, audit 04 f3-f4).
//
// Everything the server sends a player lands here and is read by
// `inbox_list` / `inbox_claim`:
//   - claimable rewards (`kind: 'reward'`, `reward` set): admin messages,
//     club week prizes and ranked season rewards. `inbox_claim` pays them;
//   - notices (`kind: 'system'`, no `reward`): rewards the server already
//     delivered when it sent the message (tournament prizes and refunds,
//     event bonuses, IAP, ads, subscriptions), with `granted` describing
//     them. Claiming a notice only acknowledges it.
// `liveops/inbox.ts` is the adapter the reward senders call; the old
// `liveops_inbox` collection is migrated at boot (`inbox_migration.ts`).
//
// Storage layout:
//   collection: `inbox`
//   key:        `${userId}/${messageId}`, or `${userId}/sha256:<hex>` when
//               that passes Nakama's 128-character key limit
//   userId:     `userId` (owner)
//   permissionRead:  1 (owner)
//   permissionWrite: 0 (server-only) — clients claim via RPC
//
// Decisions enforced here:
//   D3 retention: 30 days from `createdAt`. Expired messages are
//      filtered from the unread count and rejected by `claimInbox`.
//   D13 idempotency: `messageId` is deterministic per reward. A duplicate
//      send for the same id is ignored (create-only write); a claim pays
//      exactly once: the payout, the garage delivery and `claimedAt` are
//      ONE wallet movement (`moveWallet`, durable key `inbox:<messageId>`).
//      If it fails nothing is written and the message stays claimable.

import type { ILogger, IStorageObject, INakama } from '../nkruntime';
import { listStorage } from '../core/storage';
import { moveWallet, type WalletMove } from '../economy/wallet';
import { addCarToGarage, addCosmeticToBag, defaultGarage, garageWrite, readGarageObject } from '../garage/storage';
import { getCarsCatalog, getCosmeticsCatalog } from '../garage/catalog';
import type { Garage } from '../garage/types';
import type { ErrorCode } from '../core/errors';

export const INBOX_COLLECTION = 'inbox';
export const INBOX_OWNER_READ = 1;
export const INBOX_OWNER_WRITE = 0;
export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_KEY_LENGTH = 128;
const CLAIM_ATTEMPTS = 3;

export type InboxKind = 'reward' | 'system';

export interface InboxRewardPayload {
  coins?: number;
  gems?: number;
  cosmeticId?: string;
  /** Additive: every cosmetic when a reward carries more than one (`cosmeticId` is the first). */
  cosmeticIds?: string[];
  carId?: string;
}

export interface InboxMessage {
  schemaVersion: 1;
  id: string;
  userId: string;
  kind: InboxKind;
  title: string;
  body: string;
  /** Claimable reward, paid by `inbox_claim`. */
  reward?: InboxRewardPayload;
  /** Additive: what the server already delivered when it sent a notice. */
  granted?: InboxRewardPayload;
  /** Additive: the sender's reward type (`season_gold`, `tournament_prize`, …). */
  source?: string;
  /** Epoch-ms when the message expires (TTL 30d from createdAt). */
  expiresAt?: number;
  /** Epoch-ms when the message was claimed (set by `claimInbox`). */
  claimedAt?: number;
  createdAt: number;
}

/** Storage key of a message: `${userId}/${messageId}`, hashed past 128 characters. */
export function inboxKey(nk: INakama, userId: string, messageId: string): string {
  const plain = `${userId}/${messageId}`;
  return plain.length <= MAX_KEY_LENGTH ? plain : `${userId}/sha256:${nk.sha256Hash(messageId)}`;
}

// ─── Send ──────────────────────────────────────────────────────────────────

export interface SendInboxResult {
  inserted: boolean;
  message: InboxMessage;
}

/**
 * Idempotently insert a new inbox message: a message with the same id
 * already there is returned untouched (`inserted: false`), so senders can
 * re-run safely and a claimed reward is never re-armed.
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
  const key = inboxKey(nk, userId, message.id);
  const existing = nk.storageRead([{ collection: INBOX_COLLECTION, key, userId }])[0];
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
    ...(message.granted !== undefined ? { granted: message.granted } : {}),
    ...(message.source !== undefined ? { source: message.source } : {}),
    ...(message.claimedAt !== undefined ? { claimedAt: message.claimedAt } : {}),
    createdAt: nowMs,
    expiresAt: message.expiresAt ?? nowMs + INBOX_RETENTION_MS,
  };

  try {
    nk.storageWrite([
      {
        collection: INBOX_COLLECTION,
        key,
        userId,
        value: full as unknown as Record<string, unknown>,
        permissionRead: INBOX_OWNER_READ,
        permissionWrite: INBOX_OWNER_WRITE,
        // Create-only: a concurrent send of the same id loses here.
        version: '*',
      },
    ]);
  } catch (e) {
    const now = nk.storageRead([{ collection: INBOX_COLLECTION, key, userId }])[0];
    if (now?.value !== undefined) return { inserted: false, message: now.value as InboxMessage };
    throw e;
  }
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
  const result = listStorage(nk, {
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

export interface InboxDelivered {
  carId?: string;
  cosmeticId?: string;
  /** Additive: every cosmetic delivered when there was more than one. */
  cosmeticIds?: string[];
}

export type ClaimInboxResult =
  | {
    ok: true;
    message: InboxMessage;
    newBalance?: { coins: number; gems: number };
    delivered?: InboxDelivered;
    /** Additive: reward items missing from the catalog, so not delivered (logged as errors). */
    undelivered?: string[];
  }
  | { ok: false; code: ErrorCode; message: string; details?: unknown };

/**
 * Claim an inbox message exactly once. The currencies, the garage items
 * and `claimedAt` go in ONE `moveWallet` transaction with the message's
 * version: two concurrent claims pay once (the loser gets `CONFLICT`),
 * and a failed payout writes nothing, so the message stays claimable
 * (audit 04 f4). A lost garage CAS is retried with a fresh read.
 */
export function claimInbox(
  nk: INakama,
  logger: ILogger,
  userId: string,
  messageId: string,
  nowMs: number,
): ClaimInboxResult {
  const key = inboxKey(nk, userId, messageId);
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
    const obj = nk.storageRead([{ collection: INBOX_COLLECTION, key, userId }])[0];
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

    const claimed: InboxMessage = { ...entry, claimedAt: nowMs };
    const writes: IStorageObject[] = [{
      collection: INBOX_COLLECTION,
      key,
      userId,
      value: claimed as unknown as Record<string, unknown>,
      permissionRead: INBOX_OWNER_READ,
      permissionWrite: INBOX_OWNER_WRITE,
      version: obj.version ?? '*',
    }];

    const delivery = planDelivery(nk, userId, entry.reward, nowMs);
    if (delivery.garageWrite !== null) writes.push(delivery.garageWrite);
    for (const missing of delivery.undelivered) {
      logger.error('inbox_claim user=%s message=%s: reward item not in catalog: %s', userId, messageId, missing);
    }

    const changeset: Record<string, number> = {};
    for (const currency of ['coins', 'gems'] as const) {
      const amount = entry.reward?.[currency];
      if (typeof amount === 'number' && Number.isInteger(amount) && amount > 0) changeset[currency] = amount;
    }
    const moves: WalletMove[] = Object.keys(changeset).length > 0
      ? [{ changeset, metadata: { reason: 'inbox', sourceId: messageId } }]
      : [];

    const moved = moveWallet(nk, userId, `inbox:${messageId}`, moves, { extraWrites: writes });
    if (moved.ok) {
      if (moved.data.replayed) {
        return { ok: false, code: 'CONFLICT', message: 'inbox message already claimed' };
      }
      return {
        ok: true,
        message: claimed,
        ...(moves.length > 0 ? { newBalance: moved.data.balance } : {}),
        ...(Object.keys(delivery.delivered).length > 0 ? { delivered: delivery.delivered } : {}),
        ...(delivery.undelivered.length > 0 ? { undelivered: delivery.undelivered } : {}),
      };
    }
    if (moved.error.code !== 'CONFLICT') {
      return { ok: false, code: moved.error.code, message: `${moved.error.message} — the message is still claimable`, details: moved.error.details };
    }
    // A concurrent claim (message CAS) or garage write (garage CAS) won:
    // re-read; a claimed message answers CONFLICT on the next pass.
    logger.warn('inbox_claim CAS lost user=%s message=%s attempt=%d', userId, messageId, attempt);
  }
  return {
    ok: false,
    code: 'CONFLICT',
    message: 'concurrent update; nothing was paid and the message is still claimable, please retry',
    details: { reason: 'VERSION_CONFLICT' },
  };
}

interface DeliveryPlan {
  garageWrite: IStorageObject | null;
  delivered: InboxDelivered;
  undelivered: string[];
}

/** Garage items of a reward: the garage CAS write (or create) and what it adds. */
function planDelivery(nk: INakama, userId: string, reward: InboxRewardPayload | undefined, nowMs: number): DeliveryPlan {
  const plan: DeliveryPlan = { garageWrite: null, delivered: {}, undelivered: [] };
  if (reward === undefined) return plan;
  const cosmetics = reward.cosmeticIds ?? (reward.cosmeticId !== undefined ? [reward.cosmeticId] : []);
  const carId = typeof reward.carId === 'string' && reward.carId.length > 0 ? reward.carId : undefined;
  if (carId === undefined && cosmetics.length === 0) return plan;

  const read = readGarageObject(nk, userId);
  let garage: Garage = read?.value ?? defaultGarage(userId, nowMs);
  const before = garage;

  if (carId !== undefined) {
    const car = getCarsCatalog().cars.find((c) => c.id === carId);
    if (!car) plan.undelivered.push(`car:${carId}`);
    else if (!garage.cars.some((c) => c.carId === carId)) {
      garage = addCarToGarage(garage, car);
      plan.delivered.carId = carId;
    }
  }
  const deliveredCosmetics: string[] = [];
  for (const id of cosmetics) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (!getCosmeticsCatalog().items.some((c) => c.id === id)) {
      plan.undelivered.push(`cosmetic:${id}`);
      continue;
    }
    if (garage.cosmeticsBag.includes(id)) continue;
    garage = addCosmeticToBag(garage, id);
    deliveredCosmetics.push(id);
  }
  if (deliveredCosmetics.length > 0) {
    plan.delivered.cosmeticId = deliveredCosmetics[0] as string;
    if (deliveredCosmetics.length > 1) plan.delivered.cosmeticIds = deliveredCosmetics;
  }
  if (garage !== before) plan.garageWrite = garageWrite(garage, read?.version ?? '*');
  return plan;
}

// ─── Maintenance helper (admin cleanup) ─────────────────────────────────────

/**
 * Delete every inbox message older than `olderThanMs` that has expired.
 * Server-only write, so this is a server-side helper. Idempotent.
 */
export function purgeExpiredInbox(
  nk: INakama,
  userId: string,
  olderThanMs: number,
  nowMs: number,
): number {
  const result = listStorage(nk, {
    collection: INBOX_COLLECTION,
    userId,
    limit: 100,
    cursor: '',
  });
  const toDelete: { collection: string; key: string; userId: string }[] = [];
  for (const o of result.objects as IStorageObject[]) {
    const v = o.value as InboxMessage;
    if (v.createdAt < olderThanMs && (v.expiresAt ?? Infinity) <= nowMs) {
      toDelete.push({ collection: INBOX_COLLECTION, key: o.key, userId });
    }
  }
  if (toDelete.length > 0) nk.storageDelete(toDelete);
  return toDelete.length;
}
