// Phase 3 economy types. The wallet itself is Nakama-native (coins /
// gems); we model only the helpers + reward shapes that ride on top of
// `nk.walletUpdate` / `nk.walletLedgerUpdate`.

import type { RaceModeId } from '../race/types';

export type ClassId = 'D' | 'C' | 'B' | 'A' | 'S';

/**
 * Wallet changeset shape passed to `nk.walletUpdate`. Numbers are
 * SIGNED deltas; positive adds, negative spends. Nakama rejects keys
 * whose names are not registered in the wallet config — for our
 * project `coins` and `gems` are wired at deploy time.
 */
export interface WalletChangeset {
  coins?: number;
  gems?: number;
}

/**
 * Reason attached to every wallet move. Drives both the idempotency
 * cache key and the ledger metadata that ops audits later.
 */
export type LedgerReason = 'race' | 'mission' | 'achievement' | 'store' | 'level' | 'admin' | 'inbox';

/**
 * Compact metadata attached to each wallet move. Nakama accepts ~256
 * bytes per changeset; we use a `motivo:idOrigen` string kept under
 * 200 bytes for safety.
 */
export interface LedgerMetadata {
  /** Reason category. */
  reason: LedgerReason;
  /** Origin id within that reason (sessionId, offerId, level, …). */
  sourceId: string;
  /** Redundant for races; helps auditing across logs. */
  sessionId?: string;
  /** Confidence the race was closed with (when reason === 'race'). */
  confidence?: 'quorum' | 'client' | 'server';
  /** Race mode (when reason === 'race'). */
  mode?: RaceModeId;
}

export type RewardKind = 'coins' | 'gems' | 'xp' | 'car' | 'cosmetic';

/**
 * Reward grants are homogeneous per kind:
 *   - 'coins' / 'gems' / 'xp' carry an integer `amount`
 *   - 'car' / 'cosmetic' carry a `refId` pointing at the catalog entry
 *
 * XP is awarded in the same struct as coins for simplicity — the
 * progression module is the only consumer of `{ kind: 'xp', amount }`.
 */
export interface Reward {
  kind: RewardKind;
  amount?: number;
  refId?: string;
}

/**
 * Aggregation of rewards a single player gets from one race. The
 * reward subscriber builds this per `RaceResult` and applies it
 * via `applyReward()`.
 */
export interface PlayerRewardGrant {
  userId: string;
  rewards: Reward[];
  /** Whether this grant is the player's first win today (UTC). */
  isFirstWinOfDay: boolean;
}

/**
 * Read-only wallet shape returned by `wallet_get`. We only expose the
 * two currencies we own; phase 4 will add rating.
 */
export interface WalletView {
  coins: number;
  gems: number;
}