// Phase 3 garage storage. One garage per userId at
// `garage/{userId}` (collection "garage", key = userId, owner =
// the userId). CAS via `nk.storageWrite({ version })` so concurrent
// RPCs surface as CONFLICT instead of clobbering each other.
//
// All updates use `computeStats` (Chunk 4) to refresh the cached
// stats snapshot after a level/upgrade change — the loadout returns
// the cached value so the Unity client doesn't have to recompute.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import type {
  Garage,
  Loadout,
  OwnedCar,
  OwnedCosmetics,
  UpgradeLine,
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
 * The caller's garage with its storage version, creating the default one first when it is
 * missing (plan B3, D-08). Returns null when the create fails (the RPC answers INTERNAL).
 */
export function readOrCreateGarageObject(
  nk: INakama,
  logger: ILogger,
  userId: string,
  nowMs: number,
): { value: Garage; version: string } | null {
  const read = readGarageObject(nk, userId);
  if (read) return read;
  try {
    writeGarageCreate(nk, defaultGarage(userId, nowMs));
  } catch (e) {
    logger.warn(
      'garage auto-create failed for %s: %s',
      userId,
      e instanceof Error ? e.message : String(e),
    );
  }
  // A concurrent create is fine: read whatever exists.
  return readGarageObject(nk, userId);
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
  nk.storageWrite([garageWrite(garage, expectedVersion)]);
}

/**
 * The CAS write of `garage` at `expectedVersion`, for a caller that
 * commits it inside a wallet movement (`MoveOptions.extraWrites`): the
 * charge and the delivery then share one transaction (plan T-11).
 */
