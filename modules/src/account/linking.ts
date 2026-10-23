// Account linking (plan T-15, P-02: native linking).
//
// The client links identities with the Nakama client API
// (`LinkGoogleAsync`, `LinkAppleAsync`, `LinkEmailAsync`,
// `LinkCustomAsync`, …). Nakama verifies the provider token, so the
// server never sees or signs a link token, and no secret lives in the
// bundle (the old HMAC test token, audit 06 f11, is gone).
//
//   claimLinkBonus — after a native link, credits the one-time 500-coin
//     bonus when `accountGetId` reports a linked identity. The profile
//     flag and the coins go in one wallet movement (`moveWallet`), so a
//     failure leaves both untouched and a retry pays once.
//
//   Conflict — a native link of an identity that belongs to another
//   account fails with `AlreadyExists` (HTTP 409). The client then
//   authenticates with that identity (`create: false`), which Nakama
//   verifies, and gets a session of the other account (the target):
//     1. `openConflict` (target's session) records the target in
//        `account_link_conflict/<token>` and returns the token;
//     2. `resolveConflict` (the session that stays) with
//        `choice: 'link'` deletes the target with the full account
//        purge, which frees its identities, and the client links them
//        again natively; `choice: 'cancel'` drops the record.
//   Both sessions are needed, so a caller can only delete an account it
//   has authenticated as (audit 06 f12: no placeholder account).

import type { ILogger, INakama, IStorageObject } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { moveWallet, walletGet } from '../economy/wallet';
import {
  defaultProfile,
  ensureAccountLinkField,
  PROFILES_COLLECTION,
  type ProfileRecord,
} from '../profiles/storage';
import { SYSTEM_USER_ID } from '../race/constants';
import {
  ACCOUNT_LINK_BONUS_COINS,
  ACCOUNT_LINK_BONUS_IDEMP_PREFIX,
  ACCOUNT_LINK_CONFIRM_TEXT,
  ACCOUNT_LINK_CONFLICT_COLLECTION,
  ACCOUNT_LINK_CONFLICT_TTL_MS,
  type AccountLinkConflict,
  type AccountLinkConflictAccount,
  type AccountLinkConflictOpenOutput,
  type AccountLinkResolveConflictOutput,
} from './types';
import { deleteAccount } from './delete';
import { linkedProviders } from './identities';

const BONUS_CAS_ATTEMPTS = 3;

// ─── Link bonus ──────────────────────────────────────────────────────────────

export interface LinkBonusOutcome {
  bonusClaimed: boolean;
  newBalance?: { coins: number; gems: number };
}

/**
 * Credit the link bonus ONCE per account: the `accountLinkBonusClaimed`
 * profile flag (CAS) and the coins are one `moveWallet` with the durable
 * key `accountLinkBonus:<userId>`. Concurrent calls pay once; a lost
 * profile CAS retries with a fresh read.
 */
export function claimLinkBonus(nk: INakama, logger: ILogger, userId: string, nowMs: number): Resp<LinkBonusOutcome> {
  for (let attempt = 1; attempt <= BONUS_CAS_ATTEMPTS; attempt++) {
    const read = nk.storageRead([{ collection: PROFILES_COLLECTION, key: userId, userId }])[0];
    const profile: ProfileRecord = read
      ? (read.value as unknown as ProfileRecord)
      : defaultProfile(userId, nowMs, 'Player');
    if (ensureAccountLinkField(profile)) return ok({ bonusClaimed: false });

    const sealed: IStorageObject = {
      collection: PROFILES_COLLECTION,
      key: userId,
      userId,
      value: { ...profile, accountLinkBonusClaimed: true } as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
      version: read?.version ?? '*',
    };
    const moved = moveWallet(
      nk,
      userId,
      `${ACCOUNT_LINK_BONUS_IDEMP_PREFIX}${userId}`,
      [{ changeset: { coins: ACCOUNT_LINK_BONUS_COINS }, metadata: { reason: 'admin', sourceId: 'accountLinkBonus' } }],
      { extraWrites: [sealed] },
    );
    if (moved.ok) {
      if (moved.data.replayed) return ok({ bonusClaimed: false });
      logger.info('accountLink bonus credited user=%s coins=%d', userId, ACCOUNT_LINK_BONUS_COINS);
      return ok({ bonusClaimed: true, newBalance: moved.data.balance });
    }
    if (moved.error.code !== 'CONFLICT') return moved;
    logger.warn('accountLink bonus CAS lost user=%s attempt=%d', userId, attempt);
  }
  return err('CONFLICT', 'concurrent profile update; nothing was credited, please retry', { reason: 'VERSION_CONFLICT' });
}

// ─── Conflict ────────────────────────────────────────────────────────────────

