// Phase 3 garage types. Storage shapes for the per-player garage
// (cars owned + loadout), and catalog shapes for cars / upgrades /
// cosmetics.

import type { ClassId } from '../economy/types';

// ─── Car catalog ──────────────────────────────────────────────────────────────

export interface CarStats {
  speed: number;
  acceleration: number;
  handling: number;
  nitro: number;
}

export interface CarCatalogEntry {
  id: string;
  displayName: string;
  classId: ClassId;
  baseStats: CarStats;
  /** Cap for upgrades (computeStats clamps here). */
  maxStats: CarStats;
  /** Price in `coins`. `0` for the starter car. */
  priceCoins: number;
  /** Price in `gems`. Usually `0`. */
  priceGems?: number;
  /** Minimum level required to buy. */
  requiredLevel: number;
  /** True for the free starter car granted on first auth. */
  isStarter: boolean;
}

/** A catalog car as `config_get` serves it (P-13). Property order is the wire order. */
export interface CatalogCarView {
  id: string;
  displayName: string;
  classId: ClassId;
  baseStats: CarStats;
  maxStats: CarStats;
  priceCoins: number;
  /** `0` when the catalog entry omits it. */
  priceGems: number;
  requiredLevel: number;
  isStarter: boolean;
  /** Localization key of `displayName` (`car.<id>.name`). */
  displayNameKey: string;
}

/** One upgrade line and the car stat it improves, as `config_get` serves it (C-01). */
export interface UpgradeLineView { line: UpgradeLine; stat: keyof CarStats; }
/** One upgrade level of a line for a class (C-01). Property order is the wire order. */
export interface UpgradeLevelView {
  level: number;
  cost: number;
  /** Increment of the line's stat at this level (D-01). */
  delta: number;
}
/** The upgrades catalog as `config_get` serves it (C-01). Property order is the wire order. */
export interface UpgradesView {
  maxLevel: number;
  lines: UpgradeLineView[];
  perCarClass: Record<ClassId, Record<UpgradeLine, UpgradeLevelView[]>>;
}
/** A catalog cosmetic as `config_get` serves it (C-02). Property order is the wire order. */
export interface CatalogCosmeticView {
  id: string;
  displayName: string;
  /** `cosmetic.<id>.name` */
  displayNameKey: string;
  type: CosmeticSlot;
  rarity: CosmeticRarity;
  compatibleClasses: ClassId[];
  /** `0` when absent; informative (the store offer is what is charged). */
  priceCoins: number;
  priceGems: number;
}

export interface CarsCatalog {
  version: number;
  cars: ReadonlyArray<Readonly<CarCatalogEntry>>;
}

// ─── Upgrades catalog ────────────────────────────────────────────────────────

export type UpgradeLine = 'engine' | 'tires' | 'nitro' | 'handling';
export const UPGRADE_LINES: ReadonlyArray<UpgradeLine> = [
  'engine',
  'tires',
  'nitro',
  'handling',
];
export const UPGRADE_MAX = 5;

export interface UpgradeLevelEntry {
  /** Upgrade level this row defines (1..UPGRADE_MAX). */
  level: number;
  /** Cost in `coins` to upgrade FROM level-1 to this level. */
  cost: number;
  /**
   * Increment of this level (NOT cumulative): exactly one key, the stat of
   * the line, with an integer > 0. The stat at level n is
   * min(baseStats + sum(delta_1..n), maxStats).
   */
  delta: Partial<CarStats>;
}

/**
 * Per-class upgrade table. Each class has UPGRADE_MAX rows per line.
 * The computeStats helper sums the per-level delta increments of each
 * line up to the player's current level (level 0 = baseStats) and
 * clamps to `maxStats`.
 */
export interface UpgradesCatalog {
  version: number;
  lines: ReadonlyArray<UpgradeLine>;
  maxLevel: number;
  perCarClass: Readonly<Record<ClassId, Readonly<Record<UpgradeLine, ReadonlyArray<Readonly<UpgradeLevelEntry>>>>>>;
}

// ─── Cosmetics catalog ───────────────────────────────────────────────────────

export type CosmeticSlot = 'paint' | 'wheels' | 'decal' | 'trail' | 'horn';
export const COSMETIC_SLOTS: ReadonlyArray<CosmeticSlot> = [
  'paint',
  'wheels',
  'decal',
  'trail',
  'horn',
];
export type CosmeticRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface CosmeticCatalogEntry {
  id: string;
  displayName: string;
  type: CosmeticSlot;
  rarity: CosmeticRarity;
  priceCoins?: number;
  priceGems?: number;
  /** Classes this cosmetic is compatible with (strict enforcement per Decision 5). */
  compatibleClasses: ReadonlyArray<ClassId>;
}

export interface CosmeticsCatalog {
  version: number;
  items: ReadonlyArray<Readonly<CosmeticCatalogEntry>>;
}

// ─── Owned garage (storage) ───────────────────────────────────────────────────

export interface UpgradeLevels {
  engine: number;
  tires: number;
  nitro: number;
  handling: number;
}

export interface OwnedCosmetics {
  paint?: string;
  wheels?: string;
  decal?: string;
  trail?: string;
  horn?: string;
}

export interface OwnedCar {
  carId: string;
  /** Snapshot of class at purchase time. */
  classId: ClassId;
  upgrades: UpgradeLevels;
  cosmetics: OwnedCosmetics;
  /** Computed stats (post-upgrades). Cache so RPCs don't recompute. */
  computedStats: CarStats;
}

/**
 * Per-player garage storage shape. `loadout` may be null when the
 * player hasn't picked an active car yet (stale starter). Lives at
 * `garage/cars/{userId}` per Chunk 6.
 */
export interface Garage {
  schemaVersion: 1;
  userId: string;
  cars: OwnedCar[];
  /**
   * Catalog cosmetic ids the player has acquired (via the store,
   * Chunk 8). `equipCosmetic` validates the id is in this bag before
   * attaching it to a slot. Phase 3 ships the field empty so v1
   * records round-trip cleanly through `readGarage`.
   */
  cosmeticsBag: string[];
  /**
   * Pack `refId`s the player has already redeemed. Packs are
   * one-time entitlements; the filter hides any pack whose refId is
   * in this list.
   */
  purchasedPacks: string[];
  /** Active car + equipped cosmetics; null when the player hasn't picked yet. */
  loadout: Loadout | null;
  /** First daily-win epoch-ms UTC (or 0 if none today). Updated by Phase 3 subscriber. */
  lastDailyWin: number;
  /** Counter of private races that paid out today (UTC day boundary). */
  dailyPrivateCount: number;
  /** UTC epoch-ms when the daily counters were last reset. */
  dailyResetAt: number;
}

export interface Loadout {
  activeCarId: string;
  equipped: OwnedCosmetics;
  /** Stats snapshot (post-upgrades). */
  stats: CarStats;
}