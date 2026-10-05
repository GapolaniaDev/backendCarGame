// Phase 3 progression types. The level table is pure data; the
// progression subscriber (Chunk 5) consumes `RaceCompleted` and
// applies XP through these shapes.

import type { ClassId } from '../economy/types';

/** Hard cap on player level — XP beyond this is discarded. */
export const MAX_LEVEL = 50;

/** A single row in the XP curve. Levels not listed are interpolated. */
export interface LevelEntry {
  /** 1-indexed level. */
  level: number;
  /** Cumulative XP required to BE this level (i.e. just reached it). */
  xpRequired: number;
  /** Rewards granted the FIRST time this level is reached. */
  rewards: { coins?: number; gems?: number };
  /** Catalog-level unlocks granted at this level. */
  unlocks: ReadonlyArray<string>;
}

export interface LevelsCatalog {
  version: number;
  maxLevel: number;
  /** 'exponential' uses the synthetic curve; 'table' uses the literal table. */
  xpCurve: 'exponential' | 'table';
  /** Literal level entries. Required when xpCurve === 'table'. */
  table: ReadonlyArray<Readonly<LevelEntry>>;
}

/** Per-player XP/level snapshot. */
export interface LevelInfo {
  /** Current level (1..MAX_LEVEL). */
  level: number;
  /** Cumulative XP across all races. */
  xp: number;
  /** XP needed to reach `level + 1`. `0` when at MAX_LEVEL. */
  xpToNextLevel: number;
  /** Catalog-level unlocks the player has earned (cumulative across levels). */
  unlockedLevels: string[];
}

/**
 * Car-unlock summary: which class is purchasable at which level. The
 * garage catalog references these via `requiredLevel`.
 */
export interface ClassUnlockTable {
  /** Maps a level (1..50) to the class id that becomes purchasable. */
  byLevel: Record<number, ClassId>;
}