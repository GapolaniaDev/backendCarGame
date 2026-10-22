// Phase 7 Chunk 2 — Block RPCs (3):
//   - block_add        — idempotent insert-if-absent
//   - block_remove     — idempotent delete
//   - block_list       — list caller's blocks (default page size 50)
//
// All 3 RPCs are gated by `assertNotInMaintenance`. Rate limits: 30/min
// for each (per spec; tighter than invite_send which is 10/min).
//
// Errors:
//   - BAD_REQUEST (block_add): self-block (`targetUserId === callerId`)

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { checkRateLimit } from '../core/rate_limit';
import { parseInput } from '../core/parse_input';
import { assertNotInMaintenance } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import {
  deleteBlock,
  listBlocks,
  readBlock,
  writeBlockCreate,
} from './blocks_repo';
import {
  BLOCK_LIST_PAGE_SIZE,
  type BlockAddOutput,
  type BlockCard,
  type BlockListOutput,
  type BlockRecord,
  type BlockRemoveOutput,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

const BLOCK_RATE_LIMITS = {
  block_add: { maxPerWindow: 30, windowSec: 60 },
  block_remove: { maxPerWindow: 30, windowSec: 60 },
  block_list: { maxPerWindow: 30, windowSec: 60 },
} as const;



function parseBody(body: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.value as Record<string, unknown> };
}

function checkRateOrLimit(
  nk: INakama,
  logger: ILogger,
  rpcName: keyof typeof BLOCK_RATE_LIMITS,
  userId: string,
): Resp<unknown> | null {
  const opts = BLOCK_RATE_LIMITS[rpcName];
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

// ─── block_add ────────────────────────────────────────────────────────────────

/**
 * Add a target user to caller's block list. Idempotent: a second call
 * for the same target returns `{created:false}` with HTTP-style OK
 * (no CONFLICT) — block-add cannot fail on duplicate by design.
 *
 * Self-block → BAD_REQUEST.
 */
export function block_add_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'block_add', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const targetUserId = parsed.data.targetUserId;
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }
  if (targetUserId === caller.id) {
    return toJson(err('BAD_REQUEST', 'cannot block yourself'));
  }

  // Idempotent insert-if-absent.
  const existing = readBlock(nk, caller.id, targetUserId);
  if (existing !== null) {
    const out: BlockAddOutput = { created: false };
    return toJson(ok(out));
  }

  const record: BlockRecord = {
    schemaVersion: 1,
    ownerId: caller.id,
    targetUserId,
    createdAt: Date.now(),
  };
  try {
    writeBlockCreate(nk, record);
  } catch (e) {
    logger.error(
      'block_add: storage write failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to persist block'));
  }

  emit(nk, logger, 'player_blocked', { targetUserId }, { userId: caller.id });

  const out: BlockAddOutput = { created: true };
  return toJson(ok(out));
}

// ─── block_remove ─────────────────────────────────────────────────────────────

/**
 * Remove a target from caller's block list. Idempotent — returns
 * `{removed:false}` when the block didn't exist (still OK).
 */
export function block_remove_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'block_remove', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const targetUserId = parsed.data.targetUserId;
  if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
    return toJson(err('BAD_REQUEST', 'targetUserId is required'));
  }

  const existing = readBlock(nk, caller.id, targetUserId);
  if (existing === null) {
    const out: BlockRemoveOutput = { removed: false };
    return toJson(ok(out));
  }

  try {
    deleteBlock(nk, caller.id, targetUserId);
  } catch (e) {
    logger.error(
      'block_remove: storage delete failed: %s',
      e instanceof Error ? e.message : String(e),
    );
    return toJson(err('INTERNAL', 'failed to delete block'));
  }

  emit(nk, logger, 'player_unblocked', { targetUserId }, { userId: caller.id });

  const out: BlockRemoveOutput = { removed: true };
  return toJson(ok(out));
}

// ─── block_list ───────────────────────────────────────────────────────────────

export function block_list_impl(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
): string {
  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.error;
  const caller = requireCallerId(ctx, parsed.data);
  if (!caller.ok) return caller.error;

  const limit = checkRateOrLimit(nk, logger, 'block_list', caller.id);
  if (limit !== null) return toJson(limit);

  const m = assertNotInMaintenance(logger, nk, caller.id);
  if (m !== null) return toJson(m);

  const records = listBlocks(nk, caller.id);
  const blocks: BlockCard[] = records
    .map((r) => ({ targetUserId: r.targetUserId, createdAt: r.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, BLOCK_LIST_PAGE_SIZE);

  const out: BlockListOutput = { blocks, count: blocks.length };
  return toJson(ok(out));
}

// ─── Top-level bindings ──────────────────────────────────────────────────────

// Global names the 3.27 registration scanner resolves (main.ts). Each one
// loads the VM's runtime state first (plan T-29, D-11; audit N8).
export const block_add = withRuntime(block_add_impl);
export const block_remove = withRuntime(block_remove_impl);
export const block_list = withRuntime(block_list_impl);
