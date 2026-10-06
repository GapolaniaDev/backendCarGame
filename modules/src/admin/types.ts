// Phase 5 Chunk 6 — Admin RPC I/O types.
//
// All admin RPCs are HTTP-key-protected (see `admin/auth.ts`) and
// bypass the maintenance gate (precedent: `account_delete`, Chunk 5).
// Each RPC reads `body.adminKey` and operates server-side on behalf
// of the admin tool — there is NO per-user auth on the RPC itself.

import type { InboxRewardPayload, InboxKind } from '../liveops/messages';

// ─── admin_wallet_adjust ────────────────────────────────────────────────────

export interface AdminWalletAdjustInput {
  /** Required shared secret (assertAdminKey checks it). */
  adminKey: string;
  /** Target user. */
  userId: string;
  /** Optional coin delta (positive or negative). */
  coins?: number;
  /** Optional gem delta (positive or negative). */
  gems?: number;
  /** Free-text audit reason. Mandatory. */
  reason: string;
}

export interface AdminWalletAdjustOutput {
  newBalance: { coins: number; gems: number };
}

// ─── admin_send_inbox ──────────────────────────────────────────────────────

export interface AdminSendInboxInput {
  adminKey: string;
  /**
   * If an array, send to each userId. If the literal string `'all'`,
   * the request is rejected with NOT_IMPLEMENTED (broadcast would
   * require enumerating every userId and is deferred to a later
   * batch-job chunk).
   */
  userIds: string[] | 'all';
  message: {
    kind: InboxKind;
    title: string;
    body: string;
    reward?: InboxRewardPayload;
    /** Optional override of the 30d retention. Epoch-ms. */
    expiresAt?: number;
  };
}

export interface AdminSendInboxOutput {
  delivered: number;
}

// ─── admin_sanitize_session ────────────────────────────────────────────────

export interface AdminSanitizeSessionInput {
  adminKey: string;
  sessionId: string;
  /** Mandatory non-empty reason — sanitization is destructive. */
  reviewReason: string;
  /**
   * When true, also remove every human roster entry from their
   * leaderboards and abandon-mark them in the session.
   */
  removeFromLeaderboards: boolean;
}

export interface AdminSanitizeSessionOutput {
  sessionId: string;
  needsReview: boolean;
}

// ─── admin_remove_player ──────────────────────────────────────────────────

export interface AdminRemovePlayerInput {
  adminKey: string;
  userId: string;
  /** Mandatory non-empty reason — archived is reversible but visible. */
  reason: string;
}

export interface AdminRemovePlayerOutput {
  removedAt: number;
  /** Number of active sessions the user was abandoned from. */
  abandonedFromRaces: number;
}

// ─── admin_cleanup_race_sessions ───────────────────────────────────────────

export interface AdminCleanupRaceSessionsInput {
  adminKey: string;
}

export interface AdminCleanupRaceSessionsOutput {
  deleted: number;
}