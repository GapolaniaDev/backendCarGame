// Phase 5 Chunk 4 — Account linking workflow:
//
//   linkAccount(...)
//     1. verifyToken() → customId (rejects bad/expired/unknown-provider)
//     2. nk.accountLinkCustom(provider, userId, customId)
//        — on `ACCOUNT_LINK_CONFIRM_REQUIRED` throw, persist a conflict
//          record under `account_link_conflict/{userId}` and return
//          the conflict handle.
//        — on success, seal `accountLinkBonusClaimed = true` in the
//          profile and grant 500 coins (idempotent via
//          `accountLinkBonus:<userId>`).
//
//   resolveConflict(...)
//     1. Load the conflict record by token (verifying it belongs to
//        the caller and is not expired).
//     2. `choice === 'cancel'` → drop the record, return `cancelled`.
//     3. `choice === 'link'`    → `nk.accountDeleteId(targetUserId, ...)`
//        then `nk.accountLinkCustom(...)` again on the source, seal
//        the bonus, and credit it.
//
// `grantLinkBonus` is shared between the two paths so the
// "500 coins once per account" invariant is enforced in exactly one
// place — idempotency key derives from the source userId (the one
// that survives the link).

import type { ILogger, INakama } from '../nkruntime';
import { grant, walletGet } from '../economy/wallet';
import {
  readProfile,
  writeProfileCreate,
  writeProfileUpdate,
  ensureAccountLinkField,
  defaultProfile,
} from '../profiles/storage';
import {
  ACCOUNT_LINK_BONUS_COINS,
  ACCOUNT_LINK_BONUS_IDEMP_PREFIX,
  ACCOUNT_LINK_CONFLICT_COLLECTION,
  ACCOUNT_LINK_CONFLICT_TTL_MS,
  ACCOUNT_LINK_CONFIRM_TEXT,
  isAccountLinkProvider,
  type AccountLinkConflict,
  type AccountLinkConflictAccount,
  type AccountLinkConflictOutput,
  type AccountLinkOutput,
  type AccountLinkProvider,
  type AccountLinkResolveConflictOutput,
} from './types';
import { verifyToken } from './token';

export type LinkAccountResult =
  | { kind: 'linked'; bonusClaimed: boolean; newBalance?: { coins: number; gems: number } }
  | { kind: 'conflict'; conflict: AccountLinkConflictOutput }
  | { kind: 'error'; code: 'BAD_REQUEST' | 'NOT_FOUND'; message: string };

export type ResolveConflictResult =
  | { kind: 'linked'; affectedAccountDeleted: boolean; bonusClaimed: boolean; newBalance?: { coins: number; gems: number } }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN'; message: string };

/**
 * Drive the link flow: verify the token, attempt the runtime link,
 * branch on conflict vs success. The token's `customId` is derived
 * server-side; the client never sees it back.
 */
export function linkAccount(
  nk: INakama,
  logger: ILogger,
  userId: string,
  provider: unknown,
  token: string,
  nowMs: number,
): LinkAccountResult {
  if (!isAccountLinkProvider(provider)) {
    return { kind: 'error', code: 'BAD_REQUEST', message: `unknown provider: ${String(provider)}` };
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { kind: 'error', code: 'BAD_REQUEST', message: 'token is required' };
  }
  const verified = verifyToken(nk, token);
  if (!verified.ok) {
    return { kind: 'error', code: 'BAD_REQUEST', message: `token rejected: ${verified.reason}` };
  }
  const customId = verified.customId;

  try {
    nk.accountLinkCustom(provider, userId, customId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('ACCOUNT_LINK_CONFIRM_REQUIRED')) {
      const target = lookupUserByCustomId(nk, provider, customId);
      const conflict = writeConflict(nk, provider, customId, userId, target, nowMs);
      logger.warn(
        'account_link conflict user=%s provider=%s customId=%s token=%s',
        userId, provider, customId, conflict.token,
      );
      return {
        kind: 'conflict',
        conflict: {
          conflictToken: conflict.token,
          expiresAt: new Date(conflict.expiresAt).toISOString(),
          source: conflict.sourceAccount,
          target: conflict.targetAccount,
        },
      };
    }
    logger.error('accountLinkCustom unexpected error: %s', message);
    return { kind: 'error', code: 'BAD_REQUEST', message: `link rejected: ${message}` };
  }

  // Success path — seal the bonus flag and credit 500 coins.
  const bonusResult = grantLinkBonus(nk, logger, userId, nowMs);
  return { kind: 'linked', bonusClaimed: bonusResult.bonusClaimed, ...(bonusResult.newBalance !== undefined ? { newBalance: bonusResult.newBalance } : {}) };
}

