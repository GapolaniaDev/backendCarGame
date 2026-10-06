// Phase 5 Chunk 4 — account_link + account_link_resolve_conflict.
//
// Both RPCs are maintenance-gated (Phase 5 Chunk 2 `liveopsGate`) and
// require a signed caller. The first attempts the link; on conflict
// it returns a `conflictToken` handle that the client passes back to
// `account_link_resolve_conflict` with `choice: 'link' | 'cancel'`.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson as toJsonEnv, type Resp } from '../core/response';
import { parseInput } from '../core/parse_input';
import { liveopsGate } from '../core/liveops';
import type { ClientPlatform } from '../liveops/types';
import {
  linkAccount,
  resolveConflict,
  unlinkAllCustomAuths,
  type LinkAccountResult,
  type ResolveConflictResult,
} from './linking';
import { purgeFromLeaderboards, purgeUserStorage } from './purge';
import { removePlayerFromAll } from '../race/remove_player';
import {
  ACCOUNT_DELETE_CONFIRM_TEXT,
  isAccountLinkProvider,
  type AccountDeleteInput,
  type AccountDeleteOutput,
  type AccountDeleteSummary,
  type AccountLinkConflictOutput,
  type AccountLinkInput,
  type AccountLinkOutput,
  type AccountLinkProvider,
  type AccountLinkResolveConflictInput,
  type AccountLinkResolveConflictOutput,
} from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

interface CallerOk { ok: true; id: string; }
interface CallerErr { ok: false; error: string; }
function resolveCaller(ctx: IContext, declared: string, logger: ILogger): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return { ok: false, error: JSON.stringify(err('FORBIDDEN', 'callerUserId does not match authenticated user')) };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('account_link RPC called with no caller identity');
  return { ok: false, error: JSON.stringify(err('UNAUTHENTICATED', 'no caller identity')) };
}

// ─── account_link ───────────────────────────────────────────────────────────

export const account_link_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const caller = typeof raw['callerUserId'] === 'string' ? raw['callerUserId'] as string : '';
  const callerId = resolveCaller(ctx, caller, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const gate = liveopsGate(
    logger,
    nk,
    userId,
    typeof raw['clientVersion'] === 'string' ? raw['clientVersion'] as string : undefined,
    typeof raw['platform'] === 'string' ? raw['platform'] as ClientPlatform : 'ios',
  );
  if (gate !== null) return JSON.stringify(gate);

  const provider = raw['provider'];
  if (!isAccountLinkProvider(provider)) {
    return JSON.stringify(err('BAD_REQUEST', `unknown provider: ${String(provider)}`));
  }
  const token = raw['token'];
  if (typeof token !== 'string' || token.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'token is required'));
  }

  const nowMs = Date.now();
  const result = linkAccount(nk, logger, userId, provider, token, nowMs);
  return renderLinkResult(logger, userId, provider, result);
};

function renderLinkResult(
  logger: ILogger,
  userId: string,
  provider: AccountLinkProvider,
  result: LinkAccountResult,
): string {
  if (result.kind === 'linked') {
    logger.info(
      'account_link user=%s provider=%s bonus=%s',
      userId, provider, String(result.bonusClaimed),
    );
    const out: AccountLinkOutput = {
      linked: true,
      bonusClaimed: result.bonusClaimed,
      ...(result.newBalance !== undefined ? { newBalance: result.newBalance } : {}),
    };
    return JSON.stringify(ok(out));
  }
  if (result.kind === 'conflict') {
    return JSON.stringify(ok({ linked: false, conflict: result.conflict } satisfies { linked: false; conflict: AccountLinkConflictOutput }));
  }
  // error
  return JSON.stringify(err(result.code, result.message));
}

// ─── account_link_resolve_conflict ─────────────────────────────────────────

export const account_link_resolve_conflict_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const caller = typeof raw['callerUserId'] === 'string' ? raw['callerUserId'] as string : '';
  const callerId = resolveCaller(ctx, caller, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const gate = liveopsGate(
    logger,
    nk,
    userId,
    typeof raw['clientVersion'] === 'string' ? raw['clientVersion'] as string : undefined,
    typeof raw['platform'] === 'string' ? raw['platform'] as ClientPlatform : 'ios',
  );
  if (gate !== null) return JSON.stringify(gate);

  const conflictToken = raw['conflictToken'];
  if (typeof conflictToken !== 'string' || conflictToken.length === 0) {
    return JSON.stringify(err('BAD_REQUEST', 'conflictToken is required'));
  }
  const choice = raw['choice'];
  if (choice !== 'link' && choice !== 'cancel') {
    return JSON.stringify(err('BAD_REQUEST', `choice must be 'link' or 'cancel'`));
  }
  const confirmText = typeof raw['confirmText'] === 'string' ? raw['confirmText'] as string : undefined;

  const nowMs = Date.now();
  const result = resolveConflict(nk, logger, userId, { conflictToken, choice, ...(confirmText !== undefined ? { confirmText } : {}) }, nowMs);
  return renderResolveResult(logger, userId, result);
};

