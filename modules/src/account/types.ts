// Account linking and deletion types (plan T-15, T-16).
//
// Linking is native (plan P-02): the client links an identity with the
// Nakama client API (`LinkGoogleAsync`, `LinkAppleAsync`,
// `LinkEmailAsync`, `LinkCustomAsync`, …), which verifies the provider
// token on the server. The RPCs here only read what Nakama verified:
//   - `account_link` credits the one-time link bonus once the account
//     has a linked identity;
//   - `account_link_resolve_conflict` resolves an identity that already
//     belongs to another account, proven by a session of that account.

import type { ClientPlatform } from '../liveops/types';

/**
 * Identities Nakama can link to an account, as `accountGetId` reports
 * them. Device ids are the guest credential, not a link.
 */
export type LinkedProvider =
  | 'apple'
  | 'google'
  | 'facebook'
  | 'facebook_instant_game'
  | 'gamecenter'
  | 'steam'
  | 'email'
  | 'custom';

export const LINKED_PROVIDERS: readonly LinkedProvider[] = [
  'apple',
  'google',
  'facebook',
  'facebook_instant_game',
  'gamecenter',
  'steam',
  'email',
  'custom',
];

export function isLinkedProvider(value: unknown): value is LinkedProvider {
  return typeof value === 'string' && (LINKED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Pending conflict, written by `account_link_resolve_conflict`
 * `step: 'open'` with the session of the account that already owns the
 * identity (the target). System-owned, keyed by the conflict token.
 */
export interface AccountLinkConflict {
  schemaVersion: 2;
  /** UUID v4 — opaque handle returned to the target's session only. */
  token: string;
  /** Account that owns the identity and is deleted on `choice: 'link'`. */
  targetUserId: string;
  /** Identities linked to the target when the conflict was opened. */
  targetProviders: LinkedProvider[];
  /** Epoch-ms; the token is rejected afterwards. */
  expiresAt: number;
  createdAt: number;
}

/**
 * Minimal summary of an account involved in a conflict, enough for the
 * confirmation dialog ("B will be deleted; it has X coins / Lv Z").
 */
export interface AccountLinkConflictAccount {
  userId: string;
  createdAt: number;
  profile: {
    name: string;
    level: number;
    xp: number;
    coins: number;
    gems: number;
  };
}

export interface AccountLinkInput {
  /** Optional: the provider the client just linked natively (must be linked). */
  provider?: LinkedProvider;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface AccountLinkOutput {
  linked: true;
  /** Identities Nakama reports as linked to the caller. */
  providers: LinkedProvider[];
  /** True when the 500-coin bonus was credited on this call. */
  bonusClaimed: boolean;
  newBalance?: { coins: number; gems: number };
}

export interface AccountLinkConflictOpenOutput {
  /** Pass back with `step: 'resolve'` from the session of the account that stays. */
  conflictToken: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  /** The account that will be deleted if the conflict resolves with `link`. */
  target: AccountLinkConflictAccount;
}

export interface AccountLinkResolveConflictInput {
  /** `'open'` (target's session) or `'resolve'` (default; the session that stays). */
  step?: 'open' | 'resolve';
  conflictToken?: string;
  choice?: 'link' | 'cancel';
  /** Required text confirmation when `choice === 'link'`. */
  confirmText?: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface AccountLinkResolveConflictOutput {
  resolved: 'linked' | 'cancelled';
  affectedAccountDeleted?: boolean;
  /** The identities that were on the deleted account: link them again natively. */
  relinkProviders?: LinkedProvider[];
}

export const ACCOUNT_LINK_BONUS_COINS = 500;
export const ACCOUNT_LINK_BONUS_IDEMP_PREFIX = 'accountLinkBonus:';
export const ACCOUNT_LINK_CONFLICT_TTL_MS = 10 * 60 * 1000;
export const ACCOUNT_LINK_CONFLICT_COLLECTION = 'account_link_conflict';
/** Required confirmation text for a destructive `choice === 'link'`. */
export const ACCOUNT_LINK_CONFIRM_TEXT = 'TRANSFER';

// ─── Account delete ─────────────────────────────────────────────────────────

export const ACCOUNT_DELETE_CONFIRM_TEXT = 'DELETE';

export interface AccountDeleteInput {
  /** Literal confirmation text. Must equal `'DELETE'`. */
  confirmText: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface AccountDeleteSummary {
  /** Storage objects owned by the user or keyed by them that were deleted. */
  storageDeleted: number;
  collectionsAffected: string[];
  /** Objects of other owners rewritten or deleted because they named the user. */
  referencesRemoved: number;
  boardsDeleted: number;
  boardsAffected: string[];
  /** Identities that were linked; deleting the account frees them. */
  unlinkedAuths: LinkedProvider[];
  /** Clubs the user created (Nakama deletes a group left without a superadmin). */
  wasClubLeaderOf: string[];
  /** Number of race sessions where the user was marked abandoned. */
  abandonedFromRaces: number;
}

export interface AccountDeleteOutput {
  /** ISO-8601 of the delete. */
  deletedAt: string;
  summary: AccountDeleteSummary;
}