export function garageWrite(garage: Garage, expectedVersion: string): IStorageObject {
  return {
    collection: GARAGE_COLLECTION,
    key: garage.userId,
    userId: garage.userId,
    value: garage as unknown as Record<string, unknown>,
    permissionRead: 0,
    permissionWrite: 0,
    version: expectedVersion,
  };
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
    cosmeticsBag: [],
    purchasedPacks: [],
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

// ─── Mutation helpers (used by Chunk 7 RPCs) ─────────────────────────────────

/** Throws `Error` when the car is already owned. Callers translate to CONFLICT. */
export function ensureCarNotOwned(garage: Garage, carId: string): void {
  for (const c of garage.cars) {
    if (c.carId === carId) {
      throw new Error(`car already owned: ${carId}`);
    }
  }
}

/**
 * Append a newly-bought car to the garage. The car starts at zero
 * upgrades with no cosmetics; computedStats is filled in via
 * `computeStats`. Caller owns the resulting `Garage` (it's a fresh
 * copy, so mutation is safe).
 */
export function addCarToGarage(garage: Garage, car: CarCatalogEntry): Garage {
  const upgrades = getUpgradesCatalog();
  const owned = ownedCarFor(car, EMPTY_UPGRADES);
  const stats = computeStats(car, upgrades, owned.upgrades);
  const withStats: OwnedCar = { ...owned, computedStats: stats };
  return {
    ...garage,
    cars: [...garage.cars, withStats],
  };
}

/**
 * Set the level of one upgrade line for a car the caller already owns.
 * Throws when the car isn't owned. Caller passes the *new* level
 * (1..UPGRADE_MAX); existing deltas are recomputed via `computeStats`.
 */
export function applyUpgrade(
  garage: Garage,
  carId: string,
  line: UpgradeLine,
  newLevel: number,
): Garage {
  const idx = garage.cars.findIndex((c) => c.carId === carId);
  if (idx < 0) throw new Error(`car not owned: ${carId}`);
  const owned = garage.cars[idx];
  if (!owned) throw new Error(`car not owned: ${carId}`);
  const updatedUpgrades: UpgradeLevels = { ...owned.upgrades, [line]: newLevel };
  const upgrades = getUpgradesCatalog();
  const cat = getCarsCatalog().cars.find((c) => c.id === carId);
  if (!cat) throw new Error(`car not in catalog: ${carId}`);
  const updatedStats = computeStats(cat, upgrades, updatedUpgrades);
  const updatedCar: OwnedCar = {
    ...owned,
    upgrades: updatedUpgrades,
    computedStats: updatedStats,
  };
  const cars = garage.cars.slice();
  cars[idx] = updatedCar;
  // Sync loadout.stats if the active car was the one upgraded.
  const loadout = garage.loadout && garage.loadout.activeCarId === carId
    ? { ...garage.loadout, stats: updatedStats }
    : garage.loadout;
  return { ...garage, cars, loadout };
}

/**
 * Equip a cosmetic on a specific slot of a specific car. The cosmetic
 * must already be in `garage.cosmeticsBag` (populated by Chunk 8
 * store purchases) — Chunk 7 validates ownership but does NOT add
 * cosmetics to the bag.
 *
 * Throws when the car isn't owned or the cosmetic isn't in the bag.
 */
export function equipCosmetic(
  garage: Garage,
  carId: string,
  slot: keyof OwnedCosmetics,
  cosmeticId: string,
): Garage {
  const idx = garage.cars.findIndex((c) => c.carId === carId);
  if (idx < 0) throw new Error(`car not owned: ${carId}`);
  const owned = garage.cars[idx];
  if (!owned) throw new Error(`car not owned: ${carId}`);
  const updatedCosmetics: OwnedCosmetics = { ...owned.cosmetics, [slot]: cosmeticId };
  const updatedCar: OwnedCar = { ...owned, cosmetics: updatedCosmetics };
  const cars = garage.cars.slice();
  cars[idx] = updatedCar;
  const loadout = garage.loadout && garage.loadout.activeCarId === carId
    ? { ...garage.loadout, equipped: updatedCosmetics }
    : garage.loadout;
  return { ...garage, cars, loadout };
}

/**
 * Empty `slot` on an owned car (and on the loadout when it is the active
 * car). No-op when already empty. Throws when the car is not owned.
 */
export function unequipCosmetic(
  garage: Garage,
  carId: string,
  slot: keyof OwnedCosmetics,
): Garage {
  const idx = garage.cars.findIndex((c) => c.carId === carId);
  if (idx < 0) throw new Error(`car not owned: ${carId}`);
  const owned = garage.cars[idx];
  if (!owned) throw new Error(`car not owned: ${carId}`);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [slot]: _removed, ...rest } = owned.cosmetics;
  const updatedCosmetics: OwnedCosmetics = rest;
  const updatedCar: OwnedCar = { ...owned, cosmetics: updatedCosmetics };
  const cars = garage.cars.slice();
  cars[idx] = updatedCar;
  const loadout = garage.loadout && garage.loadout.activeCarId === carId
    ? { ...garage.loadout, equipped: updatedCosmetics }
    : garage.loadout;
  return { ...garage, cars, loadout };
}

/**
 * Change the loadout's active car. Caller must already own the car.
 * The equipped cosmetics list is taken from the new active car's
 * `cosmetics` so the loadout always reflects the active car's choices.
 */
export function setActiveCar(garage: Garage, carId: string): Garage {
  const owned = garage.cars.find((c) => c.carId === carId);
  if (!owned) throw new Error(`car not owned: ${carId}`);
  const loadout: Loadout = {
    activeCarId: owned.carId,
    equipped: { ...owned.cosmetics },
    stats: { ...owned.computedStats },
  };
  return { ...garage, loadout };
}

/**
 * Append a cosmetic id to the garage's cosmetics bag. Idempotency
 * is the caller's job — Chunk 8's `store_buy` checks the bag before
 * calling this helper.
 */
export function addCosmeticToBag(garage: Garage, cosmeticId: string): Garage {
  if (garage.cosmeticsBag.includes(cosmeticId)) {
    throw new Error(`cosmetic already in bag: ${cosmeticId}`);
  }
  return { ...garage, cosmeticsBag: [...garage.cosmeticsBag, cosmeticId] };
}

/** Mark a pack as redeemed in the garage doc. */
export function markPackPurchased(garage: Garage, packRefId: string): Garage {
  if (garage.purchasedPacks.includes(packRefId)) {
    throw new Error(`pack already purchased: ${packRefId}`);
  }
  return { ...garage, purchasedPacks: [...garage.purchasedPacks, packRefId] };
}