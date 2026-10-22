// Server-side race loadout (plan T-10, audit PC-16 / Audit 05 f19).
//
// The race loadout used to come from the RPC body: a client could declare
// a class-S car it does not own and lower the min-time floor that
// `validateSubmissionStep2` derives from `loadout.classId`. The loadout is
// now taken from the player's garage:
//   - the declared `bodyId` when the player owns that car;
//   - otherwise the garage's active car (or the first owned car);
//   - with no garage at all, the catalog starter car (the strictest floor).
// `classId` always comes from the cars catalog. A declared loadout that
// differs is ignored with a warning. `liveryId` is cosmetic and kept as
// declared.

import type { ILogger, INakama } from '../nkruntime';
import { getCarsCatalog } from '../garage/catalog';
import { readGarage, findStarterCar } from '../garage/storage';
import type { CarCatalogEntry, OwnedCar } from '../garage/types';
import { computeEffectiveStats } from './stats_equalization';
import type { CarClassId, Loadout } from './types';

/**
 * Resolve `userId`'s race loadout from their garage. `declared` is the
 * body loadout (may be null for matchmaker sessions); `context` names the
 * caller in the mismatch warning.
 */
export function resolveServerLoadout(
  nk: INakama,
  logger: ILogger,
  userId: string,
  declared: Loadout | null,
  mode: 'ranked' | 'normal',
  context: string,
): Loadout {
  const catalog = getCarsCatalog().cars;
  const garage = readGarage(nk, userId);
  const cars = garage?.cars ?? [];

  let owned: OwnedCar | undefined;
  if (declared !== null) owned = cars.find((c) => c.carId === declared.bodyId);
  if (owned === undefined) {
    const activeId = garage?.loadout?.activeCarId;
    owned = cars.find((c) => c.carId === activeId) ?? cars[0];
  }

  let entry: Readonly<CarCatalogEntry> | undefined;
  if (owned !== undefined) {
    entry = catalog.find((c) => c.id === owned!.carId);
  } else {
    entry = findStarterCar();
    logger.warn('%s user=%s has no garage car; racing with the starter car %s', context, userId, entry.id);
  }

  const bodyId = owned?.carId ?? entry!.id;
  const classId = (entry?.classId ?? owned?.classId ?? 'D') as CarClassId;
  if (declared !== null && (declared.bodyId !== bodyId || declared.classId !== classId)) {
    logger.warn(
      '%s user=%s declared loadout %s/%s ignored; garage loadout %s/%s',
      context,
      userId,
      declared.bodyId,
      declared.classId,
      bodyId,
      classId,
    );
  }

  const loadout: Loadout = {
    classId,
    bodyId,
    ...(declared?.liveryId !== undefined ? { liveryId: declared.liveryId } : {}),
  };
  if (owned !== undefined && entry !== undefined) {
    loadout.stats = computeEffectiveStats(entry, owned, mode);
  }
  return loadout;
}
