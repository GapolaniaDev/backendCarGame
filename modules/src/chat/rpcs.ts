// Phase 7 Chunk 6 — Chat RPCs + the synchronous "validateChatSend" helper.
//
// Two RPCs:
//   - chat_send         — write a single message after running
//                         `validateChatSend` (rate + content + access)
//   - chat_list        — paginated read of one channel's history
//
// Before-send hook:
//   The spec calls for a `registerBeforeSendChannelMessage` hook, but
//   that API is NOT in the Nakama 3.27 JS runtime (verified against
//   `modules/src/nkruntime.d.ts` — no entry). We fall back to calling
//   `validateChatSend(...)` synchronously from `chat_send` BEFORE the
//   storage write. Same pattern as Chunks 2/3/5 (other 3.27 JS gaps).
//
// Both RPCs gate on `assertNotInMaintenance` (chat_send MUST, chat_list
// follows the social pattern — maintenance blocks new sends but
// players can still read history, same as `inbox_list`).
//
// Errors:
//   - chat_send:
//     BAD_REQUEST      (missing fields, length, invalid language, self-chat)
//     RATE_LIMITED     (1/s, 20/min, or per-RPC 30/min)
//     CONTENT_REJECTED (blocked word — plan T-22; it was FORBIDDEN)
//     FORBIDDEN        (silenced, not member / not friend, a block between
//                       the two players: `details.reason = 'BLOCKED'`)
//     NOT_FOUND        (club / peer not resolvable)
//   - chat_list:
//     BAD_REQUEST    (missing fields, malformed cursor)
//     FORBIDDEN      (not member / not friend)
//     NOT_FOUND      (channel target missing)
//
// Blocks (plan T-22; audit 07 f3, 7.2.7): a direct message needs no
// block either way (`checkChatSendBlock`); a club history hides the
// messages of senders that have a block with the reader.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { readFriendEdge } from '../social/friends_repo';
import { listGroupMemberIds, readMember } from '../clubs/members_repo';
import { blockedEitherWaySet } from '../social/blocks_repo';
import { usernamesById } from '../leaderboards/usernames';
import { checkChatSendBlock } from './before_send';
import { containsBlockedWord } from './blocked_words';
import { checkChatRateLimit } from './rate_limit';
import { getSilencedStatus } from './silenced';
import { listChatMessages, writeChatMessageCreate } from './messages';
import {
  CHAT_LANGUAGES,
  CHAT_MAX_CONTENT_LEN,
  clubChannelId,
  directChannelId,
  type ChatChannelType,
  type ChatLanguage,
  type ChatMessageCard,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Per-RPC rate limits (coarse, global — separate from chat-specific) ──

const CHAT_RPC_RATE_LIMITS = {
  chat_send: { maxPerWindow: 30, windowSec: 60 },
  chat_list: { maxPerWindow: 60, windowSec: 60 },
} as const;

// ─── Caller plumbing ────────────────────────────────────────────────────────



function parseBody(body: string):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }
{
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as Record<string, unknown> };
}

function checkRpcRateLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof CHAT_RPC_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = CHAT_RPC_RATE_LIMITS[rpcName];
  const verdict = checkRateLimit(nk, {
    rpcName,
    userId,
    maxPerWindow: opts.maxPerWindow,
    windowSec: opts.windowSec,
  });
  if (!verdict.allowed) {
    logger.warn(
      '%s rate limit exceeded user=%s %d/%d',
      rpcName, userId, verdict.count, verdict.limit,
    );
    return err(
      'RATE_LIMITED',
      `${rpcName} rate limit exceeded (${verdict.count}/${verdict.limit})`,
    );
  }
  return null;
}

// ─── validateChatSend (synchronous before-send helper) ──────────────────────

export interface ChatSendInput {
  channelType: ChatChannelType;
  targetId: string;
  language: ChatLanguage;
  content: string;
}

export interface ValidateChatSendOk {
  ok: true;
  channelId: string;
  /**
   * True when the caller was already on the rate-limited rejection
   * path for a `too_fast` verdict — the RPC DOES NOT proceed to write
   * in that case, but the verifier needs the signal for tests.
   */
  rateAllowed: true;
}
export interface ValidateChatSendErr {
  ok: false;
  code:
    | 'BAD_REQUEST'
    | 'CONTENT_REJECTED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'RATE_LIMITED';
  message: string;
  details?: unknown;
}

export type ValidateChatSendResult = ValidateChatSendOk | ValidateChatSendErr;

