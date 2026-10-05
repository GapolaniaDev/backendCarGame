// Phase 3 garage stat helpers. Pure functions — given a car catalog
// entry, an upgrade catalog entry, and the player's current upgrade
// levels, compute the effective stats for a race.
//
// Two entry points:
//   - computeStats: base + deltas clamped to maxStats. Used for
//     quick, time_trial, and private modes where the player's tuning
//     matters.
//   - computeStatsForRanked: every stat clamped to the class's
//     maxStats regardless of upgrades. Used for ranked mode so the
//     only variable is driver skill, not wallet size.
//
// These functions don't touch storage and don't talk to Nakama; the
// RPC layer (Chunk 7) wires them up by reading the catalog and the
// OwnedCar record, then calling into here.

import { getUpgradesCatalog } from './catalog';
import type {
  CarCatalogEntry,
  CarStats,
  UpgradeLine,
  UpgradeLevels,
  UpgradesCatalog,
} from './types';
import type { ClassId } from '../economy/types';

const STAT_KEYS: ReadonlyArray<keyof CarStats> = [
  'speed',
  'acceleration',
  'handling',
  'nitro',
];

const UPGRADE_LINE_TO_STAT: Readonly<Record<UpgradeLine, keyof CarStats>> = {
  engine: 'speed',
  tires: 'handling',
  nitro: 'nitro',
  handling: 'acceleration',
};

/**
 * Sum the cumulative delta from each upgrade line at the player's
 * current level. Levels are 1..UPGRADE_MAX; the player owns a level
 * when `levels[line] >= level`. Returns the delta as a
 * `Partial<CarStats>` (only the stats that received a delta appear).
 */
export function cumulativeDelta(
  upgrades: UpgradesCatalog,
  carClass: ClassId,
  levels: UpgradeLevels,
): Partial<CarStats> {
  const lines: ReadonlyArray<UpgradeLine> = upgrades.lines;
  const classTable = upgrades.perCarClass[carClass];
  const out: Partial<CarStats> = {};
  for (const line of lines) {
    const lineTable = classTable[line];
    const ownedLevel = clampLevel(levels[line]);
    let acc = 0;
    for (let lvl = 1; lvl <= ownedLevel; lvl += 1) {
      const entry = lineTable[lvl - 1];
      if (!entry) continue;
      const stat = UPGRADE_LINE_TO_STAT[line];
      const v = entry.delta[stat];
      if (typeof v === 'number') {
        acc += v;
      }
    }
    if (acc !== 0) {
      const stat = UPGRADE_LINE_TO_STAT[line];
      out[stat] = acc;
    }
  }
  return out;
}

function clampLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !Number.isInteger(level)) return 0;
  if (level < 0) return 0;
  if (level > 5) return 5;
  return level;
}

/**
 * Compute the effective stats for a car at the given upgrade levels.
 * Result = baseStats + cumulativeDelta, clamped per-stat to maxStats.
 */
export function computeStats(
  car: CarCatalogEntry,
  upgrades: UpgradesCatalog,
  levels: UpgradeLevels,
): CarStats {
  const delta = cumulativeDelta(upgrades, car.classId, levels);
  const out: CarStats = { speed: 0, acceleration: 0, handling: 0, nitro: 0 };
  for (const key of STAT_KEYS) {
    const base = car.baseStats[key];
    const add = delta[key] ?? 0;
    const max = car.maxStats[key];
    out[key] = clampStat(base + add, max);
  }
  return out;
}

/**
 * Variant for ranked mode: every stat is clamped to the class's
 * `maxStats` regardless of how the player upgraded. The intent is
 * that ranked races reward driver skill, not wallet size.
 *
 * Implementation: compute the regular stats, then take the min with
 * `maxStats`. Empty upgrades → identical to baseStats (still within
 * maxStats), fully upgraded → identical to maxStats.
 */
export function computeStatsForRanked(
  car: CarCatalogEntry,
  upgrades: UpgradesCatalog,
  levels: UpgradeLevels,
): CarStats {
  const regular = computeStats(car, upgrades, levels);
  const out: CarStats = { speed: 0, acceleration: 0, handling: 0, nitro: 0 };
  for (const key of STAT_KEYS) {
    out[key] = Math.min(regular[key], car.maxStats[key]);
  }
  return out;
}

/**
 * Convenience: load the upgrades catalog and call `computeStats`.
 * Tests and the RPC layer can use this directly.
 */
export function computeStatsWithLoadedCatalog(
  car: CarCatalogEntry,
  levels: UpgradeLevels,
  mode: 'normal' | 'ranked' = 'normal',
): CarStats {
  const upgrades = getUpgradesCatalog();
  return mode === 'ranked' ? computeStatsForRanked(car, upgrades, levels) : computeStats(car, upgrades, levels);
}

function clampStat(value: number, max: number): number {
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}