export function summariseAccount(nk: INakama, userId: string): AccountLinkConflictAccount {
  const read = nk.storageRead([{ collection: PROFILES_COLLECTION, key: userId, userId }])[0];
  const profile = read ? (read.value as unknown as ProfileRecord) : null;
  const wallet = walletGet(nk, userId);
  return {
    userId,
    createdAt: profile?.createdAt ?? 0,
    profile: {
      name: profile?.displayName ?? 'Player',
      level: profile?.progression?.level ?? 1,
      xp: profile?.progression?.xp ?? 0,
      coins: wallet.coins,
      gems: wallet.gems,
    },
  };
}

/**
 * Step 1, with the session of the account that owns the identity. The
 * caller proved it controls the target by authenticating as it.
 */
export function openConflict(
  nk: INakama,
  logger: ILogger,
  targetUserId: string,
  nowMs: number,
): Resp<AccountLinkConflictOpenOutput> {
  const providers = linkedProviders(nk, targetUserId);
  if (providers === null) return err('NOT_FOUND', 'account not found');
  if (providers.length === 0) {
    return err('CONFLICT', 'this account has no linked identity to transfer', { reason: 'NOT_LINKED' });
  }
  const conflict: AccountLinkConflict = {
    schemaVersion: 2,
    token: nk.uuidv4(),
    targetUserId,
    targetProviders: providers,
    expiresAt: nowMs + ACCOUNT_LINK_CONFLICT_TTL_MS,
    createdAt: nowMs,
  };
  nk.storageWrite([
    {
      collection: ACCOUNT_LINK_CONFLICT_COLLECTION,
      key: conflict.token,
      userId: SYSTEM_USER_ID,
      value: conflict as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
  logger.info('account_link conflict opened target=%s providers=%j', targetUserId, providers);
  return ok({
    conflictToken: conflict.token,
    expiresAt: new Date(conflict.expiresAt).toISOString(),
    target: summariseAccount(nk, targetUserId),
  });
}

export interface ResolveConflictInput {
  conflictToken: string;
  choice: 'link' | 'cancel';
  confirmText?: string;
}

/**
 * Step 2, with the session of the account that stays. `link` deletes the
 * target (full purge, `deleteAccount`), which frees its identities for a
 * native re-link; `cancel` drops the record.
 */
export function resolveConflict(
  nk: INakama,
  logger: ILogger,
  callerUserId: string,
  input: ResolveConflictInput,
  nowMs: number,
): Resp<AccountLinkResolveConflictOutput> {
  const conflict = readConflict(nk, input.conflictToken);
  if (conflict === null) return err('NOT_FOUND', 'conflict not found');
  if (conflict.expiresAt <= nowMs) {
    deleteConflict(nk, input.conflictToken);
    return err('NOT_FOUND', 'conflict expired');
  }
  if (input.choice === 'cancel') {
    deleteConflict(nk, input.conflictToken);
    logger.info('account_link_resolve cancelled user=%s target=%s', callerUserId, conflict.targetUserId);
    return ok({ resolved: 'cancelled' });
  }
  if (conflict.targetUserId === callerUserId) {
    return err('BAD_REQUEST', 'resolve the conflict from the account that keeps the identity, not the one being deleted');
  }
  if (input.confirmText !== ACCOUNT_LINK_CONFIRM_TEXT) {
    return err('BAD_REQUEST', `confirmation required: pass confirmText="${ACCOUNT_LINK_CONFIRM_TEXT}"`);
  }
  if (linkedProviders(nk, conflict.targetUserId) === null) {
    deleteConflict(nk, input.conflictToken);
    return err('NOT_FOUND', 'the other account no longer exists');
  }
  const deleted = deleteAccount(nk, logger, conflict.targetUserId);
  if (!deleted.ok) return deleted;
  deleteConflict(nk, input.conflictToken);
  logger.warn(
    'account_link_resolve linked user=%s deleted=%s relink=%j',
    callerUserId, conflict.targetUserId, conflict.targetProviders,
  );
  return ok({ resolved: 'linked', affectedAccountDeleted: true, relinkProviders: conflict.targetProviders });
}

function readConflict(nk: INakama, token: string): AccountLinkConflict | null {
  const obj = nk.storageRead([
    { collection: ACCOUNT_LINK_CONFLICT_COLLECTION, key: token, userId: SYSTEM_USER_ID },
  ])[0];
  if (!obj) return null;
  const v = obj.value as Partial<AccountLinkConflict>;
  if (v.schemaVersion !== 2 || typeof v.targetUserId !== 'string') return null;
  return v as AccountLinkConflict;
}

function deleteConflict(nk: INakama, token: string): void {
  nk.storageDelete([{ collection: ACCOUNT_LINK_CONFLICT_COLLECTION, key: token, userId: SYSTEM_USER_ID }]);
}
