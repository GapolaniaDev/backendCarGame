// Phase 7 Chunk 6 — Chat types + channel-id helpers.
//
// Two channels are supported:
//   - `club:<groupId>`           — only members of the Nakama group
//                                  can send/receive. targetId is the
//                                  groupId (= clubId).
//   - `direct:<sortedA>:<sortedB>` — only the two participants (mutual
//                                  friends). targetId is the peer's
//                                  userId; the channelId is computed
//                                  by sorting both sides so A↔B and
//                                  B↔A resolve to the same channel.
//
// Storage keys:
//   chat_history/{channelId}/{messageId}
//   chat_rate/{userId}
//   silenced/{userId}
//
// All three are server-only write. Chat_history reads/writes are
// channel-scoped (no userId filter — the server is the only authority).
// chat_rate + silenced are owner-scoped (userId === owner).
//
// ChatRetention: 7 days from `createdAt`. Expired messages are filtered
// from `listMessages` (lazy purge — the runtime's TTL is also set on
// write so they auto-expire at the storage layer too).

import type { IStorageObject } from '../nkruntime';

export type ChatChannelType = 'club' | 'direct';

export type ChatLanguage = 'es' | 'en' | 'pt';

export const CHAT_LANGUAGES: ReadonlyArray<ChatLanguage> = ['es', 'en', 'pt'];

export const CHAT_HISTORY_COLLECTION = 'chat_history';
export const CHAT_RATE_COLLECTION = 'chat_rate';
export const SILENCED_COLLECTION = 'silenced';

export const CHAT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CHAT_HISTORY_RETENTION_DAYS = 7;
export const CHAT_MAX_CONTENT_LEN = 200;

/** Chat rate limit (spec D2): 1 msg/s, 20 msg/min per user. */
export const CHAT_RATE_PER_SECOND_LIMIT = 1;
export const CHAT_RATE_PER_MINUTE_LIMIT = 20;
export const CHAT_RATE_SECOND_WINDOW_MS = 1000;
export const CHAT_RATE_MINUTE_WINDOW_MS = 60_000;

// ─── Channel id resolution ──────────────────────────────────────────────────

/**
 * Compute the stable channel id for a club channel.
 */
export function clubChannelId(groupId: string): string {
  return `club:${groupId}`;
}

/**
 * Compute the stable channel id for a direct (peer) channel.
 * Sorts both sides so A↔B and B↔A resolve to the same id.
 */
export function directChannelId(userIdA: string, userIdB: string): string {
  if (userIdA === userIdB) {
    throw new Error('directChannelId: cannot chat with yourself');
  }
  const sorted = [userIdA, userIdB].sort();
  return `direct:${sorted[0]}:${sorted[1]}`;
}

/**
 * Decode a channel id back into (type, targetId). `targetId` is
 * - for `club`:    the groupId (= clubId)
 * - for `direct`:  the canonical 'sortedA:sortedB' tail
 * Returns `null` when the channel id is malformed.
 */
export function parseChannelId(
  channelId: string,
): { type: ChatChannelType; targetId: string } | null {
  if (channelId.startsWith('club:')) {
    return { type: 'club', targetId: channelId.slice('club:'.length) };
  }
  if (channelId.startsWith('direct:')) {
    return { type: 'direct', targetId: channelId.slice('direct:'.length) };
  }
  return null;
}

/**
 * Storage key for a single chat message: `${channelId}/${messageId}`.
 * Channel-scoped (does NOT include userId — chat history is shared by
 * participants, not owned by a single user).
 */
export function chatMessageKey(channelId: string, messageId: string): string {
  return `${channelId}/${messageId}`;
}

/**
 * Sentinel userId used for `chat_history` storage rows. Chat messages
 * have no meaningful per-user owner (the channel is the unit), so we
 * park the rows under the system sentinel. `permissionRead=1` then
 * means "system-only read" — clients cannot list the collection
 * directly and must go through `chat_list`. `permissionWrite=0`
 * prevents client-side spoofing of `senderUserId`.
 */
export const CHAT_HISTORY_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/**
 * One chat message. Server-only writes (RPC `chat_send`). The
 * `senderUserId` + `senderName` are denormalized so `chat_list`
 * doesn't have to fan-out to `nk.usersGetId` for every message.
 */
export interface ChatMessageRecord {
  schemaVersion: 1;
  messageId: string;
  channelId: string;
  channelType: ChatChannelType;
  /**
   * For `club`: the groupId. For `direct`: the sorted
   * 'sortedA:sortedB' tail. Stored for cheap list-render without
   * re-parsing channelId.
   */
  targetId: string;
  senderUserId: string;
  senderName: string;
  content: string;
  language: ChatLanguage;
  /** Epoch-ms when the message was sent. */
  createdAt: number;
  /** Epoch-ms when the message expires (= createdAt + TTL). */
  expiresAt: number;
}

/** Shape returned by `chat_list` to the client (no schema field). */
export interface ChatMessageCard {
  messageId: string;
  senderUserId: string;
  senderName: string;
  content: string;
  language: ChatLanguage;
  ts: number;
}

/**
 * Per-user chat rate-limit row. Used to enforce 1/s + 20/min. Owned by
 * the user (so they can read their own if needed) but only the server
 * writes (Write=0) — clients can NOT reset their rate by writing
 * directly.
 */
export interface ChatRateRecord {
  schemaVersion: 1;
  userId: string;
  /** Epoch-ms of the last accepted send. */
  tsLast: number;
  /** Count of sends inside the current minute window. */
  countWindow: number;
  /** Epoch-ms when the current minute window started. */
  windowStartTs: number;
}

/**
 * Silenced row (server-only write — produced by the reports system in
 * Chunk 7). Owned by the user so the storage layer scopes queries by
 * userId cleanly, but only the server can write (Write=0).
 */
export interface SilencedRecord {
  schemaVersion: 1;
  userId: string;
  /** Epoch-ms when the silence lifts. */
  untilUtc: number;
  /** Why the user was silenced (e.g. 'auto:3_reports_24h'). */
  reason: string;
  /** Epoch-ms when the row was created. */
  createdAt: number;
}

// ─── Storage write helpers ──────────────────────────────────────────────────

export function asChatMessageWrite(rec: ChatMessageRecord): IStorageObject {
  return {
    collection: CHAT_HISTORY_COLLECTION,
    key: chatMessageKey(rec.channelId, rec.messageId),
    userId: CHAT_HISTORY_SYSTEM_USER, // system-owned (shared across participants)
    value: rec as unknown as unknown as Record<string, unknown>,
    permissionRead: 1, // system-only read — clients must go through RPC
    permissionWrite: 0, // server-only writes
  };
}

export function asChatRateWrite(rec: ChatRateRecord): IStorageObject {
  return {
    collection: CHAT_RATE_COLLECTION,
    key: rec.userId,
    userId: rec.userId,
    value: rec as unknown as unknown as Record<string, unknown>,
    permissionRead: 1, // owner-read
    permissionWrite: 0, // server-only writes
  };
}

export function asSilencedWrite(rec: SilencedRecord): IStorageObject {
  return {
    collection: SILENCED_COLLECTION,
    key: rec.userId,
    userId: rec.userId,
    value: rec as unknown as unknown as Record<string, unknown>,
    permissionRead: 1, // owner-read
    permissionWrite: 0, // server-only writes
  };
}