// Phase 3 garage storage. One garage per userId at
// `garage/{userId}` (collection "garage", key = userId, owner =
// the userId). CAS via `nk.storageWrite({ version })` so concurrent
// RPCs surface as CONFLICT instead of clobbering each other.
//
// All updates use `computeStats` (Chunk 4) to refresh the cached
// stats snapshot after a level/upgrade change — the loadout returns
// the cached value so the Unity client doesn't have to recompute.

import type { IStorageObject, INakama } from '../nkruntime';
import type {
  Garage,
  Loadout,
  OwnedCar,
  OwnedCosmetics,
} from './types';
import type { ClassId } from '../economy/types';
import { getCarsCatalog, getUpgradesCatalog } from './catalog';
import { computeStats } from './stats';
import type { CarCatalogEntry, UpgradeLevels } from './types';

export const GARAGE_COLLECTION = 'garage';

const EMPTY_UPGRADES: UpgradeLevels = {
  engine: 0,
  tires: 0,
  nitro: 0,
  handling: 0,
};

const EMPTY_COSMETICS: OwnedCosmetics = {};

/**
 * Read the garage for a user. Returns `null` if the record hasn't been
 * created yet — callers either lazy-create on read or rely on the
 * after-auth hook to seed it.
 */
export function readGarage(nk: INakama, userId: string): Garage | null {
  const result = nk.storageRead([
    { collection: GARAGE_COLLECTION, key: userId, userId },
  ]);
  const obj = result[0];
  if (!obj) return null;
  return obj.value as unknown as Garage;
}

/**
 * Read the raw storage object (incl. version) so callers can do a
 * CAS update. Returns `null` if the garage does not exist.
 */
export function readGarageObject(
  nk: INakama,
  userId: string,
): { version: string; value: Garage } | null {
  const result = nk.storageRead([
    { collection: GARAGE_COLLECTION, key: userId, userId },
  ]);
  const obj = result[0];
  if (!obj) return null;
  return { version: obj.version ?? '', value: obj.value as unknown as Garage };
}

/**
 * First-time write. Pass `version: undefined` (or omit) — Nakama
 * rejects writes that include a version against a missing record.
 */
export function writeGarageCreate(nk: INakama, garage: Garage): void {
  const obj: IStorageObject = {
    collection: GARAGE_COLLECTION,
    key: garage.userId,
    userId: garage.userId,
    value: garage as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
  };
  nk.storageWrite([obj]);
}

/**
 * CAS update — must include the version captured by the read.
 * Throws on version mismatch (the caller should surface CONFLICT).
 */
export function writeGarageUpdate(
  nk: INakama,
  garage: Garage,
  expectedVersion: string,
): void {
  const obj: IStorageObject = {
    collection: GARAGE_COLLECTION,
    key: garage.userId,
    userId: garage.userId,
    value: garage as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
    version: expectedVersion,
  };
  nk.storageWrite([obj]);
}

// ─── Default garage (first auth) ─────────────────────────────────────────────

/**
 * Locate the catalog's starter car. The catalog validator guarantees
 * exactly one entry has `isStarter: true`; we still defensively throw
 * if a malformed runtime state somehow loses it (which would surface
 * as a clear, actionable error rather than silent corruption).
 */
export function findStarterCar(): CarCatalogEntry {
  const cars = getCarsCatalog().cars;
  for (const c of cars) {
    if (c.isStarter) return c;
  }
  throw new Error('starter car missing from garage catalog');
}

/**
 * Build a default garage for a freshly-authenticated user. The
 * starter car is granted and activated in the loadout so the player
 * can race immediately. Upgrades are zero, cosmetics are empty, and
 * the daily counters start at zero.
 *
 * `userId` is the owner's userId (NOT a system placeholder) so the
 * record is owned by the player.
 */
export function defaultGarage(userId: string, nowMs: number): Garage {
  const starter = findStarterCar();
  const upgrades = getUpgradesCatalog();
  const owned = ownedCarFor(starter, EMPTY_UPGRADES);
  const stats = computeStats(starter, upgrades, owned.upgrades);
  const withStats: OwnedCar = { ...owned, computedStats: stats };
  const loadout: Loadout = {
    activeCarId: starter.id,
    equipped: { ...EMPTY_COSMETICS },
    stats,
  };
  return {
    schemaVersion: 1,
    userId,
    cars: [withStats],
    loadout,
    lastDailyWin: 0,
    dailyPrivateCount: 0,
    dailyResetAt: nowMs,
  };
}

// ─── OwnedCar construction ───────────────────────────────────────────────────

/**
 * Build an `OwnedCar` for a catalog entry at the given upgrade levels.
 * Used by `defaultGarage` and by `car_buy` (Chunk 7). The
 * `computedStats` snapshot is filled in by the caller via
 * `computeStats(...)`.
 */
export function ownedCarFor(
  car: CarCatalogEntry,
  levels: UpgradeLevels,
): OwnedCar {
  return {
    carId: car.id,
    classId: car.classId as ClassId,
    upgrades: { ...levels },
    cosmetics: { ...EMPTY_COSMETICS },
    // Caller fills this in via computeStats once they have the
    // upgrades catalog at hand.
    computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
  };
}

export const EMPTY_OWNED_COSMETICS: OwnedCosmetics = { ...EMPTY_COSMETICS };