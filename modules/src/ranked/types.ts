// Phase 4 ranked types. Per-player rating record shape plus the
// public `ranked_get` output. The runtime rating lives in storage at
// `ranked/{userId}` (collection "ranked", owner = userId, public-read).
//
// Chunk 1 shipped the record + input/output. Chunk 6 expands the
// output shape and adds the storage-meta + inbox shapes that the
// `ranked_get` handler + the lazy-close reward path consume.

export interface RankedRecord {
  schemaVersion: 1;
  userId: string;
  seasonId: string;
  /** Current Elo-style rating. */
  rating: number;
  /** Peak rating reached this season (for the "Peak X" badge). */
  peak: number;
  /** Races completed this season (D6 — counts toward the initial 10 K-factor window). */
  racesPlayed: number;
  /** Wins this season. */
  wins: number;
  /** Top-3 finishes this season. */
  topThree: number;
  /** Consecutive abandons over the last 24h (D6 — triggers the matchmaking block). */
  recentAbandons: number;
  /** UTC epoch-ms when the rating window opens for a delta check (D9). */
  lastRatedAt: number;
  /** Division id at last rated race (for the badge on the loadout). */
  divisionId: string;
}

export interface RankedGetInput {
  /** When omitted, returns the caller's record. When set, returns the
   *  public summary for any user (D11 — always public, never FORBIDDEN). */
  userId?: string;
  callerUserId: string;
}

export interface RankedGetOutput {
  userId: string;
  seasonId: string;
  rating: number;
  peak: number;
  /** Division id derived from `rating` via `divisionForRating`. */
  division: string;
  /** 0.0 at the top of `division` into the next-higher band, 1.0 at the
   *  bottom (one win from promotion). */
  divisionProgress: number;
  racesPlayed: number;
  wins: number;
  topThree: number;
  recentAbandons: number;
  /** Global rank in the season's `ranked_{seasonId}` leaderboard, or
   *  `null` if the player hasn't recorded a result yet. */
  rank: number | null;
  /** Whole days until the season ends (0 once expired). */
  daysLeftInSeason: number;
  /** Phase 4 Chunk 9 — count of ranked abandons in the rolling 24h
   *  window (D6). Powers the "you'll be blocked soon" client banner. */
  abandonsLast24h: number;
  /** Phase 4 Chunk 9 — UTC epoch-ms until the matchmaking block
   *  expires, or `null` when the player is not currently blocked. */
  blockedUntilUtc: number | null;
}

// ─── Season meta ────────────────────────────────────────────────────────────

/** Server-owned status of a ranked season. */
export type SeasonStatus = 'active' | 'closed';

export interface SeasonMeta {
  schemaVersion: 1;
  seasonId: string;
  /** UTC epoch-ms when the season starts. */
  startedAt: number;
  /** UTC epoch-ms when the season ends (exclusive). */
  endsAt: number;
  /** `active` until the lazy-close runs; `closed` once rewards shipped. */
  status: SeasonStatus;
  /** True once every tier reward has been written to the inbox. */
  rewardsDistributed: boolean;
}

// ─── LiveOps inbox (season rewards + future give-back rewards) ──────────────

export type InboxRewardType =
  | 'season_gold'
  | 'season_silver'
  | 'season_bronze'
  | 'season_compensation'
  | 'tournament_prize'
  | 'tournament_voided'
  | 'event_xp_applied'
  | 'iap_purchase'
  | 'subscription_expired'
  | 'subscription_expiring_soon'
  | 'subscription_renewed'
  | 'ad_reward';

export interface InboxRewardPayload {
  /** Optional coin grant. */
  coins?: number;
  /** Cosmetic ids granted. */
  cosmetics?: string[];
  /** Free-form notes for the client. */
  note?: string;
}

export interface InboxEntry {
  schemaVersion: 1;
  rewardId: string;
  userId: string;
  type: InboxRewardType;
  payload: InboxRewardPayload;
  createdAt: number;
  expiresAt: number | null;
  claimed: boolean;
}

// ─── Lazy close rewards ─────────────────────────────────────────────────────

export interface SeasonStandingRow {
  userId: string;
  /** Final rating in the season's leaderboard. */
  rating: number;
  /** 1-indexed global rank. */
  rank: number;
}

export interface SeasonRewardGrant {
  userId: string;
  rank: number;
  type: InboxRewardType;
  payload: InboxRewardPayload;
}

export interface SeasonCloseOutcome {
  /** `true` when this call actually transitioned the season to closed. */
  closed: boolean;
  /** The seasonId that was closed (or `null` if no-op). */
  seasonId: string | null;
  /** The new active seasonId (or `null` if no-op). */
  nextSeasonId: string | null;
  /** Reward grants written to the inbox (empty when no-op). */
  rewards: SeasonRewardGrant[];
}