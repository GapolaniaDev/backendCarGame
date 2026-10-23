// account_link, account_link_resolve_conflict and account_delete
// (plan T-15, T-16).
//
// Linking is native (P-02, see `linking.ts`): `account_link` takes no
// token and only credits the one-time bonus for an identity Nakama
// already linked; `account_link_resolve_conflict` resolves an identity
// that belongs to another account, proven by a session of that account.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { parseInput } from '../core/parse_input';
import { liveopsGate } from '../core/liveops';
import { emit } from '../core/admin/analytics';
import type { ClientPlatform } from '../liveops/types';
import { claimLinkBonus, openConflict, resolveConflict } from './linking';
import { linkedProviders } from './identities';
import { deleteAccount } from './delete';
import {
  ACCOUNT_DELETE_CONFIRM_TEXT,
  isLinkedProvider,
  type AccountDeleteInput,
  type AccountDeleteOutput,
  type AccountLinkInput,
  type AccountLinkOutput,
  type AccountLinkResolveConflictInput,
  type AccountLinkResolveConflictOutput,
} from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const toJson = <T>(r: Resp<T>): string => JSON.stringify(r);

// ─── account_link ───────────────────────────────────────────────────────────

export const account_link_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const callerId = requireCallerId(ctx, raw);
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

  // The old contract sent a server-signed test token (audit 06 f11). It
  // is rejected whatever its signature: Nakama verifies identities.
  if (raw['token'] !== undefined) {
    return toJson(err(
      'BAD_REQUEST',
      'link tokens are not accepted: link natively with the Nakama client (LinkGoogleAsync, LinkAppleAsync, …), then call account_link',
      { reason: 'NATIVE_LINK_REQUIRED' },
    ));
  }
  const provider = raw['provider'];
  if (provider !== undefined && !isLinkedProvider(provider)) {
    return toJson(err('BAD_REQUEST', `unknown provider: ${String(provider)}`));
  }

  const providers = linkedProviders(nk, userId);
  if (providers === null) return toJson(err('NOT_FOUND', 'account not found'));
  if (providers.length === 0 || (provider !== undefined && !providers.includes(provider))) {
    return toJson(err(
      'CONFLICT',
      provider !== undefined ? `${provider} is not linked to this account` : 'no identity is linked to this account',
      { reason: 'NOT_LINKED', providers },
    ));
  }

  let bonus;
  try {
    bonus = claimLinkBonus(nk, logger, userId, Date.now());
  } catch (e) {
    logger.error('account_link bonus failed user=%s: %s', userId, e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'link bonus failed; nothing was credited, please retry'));
  }
  if (!bonus.ok) return toJson(bonus);

  logger.info('account_link user=%s providers=%j bonus=%s', userId, providers, String(bonus.data.bonusClaimed));
  emit(nk, logger, 'account_linked', { userId, providers, bonusClaimed: bonus.data.bonusClaimed });
  const out: AccountLinkOutput = {
    linked: true,
    providers,
    bonusClaimed: bonus.data.bonusClaimed,
    ...(bonus.data.newBalance !== undefined ? { newBalance: bonus.data.newBalance } : {}),
  };
  return toJson(ok(out));
};

// ─── account_link_resolve_conflict ─────────────────────────────────────────

export const account_link_resolve_conflict_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const callerId = requireCallerId(ctx, raw);
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

  const step = raw['step'] ?? 'resolve';
  if (step !== 'open' && step !== 'resolve') {
    return toJson(err('BAD_REQUEST', `step must be 'open' or 'resolve'`));
  }
  const nowMs = Date.now();

  try {
    if (step === 'open') {
      const opened = openConflict(nk, logger, userId, nowMs);
      if (opened.ok) emit(nk, logger, 'account_link_conflict', { userId, targetUserId: userId });
      return toJson(opened);
    }

    const conflictToken = raw['conflictToken'];
    if (typeof conflictToken !== 'string' || conflictToken.length === 0) {
      return toJson(err('BAD_REQUEST', 'conflictToken is required'));
    }
    const choice = raw['choice'];
    if (choice !== 'link' && choice !== 'cancel') {
      return toJson(err('BAD_REQUEST', `choice must be 'link' or 'cancel'`));
    }
    const confirmText = typeof raw['confirmText'] === 'string' ? raw['confirmText'] as string : undefined;
    const resolved = resolveConflict(
      nk, logger, userId,
      { conflictToken, choice, ...(confirmText !== undefined ? { confirmText } : {}) },
      nowMs,
    );
    if (resolved.ok) {
      emit(nk, logger, 'account_link_conflict_resolved', {
        userId, choice, affectedAccountDeleted: resolved.data.affectedAccountDeleted === true,
      });
    }
    return toJson<AccountLinkResolveConflictOutput>(resolved);
  } catch (e) {
    logger.error('account_link_resolve_conflict failed user=%s: %s', userId, e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'conflict resolution failed'));
  }
};

// Top-level bindings for the goja AST scanner.
export const account_link: RpcHandler = withRuntime(account_link_impl);
export const account_link_resolve_conflict: RpcHandler = withRuntime(account_link_resolve_conflict_impl);

// ─── account_delete ─────────────────────────────────────────────────────────

export const account_delete_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  const raw = parsed.raw;

  const callerId = requireCallerId(ctx, raw);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  // NOTE: account_delete intentionally BYPASSES the maintenance gate
  // — GDPR "right to erasure" is not allowed to be blocked by an
  // operational pause. A broken session token still rejects.

  const confirmText = raw['confirmText'];
  if (typeof confirmText !== 'string' || confirmText !== ACCOUNT_DELETE_CONFIRM_TEXT) {
    return toJson(err(
      'BAD_REQUEST',
      `confirmation required: pass confirmText="${ACCOUNT_DELETE_CONFIRM_TEXT}"`,
    ));
  }

  const nowMs = Date.now();
  let deleted;
  try {
    deleted = deleteAccount(nk, logger, userId);
  } catch (e) {
    logger.error('account_delete failed user=%s: %s', userId, e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'failed to delete account'));
  }
  if (!deleted.ok) return toJson(deleted);

  // Emitted only after `nk.accountDeleteId` succeeded; system-owned row.
  emit(nk, logger, 'account_deleted', { userId, summary: deleted.data });

  const output: AccountDeleteOutput = {
    deletedAt: new Date(nowMs).toISOString(),
    summary: deleted.data,
  };
  return toJson(ok(output));
};

export const account_delete: RpcHandler = withRuntime(account_delete_impl);

export type {
  AccountLinkInput,
  AccountLinkOutput,
  AccountLinkResolveConflictInput,
  AccountLinkResolveConflictOutput,
  AccountDeleteInput,
  AccountDeleteOutput,
};
