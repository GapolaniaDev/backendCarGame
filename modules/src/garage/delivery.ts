// Garage items of a reward, delivered inside the reward's wallet movement
// (plan T-17, T-19, T-20): the caller puts `garageWrite` in
// `moveWallet(..., { extraWrites })`, so the claim, the currencies and the
// items commit or roll back together. A lost garage CAS rolls everything
// back and the caller retries with a fresh read.
//
// Items missing from the catalogs are never invented or dropped silently:
// they come back in `undelivered` (`car:<id>` / `cosmetic:<id>`) for the
// caller to log at error level and report (a content decision, see the
// T-19 catalog content check).

import type { INakama, IStorageObject } from '../nkruntime';
import { getCarsCatalog, getCosmeticsCatalog } from './catalog';
import { addCarToGarage, addCosmeticToBag, defaultGarage, garageWrite, readGarageObject } from './storage';
import type { Garage } from './types';

export interface GarageItems {
  carIds?: ReadonlyArray<string>;
  cosmeticIds?: ReadonlyArray<string>;
}

export interface GarageDeliveryPlan {
  /** CAS write of the garage (create with `*` when the player has none); null when nothing changes. */
  garageWrite: IStorageObject | null;
  cars: string[];
  cosmetics: string[];
  /** Items the player already owned (nothing to deliver). */
  ownedCars: string[];
  ownedCosmetics: string[];
  /** Items missing from the catalogs: `car:<id>` / `cosmetic:<id>`. */
  undelivered: string[];
}

/** Plan the garage write that adds `items` to `userId`'s garage. */
export function planGarageDelivery(nk: INakama, userId: string, items: GarageItems, nowMs: number): GarageDeliveryPlan {
  const plan: GarageDeliveryPlan = {
    garageWrite: null, cars: [], cosmetics: [], ownedCars: [], ownedCosmetics: [], undelivered: [],
  };
  const carIds = (items.carIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const cosmeticIds = (items.cosmeticIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  if (carIds.length === 0 && cosmeticIds.length === 0) return plan;

  const read = readGarageObject(nk, userId);
  let garage: Garage = read?.value ?? defaultGarage(userId, nowMs);
  const before = garage;

  for (const carId of carIds) {
    const car = getCarsCatalog().cars.find((c) => c.id === carId);
    if (!car) plan.undelivered.push(`car:${carId}`);
    else if (garage.cars.some((c) => c.carId === carId)) plan.ownedCars.push(carId);
    else {
      garage = addCarToGarage(garage, car);
      plan.cars.push(carId);
    }
  }
  for (const id of cosmeticIds) {
    if (!getCosmeticsCatalog().items.some((c) => c.id === id)) plan.undelivered.push(`cosmetic:${id}`);
    else if (garage.cosmeticsBag.includes(id)) plan.ownedCosmetics.push(id);
    else {
      garage = addCosmeticToBag(garage, id);
      plan.cosmetics.push(id);
    }
  }
  if (garage !== before) plan.garageWrite = garageWrite(garage, read?.version ?? '*');
  return plan;
}
