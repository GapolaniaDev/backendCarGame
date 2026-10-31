// Phase 7 Chunk 1 — Social RPCs.
//
// 5 RPCs:
//   1. friend_code_get     — lazy-create + return the caller's code
//   2. friend_add_by_code  — paste a code → mutual friendship (D5/D6/D7/D8)
//   3. friend_list_get      — list caller's friends
//   4. friend_remove       — remove a friend (both sides)
//   5. recent_rivals_get   — list caller's recent rivals
//
// All 5 RPCs are gated by `assertNotInMaintenance` (no bypass — even
// friends should be readonly when the server is in maintenance).
//
// Rate limits (peer spec):
//   - friend_add_by_code: 10 calls / 60s per caller (tighter: a paste
//     loop is suspicious)
//   - everything else:    30 calls / 60s per caller

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import { displayNamesById } from '../profiles/display_names';
import { generateFriendCode, isValidCodeFormat } from './friend_code';
import { isBlockedEitherWay } from './blocks_repo';
import {
  deleteFriendEdge,
  listFriendEdges,
  lookupUserByCode,
  readFriendCode,
  readFriendEdge,
  readRecentRivals,
  writeFriendCode,
} from './friends_repo';
import {
  FRIEND_CODE_LENGTH,
  RECENT_RIVALS_CAP,
  RECENT_RIVALS_WINDOW_MS,
  asFriendEdgeWrite,
  type FriendAddByCodeOutput,
  type FriendCard,
  type FriendCodeGetOutput,
  type FriendEdgeRecord,
  type FriendListGetOutput,
  type FriendRemoveOutput,
  type RecentRivalCard,
  type RecentRivalsGetOutput,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── Rate limits ─────────────────────────────────────────────────────────────

const FRIEND_RATE_LIMITS = {
  friend_code_get: { maxPerWindow: 30, windowSec: 60 },
  friend_add_by_code: { maxPerWindow: 10, windowSec: 60 },
  friend_list_get: { maxPerWindow: 30, windowSec: 60 },
  friend_remove: { maxPerWindow: 30, windowSec: 60 },
  recent_rivals_get: { maxPerWindow: 30, windowSec: 60 },
} as const;

// ─── Caller plumbing ───────────────────────────────────────────────────────────



function parseBody(body: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as Record<string, unknown> };
}

function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof FRIEND_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = FRIEND_RATE_LIMITS[rpcName];
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

// ─── friend_code_get ───────────────────────────────────────────────────────────

/**
 * Return the caller's stable 8-char friend code. Lazy-creates the
 * storage row on first call (insert-if-absent; no CAS needed because
 * the code is a deterministic function of userId — re-creating
 * produces the same value).
 */
export function friend_code_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'friend_code_get', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const existing = readFriendCode(nk, caller.id);
  if (existing !== null) {
    const out: FriendCodeGetOutput = {
      code: existing.record.code,
      userId: existing.record.userId,
      createdAt: existing.record.createdAt,
    };
    return toJson(ok(out));
  }

  // Lazy create. Compute the code (deterministic) and write it.
  let code: string;
  try {
    code = generateFriendCode(caller.id, nk);
  } catch (e) {
    logger.error(
      'friend_code_get: generateFriendCode failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to generate friend code'));
  }
  if (code.length !== FRIEND_CODE_LENGTH) {
    return toJson(err('INTERNAL', 'friend code has wrong length'));
  }
  const createdAt = Date.now();
  try {
    writeFriendCode(nk, {
      schemaVersion: 1,
      userId: caller.id,
      code,
      createdAt,
    });
  } catch (e) {
    logger.error(
      'friend_code_get: storage write failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist friend code'));
  }

  return toJson(
    ok<FriendCodeGetOutput>({ code, userId: caller.id, createdAt }),
  );
}

// ─── friend_add_by_code ─────────────────────────────────────────────────────

/**
 * Paste a code, get a mutual friendship. Errors:
 *   - BAD_REQUEST: code missing / wrong format / self-add
 *   - NOT_FOUND:   code has no row (stale or typo), or a block between the
 *                  two players either way (plan T-22; audit 07 f3): the
 *                  answer does not reveal the block
 *   - CONFLICT:    already friends
 *   - INTERNAL:    storage failure
 */
