// Club join rules on the native group API (plan T-21; audit 07 f2,
// 7.3.5, 7.6.5).
//
// Clubs are Nakama groups created CLOSED, and the roster, roles and join
// rules live in the club RPCs (`club_join`, `club_leave`, `club_kick`,
// `club_promote` …). The client group API would bypass them, so:
//   - `beforeJoinGroupGuard` (JoinGroup) applies the club join rules and
//     refuses with the failing rule; when every rule passes it still
//     refuses and points to `club_join` (a closed group would only file a
//     join request that no RPC reads);
//   - `beforeGroupWriteGuard` refuses the other group writes (create,
//     update, delete, leave, add, kick, ban, promote, demote): an admin
//     reopening the group or adding users natively would skip the rules.
// Both throw `{message, code: 7}`: HTTP 403 without a runtime error log.
//
// `checkGroupJoinBlock` is the block check of the join rules: the joiner
// against the leader and every admin, either direction.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { evaluateClubJoin } from '../clubs/join';
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

/** gRPC PERMISSION_DENIED: the client receives HTTP 403. */
const PERMISSION_DENIED = 7;

/** Before-hook of the client JoinGroup API. */
export function beforeJoinGroupGuard(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  data: unknown,
): unknown {
  const groupId = String((data as { groupId?: unknown } | null)?.groupId ?? '');
  const userId = String(ctx?.userId ?? '');
  const verdict = evaluateClubJoin(nk, logger, userId, groupId);
  const reason = verdict.allowed ? 'use_club_join' : verdict.reason;
  logger.info('rejecting native JoinGroup [user=%s group=%s reason=%s]', userId, groupId, reason);
  throw { message: `clubs are joined through the club_join RPC (${reason})`, code: PERMISSION_DENIED };
}

/** Before-hook of the other client group writes. */
export function beforeGroupWriteGuard(
  ctx: IContext,
  logger: ILogger,
  _nk: INakama,
  _data: unknown,
): unknown {
  logger.info('rejecting native group write [user=%s]', String(ctx?.userId ?? '?'));
  throw { message: 'clubs are managed through the club_* RPCs', code: PERMISSION_DENIED };
}
