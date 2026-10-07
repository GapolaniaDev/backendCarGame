// Phase 7 Chunk 2 — chat `beforeSendChannelMessage` block check stub.
//
// The chat module itself lands in Phase 7 Chunk 5. This file ships the
// block-check helper that Chunk 5 will wire into the real
// `registerBeforeSendChannelMessage` hook (which doesn't exist in the
// Nakama 3.27 JS runtime today — Chunk 5 will introduce the wrapper
// or fall back to a runtime-side check on channel writes).
//
// The hook's contract (per peer spec):
//   - For each (sender, recipient) pair, look up both directions of
//     `blocks/{owner}/{target}`. If EITHER side has a block, refuse
//     with FORBIDDEN.
//   - MUST NOT throw on real races: catch + return `allowed:true` on
//     any storage error (defense-in-depth — Phase 4 ranked subscriber
//     pattern). A storage hiccup should not block legitimate chat.

import type { ILogger, INakama } from '../nkruntime';
import { isBlockedEitherWay } from '../social/blocks_repo';

export interface ChatSendDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Block check for the chat send hook. Pure-ish (depends only on
 * storage reads via `nk`). Returns `{allowed:false, reason:'blocked'}`
 * when either side has a block.
 */
export function checkChatSendBlock(
  nk: INakama,
  logger: ILogger | undefined,
  senderId: string,
  recipientId: string,
): ChatSendDecision {
  if (senderId === recipientId) {
    return { allowed: true, reason: null };
  }
  let blocked = false;
  try {
    blocked = isBlockedEitherWay(nk, senderId, recipientId);
  } catch (e) {
    if (logger) {
      logger.warn(
        'chat send block check failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
    // Fail open on storage error.
    return { allowed: true, reason: null };
  }
  if (blocked) {
    return { allowed: false, reason: 'blocked' };
  }
  return { allowed: true, reason: null };
}