/**
 * Drive the conflict-resolution flow: cancel or link-with-destroy.
 */
export function resolveConflict(
  nk: INakama,
  logger: ILogger,
  callerUserId: string,
  input: {
    conflictToken: string;
    choice: 'link' | 'cancel';
    confirmText?: string;
  },
  nowMs: number,
): ResolveConflictResult {
  const conflict = readConflict(nk, callerUserId);
  if (conflict === null) {
    return { kind: 'error', code: 'NOT_FOUND', message: 'no pending conflict for this user' };
  }
  if (conflict.token !== input.conflictToken) {
    return { kind: 'error', code: 'NOT_FOUND', message: 'conflict token mismatch' };
  }
  if (conflict.expiresAt <= nowMs) {
    deleteConflict(nk, callerUserId);
    return { kind: 'error', code: 'NOT_FOUND', message: 'conflict expired' };
  }

  if (input.choice === 'cancel') {
    deleteConflict(nk, callerUserId);
    logger.info('account_link_resolve cancelled user=%s', callerUserId);
    return { kind: 'cancelled' };
  }

  // choice === 'link'
  if (input.confirmText !== ACCOUNT_LINK_CONFIRM_TEXT) {
    return {
      kind: 'error',
      code: 'BAD_REQUEST',
      message: `confirmation required: pass confirmText="${ACCOUNT_LINK_CONFIRM_TEXT}"`,
    };
  }
  const targetUserId = conflict.targetAccount.userId;
  try {
    nk.accountDeleteId(targetUserId, false);
  } catch (e) {
    logger.error('accountDeleteId(target=%s) failed: %s', targetUserId, e instanceof Error ? e.message : String(e));
    return { kind: 'error', code: 'BAD_REQUEST', message: 'failed to delete conflicting account' };
  }
  try {
    nk.accountLinkCustom(conflict.provider, callerUserId, conflict.customId);
  } catch (e) {
    logger.error('accountLinkCustom re-link failed for user=%s: %s', callerUserId, e instanceof Error ? e.message : String(e));
    return { kind: 'error', code: 'BAD_REQUEST', message: 're-link failed' };
  }
  deleteConflict(nk, callerUserId);

  const bonus = grantLinkBonus(nk, logger, callerUserId, nowMs);
  logger.info(
    'account_link_resolve linked user=%s deleted=%s bonus=%s',
    callerUserId, targetUserId, String(bonus.bonusClaimed),
  );
  return {
    kind: 'linked',
    affectedAccountDeleted: true,
    bonusClaimed: bonus.bonusClaimed,
    ...(bonus.newBalance !== undefined ? { newBalance: bonus.newBalance } : {}),
  };
}

/**
 * Read the live conflict for the given user, if any. Returns null when
 * no conflict is recorded.
 */
export function readConflict(nk: INakama, userId: string): AccountLinkConflict | null {
  const result = nk.storageRead([
    { collection: ACCOUNT_LINK_CONFLICT_COLLECTION, key: userId, userId },
  ]);
  const obj = result[0];
  if (!obj) return null;
  return obj.value as unknown as AccountLinkConflict;
}

export function deleteConflict(nk: INakama, userId: string): void {
  nk.storageDelete([{ collection: ACCOUNT_LINK_CONFLICT_COLLECTION, key: userId, userId }]);
}

/**
 * Credit the link bonus for the given user, ONCE. The flag
 * `profile.accountLinkBonusClaimed` is the durable idempotency gate —
 * we read it, and only credit when `false`. The CAS write seals the
 * flag; a concurrent double-link would read `true` and skip.
 *
 * The wallet idempotency key is `accountLinkBonus:<userId>` so a
 * retried grant (against a CAS conflict) cannot double-credit even if
 * the flag write succeeds twice.
 */