function renderResolveResult(
  logger: ILogger,
  userId: string,
  result: ResolveConflictResult,
): string {
  if (result.kind === 'cancelled') {
    return JSON.stringify(ok({ resolved: 'cancelled' as const } satisfies Pick<AccountLinkResolveConflictOutput, 'resolved'>));
  }
  if (result.kind === 'linked') {
    const out: AccountLinkResolveConflictOutput = {
      resolved: 'linked',
      affectedAccountDeleted: result.affectedAccountDeleted,
      bonusClaimed: result.bonusClaimed,
      ...(result.newBalance !== undefined ? { newBalance: result.newBalance } : {}),
    };
    return JSON.stringify(ok(out));
  }
  return JSON.stringify(err(result.code, result.message));
}

// Top-level bindings for the goja AST scanner.
export const account_link: RpcHandler = account_link_impl;
export const account_link_resolve_conflict: RpcHandler = account_link_resolve_conflict_impl;

// ─── account_delete (Phase 5 Chunk 5) ──────────────────────────────────────

export const account_delete_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const caller = typeof raw['callerUserId'] === 'string' ? raw['callerUserId'] as string : '';
  const callerId = resolveCaller(ctx, caller, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  // NOTE: account_delete intentionally BYPASSES the maintenance gate
  // — GDPR "right to erasure" is not allowed to be blocked by an
  // operational pause. A broken session token still rejects.

  const confirmText = raw['confirmText'];
  if (typeof confirmText !== 'string' || confirmText !== ACCOUNT_DELETE_CONFIRM_TEXT) {
    return JSON.stringify(err(
      'BAD_REQUEST',
      `confirmation required: pass confirmText="${ACCOUNT_DELETE_CONFIRM_TEXT}"`,
    ));
  }

  const nowMs = Date.now();

  // Step 1: mark abandoned in any active race session so the
  // close-time ordering still records them as DNF — and prevents the
  // RaceCompleted subscriber from trying to grant rewards to a
  // userId that's about to be purged.
  const removeResult = removePlayerFromAll(nk, logger, userId);

  // Step 2: purge storage.
  const purge = purgeUserStorage(nk, userId);

  // Step 3: purge leaderboard records.
  const lbPurge = purgeFromLeaderboards(nk, logger, userId);

  // Step 4: unlink every custom auth.
  const unlinked = unlinkAllCustomAuths(nk, logger, userId);

  // Step 5: soft-delete the account row. `recorded=false` skips
  // the recorded-channel billable audit trail (we already log a
  // single high-priority line above for ops).
  try {
    nk.accountDeleteId(userId, false);
  } catch (e) {
    logger.error(
      'account_delete: accountDeleteId(%s) failed: %s',
      userId, e instanceof Error ? e.message : String(e),
    );
    return JSON.stringify(err('INTERNAL', 'failed to delete account'));
  }

  logger.warn(
    'account_delete user=%s storage=%d boards=%d abandoned=%d unlinked=%j',
    userId, purge.storageDeleted, lbPurge.boardsDeleted,
    removeResult.abandonedFrom.length, unlinked.unlinked,
  );

  const summary: AccountDeleteSummary = {
    storageDeleted: purge.storageDeleted,
    collectionsAffected: purge.collectionsAffected,
    boardsDeleted: lbPurge.boardsDeleted,
    boardsAffected: lbPurge.boardsAffected,
    unlinkedAuths: unlinked.unlinked,
    // Clubs: not implemented yet (Phase 7). Always empty for v1.
    wasClubLeaderOf: [],
    abandonedFromRaces: removeResult.abandonedFrom.length,
  };
  const output: AccountDeleteOutput = {
    deletedAt: new Date(nowMs).toISOString(),
    summary,
  };
  return JSON.stringify(ok(output));
};

export const account_delete: RpcHandler = account_delete_impl;

export type {
  AccountLinkInput,
  AccountLinkOutput,
  AccountLinkResolveConflictInput,
  AccountLinkResolveConflictOutput,
  AccountDeleteInput,
  AccountDeleteOutput,
};

// Side-effect import marker so the bundler keeps the named export of
// toJsonEnv available for callers that prefer the helper.
void toJsonEnv;