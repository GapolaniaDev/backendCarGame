// Phase 4 ranked types. Per-player rating record shape plus the
// public `ranked_get` output. The runtime rating lives in storage at
// `ranked/{userId}/{seasonId}` (collection "ranked", owner = userId).
//
// Chunk 1 ships the shapes; the storage helpers land in Chunk 3
// along with the first `ranked_get` wire-up.

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
   *  public summary for any user (D11). */
  userId?: string;
  /** When omitted, the current season per `findActiveSeason`. */
  seasonId?: string;
  callerUserId: string;
}

export interface RankedGetOutput {
  seasonId: string;
  divisionId: string;
  rating: number;
  peak: number;
  rank: number;
  topPercent: number;
  recentAbandons: number;
}