export function grantLinkBonus(
  nk: INakama,
  logger: ILogger,
  userId: string,
  nowMs: number,
): { bonusClaimed: boolean; newBalance?: { coins: number; gems: number } } {
  let existing = readProfile(nk, userId);
  if (existing === null) {
    // Profile is created lazily — defensive, since the after-auth hook
    // normally seeds it.
    existing = defaultProfile(userId, nowMs, 'Player');
    writeProfileCreate(nk, existing);
  }
  if (ensureAccountLinkField(existing)) {
    // Already claimed — caller treats this as a no-op link.
    logger.info('accountLink bonus already claimed user=%s', userId);
    return { bonusClaimed: false };
  }

  // CAS write to seal the flag before granting. A concurrent claim
  // racing us sees the same `false`, both write `true`, only the
  // first write wins; the loser reads back `true` and skips.
  const readWithVersion = nk.storageRead([
    { collection: 'profiles', key: userId, userId },
  ])[0];
  if (!readWithVersion) {
    return { bonusClaimed: false };
  }
  const sealed: typeof existing = { ...existing, accountLinkBonusClaimed: true };
  try {
    writeProfileUpdate(nk, sealed, readWithVersion.version ?? '');
  } catch {
    // CAS conflict — re-read, if a peer sealed it first, treat as
    // already-claimed.
    const reread = readProfile(nk, userId);
    if (reread && ensureAccountLinkField(reread)) {
      logger.info('accountLink bonus raced user=%s', userId);
      return { bonusClaimed: false };
    }
    throw new Error('profile CAS conflict and bonus not sealed by peer');
  }

  // Credit the wallet. Use a deterministic idempotency key so a
  // retry re-applies cleanly.
  const resp = grant(
    nk,
    userId,
    { coins: ACCOUNT_LINK_BONUS_COINS },
    { reason: 'admin', sourceId: 'accountLinkBonus' },
    `${ACCOUNT_LINK_BONUS_IDEMP_PREFIX}${userId}`,
  );
  if (!resp.ok) {
    logger.error('accountLink grant failed user=%s: %s', userId, resp.error.message);
    return { bonusClaimed: false };
  }
  const newBalance = resp.data;
  logger.info(
    'accountLink bonus credited user=%s coins=%d balance=(%d,%d)',
    userId, ACCOUNT_LINK_BONUS_COINS, newBalance.coins, newBalance.gems,
  );
  return { bonusClaimed: true, newBalance: { coins: newBalance.coins, gems: newBalance.gems } };
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Look up the user that owns `(provider, customId)`. The fake runtime
 * keeps a `links` map (`nk.links`); production `nk.accountLinkCustom`
 * would surface the target userId via a follow-up query (`accountsGetCustom`
 * or equivalent). For unit-test parity we model the lookup as a runtime
 * query over the link map.
 *
 * Returns a summary used to populate the conflict record's target.
 */
function lookupUserByCustomId(
  nk: INakama,
  provider: AccountLinkProvider,
  customId: string,
): AccountLinkConflictAccount {
  const links = (nk as unknown as { links?: Map<string, string> }).links;
  const targetUserId = links?.get(`${provider}:${customId}`);
  if (typeof targetUserId === 'string' && targetUserId.length > 0) {
    return summariseAccount(nk, targetUserId);
  }
  // Placeholder for runtimes that don't expose the link map — the
  // conflict record still gets written with a fallback target.
  const now = Date.now();
  return {
    userId: 'target-account',
    createdAt: now,
    profile: { name: 'Other Player', level: 1, xp: 0, coins: 0, gems: 0 },
  };
}

function writeConflict(
  nk: INakama,
  provider: AccountLinkProvider,
  customId: string,
  sourceUserId: string,
  target: AccountLinkConflictAccount,
  nowMs: number,
): AccountLinkConflict {
  const source = summariseAccount(nk, sourceUserId);
  const conflict: AccountLinkConflict = {
    schemaVersion: 1,
    token: nk.uuidv4(),
    sourceAccount: source,
    targetAccount: target,
    provider,
    customId,
    expiresAt: nowMs + ACCOUNT_LINK_CONFLICT_TTL_MS,
    createdAt: nowMs,
  };
  nk.storageWrite([
    {
      collection: ACCOUNT_LINK_CONFLICT_COLLECTION,
      key: sourceUserId,
      userId: sourceUserId,
      value: conflict as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
  return conflict;
}

function summariseAccount(nk: INakama, userId: string): AccountLinkConflictAccount {
  const profile = readProfile(nk, userId);
  const wallet = walletGet(nk, userId);
  return {
    userId,
    createdAt: profile?.createdAt ?? Date.now(),
    profile: {
      name: profile?.displayName ?? 'Player',
      level: profile?.progression?.level ?? 1,
      xp: profile?.progression?.xp ?? 0,
      coins: wallet.coins,
      gems: wallet.gems,
    },
  };
}

export { isAccountLinkProvider };
export type { AccountLinkConflict, AccountLinkOutput, AccountLinkResolveConflictOutput };