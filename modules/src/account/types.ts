// Phase 5 Chunk 4 — Account linking types.
//
// Stores claim records (created when `nk.accountLinkCustom` throws the
// `ACCOUNT_LINK_CONFIRM_REQUIRED` error code) and the inputs needed to
// resolve them.

import type { ClientPlatform } from '../liveops/types';

export type AccountLinkProvider = 'apple' | 'google' | 'email' | 'custom';

/**
 * Per-conflict record. Persisted in the `account_link_conflict/{userId}`
 * collection (server-only write) until the conflict is resolved or the
 * 24h TTL passes. The `token` is the opaque handle the client passes
 * back via `account_link_resolve_conflict`.
 */
export interface AccountLinkConflict {
  schemaVersion: 1;
  /** UUID v4 — opaque handle returned to the client. */
  token: string;
  /** Account that initiated the link attempt (the device-auth user). */
  sourceAccount: AccountLinkConflictAccount;
  /** Account already owning the customId (will be deleted on resolve-link). */
  targetAccount: AccountLinkConflictAccount;
  provider: AccountLinkProvider;
  /** Stable provider-side identifier (Apple `sub`, Google `email`, …). */
  customId: string;
  /** Epoch-ms when the conflict record expires (24h after `createdAt`). */
  expiresAt: number;
  createdAt: number;
}

/**
 * Minimal summary of each account involved in a link conflict. Enough
 * for the client to render a confirmation dialog ("B will be deleted;
 * A keeps X coins / Y gems / Lv Z") without leaking the full profile.
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
  provider: AccountLinkProvider;
  /** Provider ID token (Apple/Google) or magic-link token (email). */
  token: string;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface AccountLinkOutput {
  /** True when the link succeeded without a conflict. */
  linked: true;
  /** True when the 500-coin bonus was credited on this call. */
  bonusClaimed: boolean;
  newBalance?: { coins: number; gems: number };
}

export interface AccountLinkConflictOutput {
  /** Conflict token — caller passes back to `account_link_resolve_conflict`. */
  conflictToken: string;
  /** ISO-8601 expiry (24h after creation). */
  expiresAt: string;
  /** Echo of the source account summary for the confirmation UI. */
  source: AccountLinkConflictAccount;
  /** Echo of the (about-to-be-deleted) target account summary. */
  target: AccountLinkConflictAccount;
}

export interface AccountLinkResolveConflictInput {
  conflictToken: string;
  choice: 'link' | 'cancel';
  /** Required text confirmation when `choice === 'link'`. */
  confirmText?: string;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface AccountLinkResolveConflictOutput {
  resolved: 'linked' | 'cancelled';
  affectedAccountDeleted?: boolean;
  bonusClaimed?: boolean;
  newBalance?: { coins: number; gems: number };
}

export const ACCOUNT_LINK_BONUS_COINS = 500;
export const ACCOUNT_LINK_BONUS_IDEMP_PREFIX = 'accountLinkBonus:';
export const ACCOUNT_LINK_CONFLICT_TTL_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_LINK_CONFLICT_COLLECTION = 'account_link_conflict';
/** Required confirmation text for a destructive `choice === 'link'`. */
export const ACCOUNT_LINK_CONFIRM_TEXT = 'TRANSFER';

export function isAccountLinkProvider(value: unknown): value is AccountLinkProvider {
  return value === 'apple' || value === 'google' || value === 'email' || value === 'custom';
}