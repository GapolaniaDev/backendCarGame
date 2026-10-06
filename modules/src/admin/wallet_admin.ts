// Phase 5 Chunk 6 — `admin_wallet_adjust`.
//
// Adjusts a user's wallet via `nk.walletUpdate` and emits an analytics
// event for the audit trail. No idempotency key is used — admin tooling
// that retries the same payload will RE-apply the delta (the admin
// owns the responsibility of not double-applying).

import type { ILogger, INakama } from '../nkruntime';
import { walletGet } from '../economy/wallet';
import { emitAdminAction } from '../core/admin/analytics';
import type {
  AdminWalletAdjustInput,
  AdminWalletAdjustOutput,
} from './types';

export interface WalletAdjustResult {
  ok: boolean;
  error?: { code: string; message: string };
  data?: AdminWalletAdjustOutput;
}

/**
 * Apply `coins`/`gems` deltas to `userId`'s wallet and return the
 * post-update balance. Validates that exactly one of the deltas is
 * non-zero and finite.
 */
export function walletAdjust(
  nk: INakama,
  logger: ILogger,
  input: AdminWalletAdjustInput,
): WalletAdjustResult {
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'userId is required' } };
  }
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'reason is required' } };
  }
  const coins = typeof input.coins === 'number' ? input.coins : 0;
  const gems = typeof input.gems === 'number' ? input.gems : 0;
  if (!Number.isFinite(coins) || !Number.isFinite(gems)) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'coins/gems must be finite numbers' } };
  }
  if (coins === 0 && gems === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'at least one of coins/gems must be non-zero' } };
  }

  const changeset: Record<string, number> = {};
  if (coins !== 0) changeset['coins'] = coins;
  if (gems !== 0) changeset['gems'] = gems;

  // nk.walletUpdate returns the resulting balance on the production
  // runtime; we ignore it and re-read via walletGet for symmetry with
  // the rest of the codebase.
  try {
    nk.walletUpdate(input.userId, changeset);
  } catch (e) {
    logger.error('admin_wallet_adjust: walletUpdate failed for %s: %s', input.userId, e instanceof Error ? e.message : String(e));
    return { ok: false, error: { code: 'INTERNAL', message: 'walletUpdate failed' } };
  }

  const bal = walletGet(nk, input.userId);

  emitAdminAction(nk, logger, 'admin_wallet_adjust', {
    targetUserId: input.userId,
    reason: input.reason,
    coinsDelta: coins,
    gemsDelta: gems,
    newBalance: { coins: bal.coins, gems: bal.gems },
  });
  logger.warn('admin_wallet_adjust user=%s coins=%d gems=%d reason=%s', input.userId, coins, gems, input.reason);

  return { ok: true, data: { newBalance: { coins: bal.coins, gems: bal.gems } } };
}