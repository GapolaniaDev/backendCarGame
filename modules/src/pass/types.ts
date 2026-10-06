// Phase 6 types — battle pass catalog + per-user PassRecord.

export interface PassLevelReward {
  coins?: number;
  gems?: number;
  cosmeticId?: string;
  carId?: string;
}

export interface PassLevel {
  level: number;
  xpRequired: number;
  freeReward: PassLevelReward;
  premiumReward: PassLevelReward;
}

export interface PassCatalog {
  version: 1;
  seasonId: string;
  /** ISO UTC string for season start. */
  startUtc: string;
  /** ISO UTC string for season end. */
  endUtc: string;
  maxLevel: number;
  readonly levels: ReadonlyArray<Readonly<PassLevel>>;
  /** Gems price for premium track. */
  premiumPriceGems: number;
}

export interface PassRecord {
  schemaVersion: 1;
  userId: string;
  seasonId: string;
  /** Cumulative pass XP (NOT profile XP — pass levels are distinct). */
  xp: number;
  /** Levels for which the free reward has been collected. */
  claimedFree: number[];
  /** Levels for which the premium reward has been collected. */
  claimedPremium: number[];
  /** Whether the player bought the premium track. */
  premiumPurchased: boolean;
  /** Marked true on lazy close (D11). */
  seasonClosed: boolean;
}