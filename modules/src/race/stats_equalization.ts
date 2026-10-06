// Phase 4 Chunk 8: stats equalization for ranked sessions.
//
// Ranked rosters must compete on driver skill, not wallet size. The
// helper in this module reads a player's garage, finds the OwnedCar
// matching the race loadout's `bodyId`, and computes the effective
// stats:
//   - mode='ranked' → `computeStatsForRanked(car, upgrades, levels)`:
//     every stat clamped to the car's `maxStats` (class-top).
//   - otherwise    → `computeStats(car, upgrades, levels)`:
//     base + upgrades, clamped per-stat.
//
// Returns `null` when the garage or the OwnedCar is missing — the
// caller then proceeds WITHOUT a `stats` field on the loadout (the
// legacy behaviour). The race submit_report clock / lap validations
// stay open because they read `loadout.classId`, not stats.
//
// Called from:
//   - race_session_create (host's loadout)
//   - race_session_quick_bots (caller's loadout)
//   - matchmaking/matched_hook (every roster entry's loadout)

import type { INakama } from '../nkruntime';
import { getCarsCatalog, getUpgradesCatalog } from '../garage/catalog';
import { computeStats, computeStatsForRanked } from '../garage/stats';
import { readGarage } from '../garage/storage';
import type { CarStats, OwnedCar } from '../garage/types';
import type { Loadout } from './types';

const EMPTY_OWNED_CAR: OwnedCar = {
  carId: '',
  classId: 'D',
  upgrades: { engine: 0, tires: 0, nitro: 0, handling: 0 },
  cosmetics: {},
  computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
};

/**
 * Compute the effective stats for `userId`'s car identified by
 * `loadout.bodyId`. Returns `null` when the user has no garage yet
 * (defensive — caller proceeds without a `stats` field).
 */
export function loadoutStatsFor(
  nk: INakama,
  userId: string,
  loadout: Loadout,
  mode: 'ranked' | 'normal',
): CarStats | null {
  const garage = readGarage(nk, userId);
  if (garage === null) return null;
  const owned = garage.cars.find((c) => c.carId === loadout.bodyId);
  if (owned === undefined) return null;
  const car = getCarsCatalog().cars.find((c) => c.id === loadout.bodyId);
  if (car === undefined) return null;
  return computeEffectiveStats(car, owned, mode);
}

/**
 * Pure variant that operates on the already-resolved catalog entry +
 * the OwnedCar. Exposed for unit tests; production callers should use
 * `loadoutStatsFor`.
 */
export function computeEffectiveStats(
  car: { id: string; classId: string; baseStats: CarStats; maxStats: CarStats },
  owned: OwnedCar,
  mode: 'ranked' | 'normal',
): CarStats {
  const upgrades = getUpgradesCatalog();
  const stats =
    mode === 'ranked'
      ? computeStatsForRanked(car as never, upgrades, owned.upgrades)
      : computeStats(car as never, upgrades, owned.upgrades);
  return stats;
}

/**
 * Convenience: returns a fresh empty OwnedCar. Used by tests so they
 * don't have to construct one inline. Exposed via a stable symbol so
 * future migrations don't have to rebuild the shape.
 */
export function emptyOwnedCar(): OwnedCar {
  return { ...EMPTY_OWNED_CAR, upgrades: { ...EMPTY_OWNED_CAR.upgrades } };
}