/**
 * Synchronous pre-write validator. Mirrors the spec's before_send
 * checklist (1..6):
 *
 *   1. Chat rate limit (1/s, 20/min)        → RATE_LIMITED
 *   2. Length ≤ 200                          → BAD_REQUEST
 *   3. Blocked words (per language)          → CONTENT_REJECTED
 *   4. Silenced status (untilUtc > nowMs)    → FORBIDDEN (+ details)
 *   5. Channel resolution + access:
 *        - club:   readMember(clubId, caller) → FORBIDDEN if absent
 *        - direct: readFriendEdge(caller, peerId) → FORBIDDEN if absent,
 *                  and no block either way (`checkChatSendBlock`)
 *
 * Returns `{ ok: true, channelId }` when all checks pass. The RPC then
 * writes the message + emits + returns. Storage is NOT touched here so
 * the rate-limit's "no cost to same call when too_fast" guarantee holds
 * (verified in the rate-limit helper).
 */
export function validateChatSend(
  nk: INakama,
  logger: ILogger,
  callerId: string,
  input: ChatSendInput,
  nowMs: number,
): ValidateChatSendResult {
  // 1. Chat rate limit (1/s, 20/min).
  const rl = checkChatRateLimit(nk, logger, callerId, nowMs);
  if (!rl.allowed) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: `chat rate limit exceeded (${rl.reason})`,
      details: { reason: rl.reason },
    };
  }

  // 2. Length + content sanity.
  if (typeof input.content !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', message: 'content is required' };
  }
  if (input.content.length === 0) {
    return { ok: false, code: 'BAD_REQUEST', message: 'content is required' };
  }
  if (input.content.length > CHAT_MAX_CONTENT_LEN) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `content too long (max ${CHAT_MAX_CONTENT_LEN})`,
      details: { length: input.content.length, max: CHAT_MAX_CONTENT_LEN },
    };
  }
  if (input.channelType !== 'club' && input.channelType !== 'direct') {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'channelType must be club or direct',
    };
  }
  if (!CHAT_LANGUAGES.includes(input.language)) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `language must be one of: ${CHAT_LANGUAGES.join(', ')}`,
    };
  }
  if (typeof input.targetId !== 'string' || input.targetId.length === 0) {
    return { ok: false, code: 'BAD_REQUEST', message: 'targetId is required' };
  }

  // 3. Blocked words.
  if (containsBlockedWord(input.content, input.language)) {
    return {
      ok: false,
      code: 'CONTENT_REJECTED',
      message: 'content contains a blocked word',
    };
  }

  // 4. Silenced.
  const sil = getSilencedStatus(nk, callerId, nowMs);
  if (sil.silenced) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'user is silenced',
      details: { untilUtc: sil.untilUtc, reason: sil.reason },
    };
  }

  // 5. Channel resolution + access.
  if (input.channelType === 'club') {
    const clubId = input.targetId;
    const member = readMember(nk, clubId, callerId);
    if (member === null) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'not a member of this club',
      };
    }
    return { ok: true, channelId: clubChannelId(clubId), rateAllowed: true };
  }

  // direct
  const peerId = input.targetId;
  if (peerId === callerId) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'cannot chat with yourself',
    };
  }
  const edge = readFriendEdge(nk, callerId, peerId);
  if (edge === null) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'not friends with target user',
    };
  }
  const block = checkChatSendBlock(nk, logger, callerId, peerId);
  if (!block.allowed) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'cannot message this player',
      details: { reason: 'BLOCKED' },
    };
  }
  return {
    ok: true,
    channelId: directChannelId(callerId, peerId),
    rateAllowed: true,
  };
}

// ─── chat_send ──────────────────────────────────────────────────────────────

export interface ChatSendRpcInput {
  callerUserId: string;
  channelType: ChatChannelType;
  targetId: string;
  language: ChatLanguage;
  content: string;
}

export interface ChatSendRpcOutput {
  messageId: string;
  ts: number;
  channelId: string;
}

