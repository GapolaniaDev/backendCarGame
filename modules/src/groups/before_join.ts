// Phase 7 Chunk 2 — groups (clubs) `beforeJoinGroup` block check stub.
//
// The clubs module lands in Phase 7 Chunk 3. This file ships the
// block-check helper that Chunk 3 will wire into the real
// `registerBeforeJoinGroup` hook. The hook doesn't exist in the
// Nakama 3.27 JS runtime surface today — Chunk 3 will add it (or use
// a runtime-side check on group joins).
//
// The contract mirrors `chat/before_send.ts`:
//   - For each (joining user, group owner / admin) pair, look up
//     both directions of `blocks/{owner}/{target}`. If either side has
//     a block, refuse with FORBIDDEN.
//   - MUST NOT throw on real races: catch + return `allowed:true` on
//     storage error (defense-in-depth).

import type { ILogger, INakama } from '../nkruntime';
import { isBlockedEitherWay } from '../social/blocks_repo';

export interface GroupJoinDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Block check for the clubs join hook. `joinerId` is the user who is
 * attempting to join; `gatekeeperIds` is the list of users whose
 * blocks would gate entry (group owner + admins). The join is blocked
 * if ANY pair (joiner, gatekeeper) has a block in either direction.
 */
export function checkGroupJoinBlock(
  nk: INakama,
  logger: ILogger | undefined,
  joinerId: string,
  gatekeeperIds: ReadonlyArray<string>,
): GroupJoinDecision {
  for (const gkId of gatekeeperIds) {
    if (gkId === joinerId) continue;
    let blocked = false;
    try {
      blocked = isBlockedEitherWay(nk, joinerId, gkId);
    } catch (e) {
      if (logger) {
        logger.warn(
          'group join block check failed: %s',
          e instanceof Error ? e.message : String(e),
        );
      }
      // Fail open on storage error.
      return { allowed: true, reason: null };
    }
    if (blocked) {
      return { allowed: false, reason: 'blocked' };
    }
  }
  return { allowed: true, reason: null };
}