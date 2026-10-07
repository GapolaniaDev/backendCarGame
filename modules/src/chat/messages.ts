// Phase 7 Chunk 6 — Chat history storage helpers.
//
// `chat_history/{channelId}/{messageId}` = ChatMessageRecord. Server-only
// writes (Write=0). The TTL is set on write so the storage layer
// auto-expires the message after 7 days — the list helper also drops
// expired rows as a belt-and-braces filter (the runtime's expiry is
// eventually consistent).
//
// Listing strategy:
//   `nk.storageList({collection: 'chat_history', limit, cursor})` — no
//   userId filter (messages aren't user-owned). We filter by
//   `key.startsWith(channelId + '/')` in JS. At expected scale (a few
//   hundred messages / channel / week) the in-memory filter is cheap.

import type { IStorageObject, INakama } from '../nkruntime';
import {
  CHAT_HISTORY_COLLECTION,
  CHAT_HISTORY_SYSTEM_USER,
  CHAT_HISTORY_TTL_MS,
  asChatMessageWrite,
  type ChatMessageCard,
  type ChatMessageRecord,
} from './types';

// ─── Write ──────────────────────────────────────────────────────────────────

export interface ChatMessageWriteResult {
  message: ChatMessageRecord;
  expiresAt: number;
}

/**
 * Insert a chat message with the configured TTL. `messageId` is
 * expected to be a fresh `nk.uuidv4()` from the caller (so the RPC
 * can echo it back to the client immediately).
 *
 * Sender + content are validated upstream in `validateChatSend` — this
 * helper is the dumb-write leg.
 */
export function writeChatMessageCreate(
  nk: INakama,
  message: Omit<ChatMessageRecord, 'schemaVersion' | 'expiresAt'> & { expiresAt?: number },
  nowMs: number,
): ChatMessageWriteResult {
  const expiresAt = message.expiresAt ?? nowMs + CHAT_HISTORY_TTL_MS;
  const full: ChatMessageRecord = {
    schemaVersion: 1,
    messageId: message.messageId,
    channelId: message.channelId,
    channelType: message.channelType,
    targetId: message.targetId,
    senderUserId: message.senderUserId,
    senderName: message.senderName,
    content: message.content,
    language: message.language,
    createdAt: message.createdAt,
    expiresAt,
  };
  const obj: IStorageObject = {
    ...asChatMessageWrite(full),
    expiresAt: new Date(expiresAt).toISOString(),
  };
  nk.storageWrite([obj]);
  return { message: full, expiresAt };
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Read a single chat message by channelId + messageId. Returns `null`
 * when absent OR expired (lazy TTL).
 */
export function readChatMessage(
  nk: INakama,
  channelId: string,
  messageId: string,
  nowMs: number,
): ChatMessageRecord | null {
  const key = `${channelId}/${messageId}`;
  const objs = nk.storageRead([
    { collection: CHAT_HISTORY_COLLECTION, key, userId: CHAT_HISTORY_SYSTEM_USER },
  ]);
  const obj = objs[0];
  if (!obj) return null;
  const v = obj.value as Partial<ChatMessageRecord>;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.messageId !== 'string' ||
    typeof v.channelId !== 'string' ||
    typeof v.content !== 'string'
  ) {
    return null;
  }
  if (v.expiresAt !== undefined && nowMs > v.expiresAt) return null;
  return v as ChatMessageRecord;
}

/** @deprecated Use `CHAT_HISTORY_SYSTEM_USER` from `./types`. */
const SYSTEM_USER_SENTINEL = CHAT_HISTORY_SYSTEM_USER;

// ─── List ───────────────────────────────────────────────────────────────────

export interface ListChatMessagesOptions {
  limit?: number;
  cursor?: string;
}

export interface ListChatMessagesResult {
  messages: ChatMessageCard[];
  nextCursor: string;
  /** How many were filtered out as expired (diagnostics). */
  expiredFiltered: number;
}

/**
 * List messages for a single channel, newest first. Filters expired
 * messages (belt-and-braces — the storage layer's TTL is eventually
 * consistent). Capped at `limit` (default 50, max 100).
 *
 * Cursor is passed through to `nk.storageList`. The stub returns
 * `cursor: ''` regardless; in production it round-trips for true
 * pagination.
 */
export function listChatMessages(
  nk: INakama,
  channelId: string,
  opts: ListChatMessagesOptions,
  nowMs: number,
): ListChatMessagesResult {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const cursor = opts.cursor ?? '';

  // List with a generous page limit — we filter in JS. Production
  // storageList has its own pagination; we pass `limit` through so the
  // round-trip stays bounded.
  const res = nk.storageList({
    collection: CHAT_HISTORY_COLLECTION,
    limit: 1000,
    cursor,
  });

  const keyPrefix = `${channelId}/`;
  const filtered: ChatMessageRecord[] = [];
  let expiredFiltered = 0;
  for (const o of res.objects) {
    if (!o.key.startsWith(keyPrefix)) continue;
    const v = o.value as Partial<ChatMessageRecord>;
    if (
      !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
      typeof v.messageId !== 'string' ||
      typeof v.content !== 'string' ||
      typeof v.senderUserId !== 'string' ||
      typeof v.channelId !== 'string'
    ) {
      continue;
    }
    const full = v as ChatMessageRecord;
    if (full.expiresAt !== undefined && nowMs > full.expiresAt) {
      expiredFiltered += 1;
      continue;
    }
    filtered.push(full);
  }

  // Newest first.
  filtered.sort((a, b) => b.createdAt - a.createdAt);

  const page = filtered.slice(0, limit);
  const cards: ChatMessageCard[] = page.map((m) => ({
    messageId: m.messageId,
    senderUserId: m.senderUserId,
    senderName: m.senderName,
    content: m.content,
    language: m.language,
    ts: m.createdAt,
  }));

  return {
    messages: cards,
    nextCursor: res.cursor ?? '',
    expiredFiltered,
  };
}