export function chat_send_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRateLimit(nk, logger, 'chat_send', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const input: ChatSendInput = {
    channelType: parsed.data['channelType'] as ChatChannelType,
    targetId: parsed.data['targetId'] as string,
    language: parsed.data['language'] as ChatLanguage,
    content: parsed.data['content'] as string,
  };
  const nowMs = Date.now();
  const verdict = validateChatSend(nk, logger, caller.id, input, nowMs);
  if (!verdict.ok) {
    return toJson(err(verdict.code, verdict.message, verdict.details));
  }

  // Resolve senderName (denormalized so chat_list is cheap). The 3.27
  // account object nests the username under `user`; the old read of
  // `accountGetId(...).username` was always undefined ('unknown').
  const senderName = usernamesById(logger, nk, [caller.id]).get(caller.id) ?? 'unknown';

  const messageId = nk.uuidv4();
  const targetIdForChannel =
    input.channelType === 'club'
      ? input.targetId
      : directChannelId(caller.id, input.targetId).slice('direct:'.length);

  let write;
  try {
    write = writeChatMessageCreate(
      nk,
      {
        messageId,
        channelId: verdict.channelId,
        channelType: input.channelType,
        targetId: targetIdForChannel,
        senderUserId: caller.id,
        senderName,
        content: input.content,
        language: input.language,
        createdAt: nowMs,
      },
      nowMs,
    );
  } catch (e) {
    logger.warn('chat_send: write failed: %s', e instanceof Error ? e.message : String(e));
    return toJson(err('CONFLICT', 'the channel is busy; please retry'));
  }

  emit(
    nk,
    logger,
    'chat_sent',
    {
      channelType: input.channelType,
      targetId: input.targetId,
      channelId: verdict.channelId,
      messageId,
      length: input.content.length,
      language: input.language,
    },
    { userId: caller.id },
  );

  const out: ChatSendRpcOutput = {
    messageId: write.message.messageId,
    ts: write.message.createdAt,
    channelId: write.message.channelId,
  };
  return toJson(ok(out));
}

// ─── chat_list ──────────────────────────────────────────────────────────────

export interface ChatListRpcInput {
  callerUserId: string;
  channelType: ChatChannelType;
  targetId: string;
  limit?: number;
  cursor?: string;
}

export interface ChatListRpcOutput {
  messages: ChatMessageCard[];
  nextCursor: string;
}

export function chat_list_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRpcRateLimit(nk, logger, 'chat_list', caller.id);
  if (limit !== null) return toJson(limit);

  // NOT maintenance-gated — players must be able to read chat history
  // while the splash is shown (same rationale as inbox_list).

  const channelType = parsed.data['channelType'];
  const targetId = parsed.data['targetId'];
  if (channelType !== 'club' && channelType !== 'direct') {
    return toJson(err('BAD_REQUEST', 'channelType must be club or direct'));
  }
  if (typeof targetId !== 'string' || targetId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetId is required'));
  }

  // Channel access check — same as validateChatSend step 5.
  if (channelType === 'club') {
    const member = readMember(nk, targetId, caller.id);
    if (member === null) {
      return toJson(err('FORBIDDEN', 'not a member of this club'));
    }
  } else {
    if (targetId === caller.id) {
      return toJson(err('BAD_REQUEST', 'cannot chat with yourself'));
    }
    const edge = readFriendEdge(nk, caller.id, targetId);
    if (edge === null) {
      return toJson(err('FORBIDDEN', 'not friends with target user'));
    }
  }

  const channelId =
    channelType === 'club'
      ? clubChannelId(targetId)
      : directChannelId(caller.id, targetId);

  const limitN = typeof parsed.data['limit'] === 'number'
    ? Math.min(100, Math.max(1, Math.floor(parsed.data['limit'] as number)))
    : 50;
  const cursor = typeof parsed.data['cursor'] === 'string'
    ? (parsed.data['cursor'] as string)
    : '';

  // A club history hides the messages of senders that have a block with
  // the reader (a direct channel already requires no block to send).
  let hideSenders: ReadonlySet<string> | undefined;
  if (channelType === 'club') {
    const members = readMemberIdsSafe(nk, targetId);
    hideSenders = blockedEitherWaySet(nk, caller.id, members);
  }

  const nowMs = Date.now();
  let result;
  try {
    result = listChatMessages(nk, channelId, { limit: limitN, cursor, ...(hideSenders !== undefined ? { hideSenders } : {}) }, nowMs);
  } catch (e) {
    if (e instanceof RangeError) return toJson(err('BAD_REQUEST', 'invalid cursor'));
    throw e;
  }

  emit(
    nk,
    logger,
    'chat_listed',
    {
      channelType, targetId, channelId, returned: result.messages.length,
    },
    { userId: caller.id },
  );

  const out: ChatListRpcOutput = {
    messages: result.messages,
    nextCursor: result.nextCursor,
  };
  return toJson(ok(out));
}

/** Club roster ids for the block filter; empty when the roster is unreadable. */
function readMemberIdsSafe(nk: INakama, clubId: string): string[] {
  try {
    return listGroupMemberIds(nk, clubId);
  } catch {
    return [];
  }
}

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const chat_send = withRuntime(chat_send_impl);
export const chat_list = withRuntime(chat_list_impl);
