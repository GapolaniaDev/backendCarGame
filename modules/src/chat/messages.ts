// Chat history storage (plan T-22; audit 07 f18, HT-69 Social 4).
//
//   chat_channels/{channelId}            — head row { lastSeq } (system-owned)
//   chat_history/{channelId}/{seq:12}    — one message per sequence number
//                                          (system-owned, write 0)
//
// A send takes the next sequence number of its channel: the head row and
// the message are written in ONE `storageWrite` (the head with CAS, the
// message create-only), retried on a lost CAS. Listing reads keys by
// number, newest first: a page is one batched read of `limit` keys and
// the cursor is the next sequence number to read. The old layout keyed
// messages by uuid and listed the first 1000 rows of the WHOLE collection
// (every channel), filtering in JS: old pages were unreachable and the
// cursor did not work.
//
// Retention: 7 days from `createdAt`, filtered on read. Sequence numbers
// grow with time, so the first expired message ends the history. A purged
// message (account deletion) leaves a gap the page just skips.

import type { INakama } from '../nkruntime';
import {
  CHAT_CHANNELS_COLLECTION,
  CHAT_HISTORY_SYSTEM_USER,
  CHAT_HISTORY_TTL_MS,
  asChatChannelWrite,
  asChatMessageWrite,
  chatMessageKey,
  CHAT_HISTORY_COLLECTION,
  type ChatChannelRecord,
  type ChatMessageCard,
  type ChatMessageRecord,
} from './types';

/** CAS attempts for the channel head (concurrent sends in one channel). */
const SEND_ATTEMPTS = 8;

// ─── Write ──────────────────────────────────────────────────────────────────

export interface ChatMessageWriteResult {
  message: ChatMessageRecord;
  expiresAt: number;
}

function readHead(nk: INakama, channelId: string): { record: ChatChannelRecord; version: string } | null {
  const obj = nk.storageRead([{ collection: CHAT_CHANNELS_COLLECTION, key: channelId, userId: CHAT_HISTORY_SYSTEM_USER }])[0];
  if (!obj) return null;
  const v = obj.value as Partial<ChatChannelRecord>;
  if (!v || v.schemaVersion !== 1 || typeof v.lastSeq !== 'number') return null;
  return { record: v as ChatChannelRecord, version: obj.version ?? '' };
}

/**
 * Append a message to its channel. `messageId` is expected to be a fresh
 * `nk.uuidv4()` from the caller (so the RPC can echo it back).
 *
 * Sender + content are validated upstream in `validateChatSend` — this
 * helper is the dumb-write leg. Throws when the channel head stays
 * contended for every attempt.
 */
export function writeChatMessageCreate(
  nk: INakama,
  message: Omit<ChatMessageRecord, 'schemaVersion' | 'expiresAt' | 'seq'> & { expiresAt?: number },
  nowMs: number,
): ChatMessageWriteResult {
  const expiresAt = message.expiresAt ?? nowMs + CHAT_HISTORY_TTL_MS;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
    const head = readHead(nk, message.channelId);
    const seq = (head?.record.lastSeq ?? 0) + 1;
    const full: ChatMessageRecord = {
      schemaVersion: 1,
      messageId: message.messageId,
      seq,
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
    try {
      nk.storageWrite([
        asChatChannelWrite({ schemaVersion: 1, channelId: message.channelId, lastSeq: seq }, head?.version ?? '*'),
        asChatMessageWrite(full),
      ]);
      return { message: full, expiresAt };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`chat send: channel head contended (${message.channelId})`);
}

// ─── List ───────────────────────────────────────────────────────────────────

export interface ListChatMessagesOptions {
  limit?: number;
  /** Sequence number to start from (the previous page's `nextCursor`). */
  cursor?: string;
  /** Senders whose messages are left out (blocks of the reader). */
  hideSenders?: ReadonlySet<string>;
}

export interface ListChatMessagesResult {
  messages: ChatMessageCard[];
  /** Next (older) page; '' when there is none. */
  nextCursor: string;
  /** How many were filtered out as expired (diagnostics). */
  expiredFiltered: number;
}

/** Parse a `chat_list` cursor; `null` when malformed. */
export function parseChatCursor(cursor: string): number | null {
  if (!/^[0-9]{1,15}$/.test(cursor)) return null;
  const n = Number(cursor);
  return n >= 1 ? n : null;
}

function parseRecord(value: unknown): ChatMessageRecord | null {
  const v = value as Partial<ChatMessageRecord> | null;
  if (
    !v || typeof v !== 'object' || v.schemaVersion !== 1 ||
    typeof v.messageId !== 'string' ||
    typeof v.content !== 'string' ||
    typeof v.senderUserId !== 'string' ||
    typeof v.channelId !== 'string' ||
    typeof v.seq !== 'number'
  ) {
    return null;
  }
  return v as ChatMessageRecord;
}

/**
 * One page of a channel, newest first (default 50, max 100). Throws
 * `RangeError` on a malformed cursor.
 */
export function listChatMessages(
  nk: INakama,
  channelId: string,
  opts: ListChatMessagesOptions,
  nowMs: number,
): ListChatMessagesResult {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const empty: ListChatMessagesResult = { messages: [], nextCursor: '', expiredFiltered: 0 };

  const head = readHead(nk, channelId);
  if (head === null) return empty;
  let start = head.record.lastSeq;
  if (opts.cursor !== undefined && opts.cursor !== '') {
    const n = parseChatCursor(opts.cursor);
    if (n === null) throw new RangeError('invalid cursor');
    start = Math.min(n, head.record.lastSeq);
  }
  if (start < 1) return empty;

  const low = Math.max(1, start - limit + 1);
  const keys = [];
  for (let seq = start; seq >= low; seq--) {
    keys.push({ collection: CHAT_HISTORY_COLLECTION, key: chatMessageKey(channelId, seq), userId: CHAT_HISTORY_SYSTEM_USER });
  }
  const bySeq = new Map<number, ChatMessageRecord>();
  for (const o of nk.storageRead(keys)) {
    const rec = parseRecord(o.value);
    if (rec !== null && rec.channelId === channelId) bySeq.set(rec.seq, rec);
  }

  const cards: ChatMessageCard[] = [];
  let expiredFiltered = 0;
  let ended = false;
  for (let seq = start; seq >= low; seq--) {
    const m = bySeq.get(seq);
    if (m === undefined) continue;
    if (m.expiresAt !== undefined && nowMs > m.expiresAt) {
      // Everything older expired too.
      expiredFiltered += 1;
      ended = true;
      break;
    }
    if (opts.hideSenders?.has(m.senderUserId)) continue;
    cards.push({
      messageId: m.messageId,
      senderUserId: m.senderUserId,
      senderName: m.senderName,
      content: m.content,
      language: m.language,
      ts: m.createdAt,
    });
  }

  return {
    messages: cards,
    nextCursor: !ended && low > 1 ? String(low - 1) : '',
    expiredFiltered,
  };
}