export function friend_add_by_code_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'friend_add_by_code', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const rawCode = parsed.data.code;
  if (typeof rawCode !== 'string' || rawCode.length === 0) {
    return toJson(err('BAD_REQUEST', 'code is required'));
  }
  const code = rawCode.trim().toUpperCase();
  if (!isValidCodeFormat(code)) {
    return toJson(err('BAD_REQUEST', 'code format invalid'));
  }

  const owner = lookupUserByCode(nk, code);
  if (owner === null) {
    return toJson(err('NOT_FOUND', 'no player with that code'));
  }
  const friendId = owner.record.userId;
  if (friendId === caller.id) {
    return toJson(err('BAD_REQUEST', 'cannot add yourself as a friend'));
  }
  if (isBlockedEitherWay(nk, caller.id, friendId)) {
    logger.info('friend_add_by_code refused by a block [caller=%s target=%s]', caller.id, friendId);
    return toJson(err('NOT_FOUND', 'no player with that code'));
  }

  // CONFLICT check: edge already exists in caller's row?
  const existing = readFriendEdge(nk, caller.id, friendId);
  if (existing !== null) {
    return toJson(err('CONFLICT', 'already friends with that player'));
  }

  const since = Date.now();

  // Caller's edge: owner=caller, key=friend.
  const myEdge: FriendEdgeRecord = {
    schemaVersion: 1,
    userId: caller.id,
    friendId,
    friendCode: code,
    since,
  };
  // Friend's edge: owner=friend, key=caller. We need the caller's code
  // for the snapshot — read it (lazy-create if missing).
  let myCodeValue: string;
  const myCodeRow = readFriendCode(nk, caller.id);
  if (myCodeRow !== null) {
    myCodeValue = myCodeRow.record.code;
  } else {
    try {
      myCodeValue = generateFriendCode(caller.id, nk);
      writeFriendCode(nk, {
        schemaVersion: 1,
        userId: caller.id,
        code: myCodeValue,
        createdAt: since,
      });
    } catch (e) {
      logger.error(
        'friend_add_by_code: caller code gen failed: %s',
        e instanceof Error ? e.message : String(e),
      );
      return toJson(err('INTERNAL', 'failed to derive caller code'));
    }
  }
  const theirEdge: FriendEdgeRecord = {
    schemaVersion: 1,
    userId: friendId,
    friendId: caller.id,
    friendCode: myCodeValue,
    since,
  };

  try {
    // Both sides in one write: never a one-sided friendship.
    nk.storageWrite([asFriendEdgeWrite(myEdge), asFriendEdgeWrite(theirEdge)]);
  } catch (e) {
    logger.error(
      'friend_add_by_code: storage write failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist friendship'));
  }

  emit(nk, logger, 'friend_added', { friendId, code }, { userId: caller.id });

  const out: FriendAddByCodeOutput = {
    friendId,
    friendCode: code,
    since,
    mutual: true,
  };
  return toJson(ok(out));
}

// ─── friend_list_get ───────────────────────────────────────────────────────────

export function friend_list_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'friend_list_get', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const edges = listFriendEdges(nk, caller.id);
  const names = displayNamesById(logger, nk, edges.map((e) => e.friendId));
  const friends: FriendCard[] = edges
    .map((e) => ({
      friendId: e.friendId,
      friendCode: e.friendCode,
      since: e.since,
      displayName: names.get(e.friendId)!,
    }))
    .sort((a, b) => b.since - a.since);

  const out: FriendListGetOutput = { friends, count: friends.length };
  return toJson(ok(out));
}

// ─── friend_remove ─────────────────────────────────────────────────────────────

export function friend_remove_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'friend_remove', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const friendId = parsed.data.friendId;
  if (typeof friendId !== 'string' || friendId.length === 0) {
    return toJson(err('BAD_REQUEST', 'friendId is required'));
  }

  const existing = readFriendEdge(nk, caller.id, friendId);
  if (existing === null) {
    return toJson(err('NOT_FOUND', 'no friendship with that player'));
  }

  try {
    deleteFriendEdge(nk, caller.id, friendId);
    deleteFriendEdge(nk, friendId, caller.id);
  } catch (e) {
    logger.error(
      'friend_remove: storage delete failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to delete friendship'));
  }

  emit(nk, logger, 'friend_removed', { friendId }, { userId: caller.id });

  const out: FriendRemoveOutput = { removed: true, friendId };
  return toJson(ok(out));
}

// ─── recent_rivals_get ───────────────────────────────────────────────────────────

export function recent_rivals_get_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'recent_rivals_get', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const existing = readRecentRivals(nk, caller.id);
  const now = Date.now();
  const entries = existing !== null
    ? existing.record.entries
        .filter((e) => now - e.lastRaceAt <= RECENT_RIVALS_WINDOW_MS)
        .slice(0, RECENT_RIVALS_CAP)
    : [];

  const names = displayNamesById(logger, nk, entries.map((e) => e.userId));
  const rivals: RecentRivalCard[] = entries.map((e) => ({
    userId: e.userId,
    lastRaceAt: e.lastRaceAt,
    raceCount: e.raceCount,
    displayName: names.get(e.userId)!,
  }));

  const result: RecentRivalsGetOutput = {
    rivals,
    count: rivals.length,
  };
  return toJson(ok(result));
}

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const friend_code_get = withRuntime(friend_code_get_impl);
export const friend_add_by_code = withRuntime(friend_add_by_code_impl);
export const friend_list_get = withRuntime(friend_list_get_impl);
export const friend_remove = withRuntime(friend_remove_impl);
export const recent_rivals_get = withRuntime(recent_rivals_get_impl);
