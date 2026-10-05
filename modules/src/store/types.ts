// Phase 3 store types. The store is read-only catalog data with a
// daily rotation overlay. No persistent player state lives here.

export type StoreSectionId = 'permanent' | 'daily' | 'level_gated';
export const STORE_SECTION_IDS: ReadonlyArray<StoreSectionId> = [
  'permanent',
  'daily',
  'level_gated',
];

export type StoreOfferKind = 'car' | 'cosmetic' | 'pack';

export interface StoreOffer {
  offerId: string;
  kind: StoreOfferKind;
  /** Catalog reference id for `car` and `cosmetic` offers; free-form for `pack`. */
  refId: string;
  /** Display name shown in the shop UI. */
  displayName: string;
  /** Price in coins (optional — gems-only offers omit this). */
  priceCoins?: number;
  /** Price in gems (optional). */
  priceGems?: number;
  /** Minimum player level required. */
  requiredLevel?: number;
  /** Epoch-ms when this offer stops being claimable. `null` = no expiry. */
  expiresAt?: number | null;
}

export interface StoreSection {
  id: StoreSectionId;
  displayName: string;
  offers: ReadonlyArray<Readonly<StoreOffer>>;
}

export interface StoreCatalog {
  version: number;
  sections: ReadonlyArray<Readonly<StoreSection>>;
  /** Number of offers to surface from the `daily` pool each UTC day. */
  dailyRotationPoolSize: number;
}

/**
 * Result of resolving the daily rotation for a given UTC day. The
 * `dailySeed` is the deterministic input (`YYYY-MM-DD`) so two clients
 * see the same offers on the same day (Decision 4).
 */
export interface DailyRotationResult {
  /** The day key (UTC) used as the rotation seed. */
  dailySeed: string;
  /** Offers to surface for the daily section, ordered. */
  offers: StoreOffer[];
}

/**
 * Outcome of a `store_buy` RPC. Mirrors the reward envelope so the
 * client can update its local inventory cache without a second RPC.
 */
export interface StoreBuyDelivery {
  kind: StoreOfferKind;
  refId: string;
  count?: number;
}