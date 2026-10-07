// Phase 6 Chunk 6 — pass reward delivery.
//
// Decomposes a `PassLevelReward` into four sinks:
//   - coins / gems  → wallet.grant() (idempotent per sourceKey)
//   - cosmeticId    → garage.cosmeticsBag (CAS write; missing in
//                     catalog → log + skip, NEVER throws)
//   - carId         → garage.cars (CAS write; missing in catalog or
//                     already-owned → log + skip, NEVER throws)
//
// `pass_claim` and `pass_buy_premium` both feed through this helper.
// The XP portion of rewards is intentionally NOT in scope: pass levels
// are reached via XP earned from races (subscriber, Chunk 7), not from
// claiming rewards.
//
// Idempotency mirrors `missions/reward_granter.ts`:
//   - wallet.grant is idempotent on `source:${userId}:pass:${refId}`
//   - cosmetic grant is idempotent via bag-includes check
//   - car grant is idempotent via garage.cars-includes check
//
// NEVER throws — all error paths log + return a populated result so
// the caller can report what actually landed.

import type { ILogger, INakama } from '../nkruntime';
import { grant } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type { PassLevelReward } from './types';
import {
  addCarToGarage,
  addCosmeticToBag,
  readGarageObject,
  writeGarageCreate,
  writeGarageUpdate,
  defaultGarage,
} from '../garage/storage';
import type { Garage } from '../garage/types';
import {
  getCarsCatalog,
  getCosmeticsCatalog,
} from '../garage/catalog';

export interface GrantPassRewardResult {
  /** Coins actually granted (0 if reward had no coins). */
  coins: number;
  /** Gems actually granted (0 if reward had no gems). */
  gems: number;
  /** Cosmetic ids successfully added to the garage bag. */
  cosmetics: string[];
  /** Cosmetic ids that were SKIPPED (not in catalog, already-owned). */
  skippedCosmetics: string[];
  /** Car ids successfully added to the garage. */
  cars: string[];
  /** Car ids that were SKIPPED (not in catalog, already-owned). */
  skippedCars: string[];
}

/** Internal helper — extract the wallet portion of a pass-level reward. */
function walletChangeset(reward: PassLevelReward): { coins?: number; gems?: number } {
  const out: { coins?: number; gems?: number } = {};
  if (typeof reward.coins === 'number' && reward.coins > 0) out.coins = reward.coins;
  if (typeof reward.gems === 'number' && reward.gems > 0) out.gems = reward.gems;
  return out;
}

/**
 * Wallet grant — idempotent per `sourceKey`. Wraps `wallet.grant` with
 * the `pass` ledger reason so analytics + audits can distinguish.
 */
function grantWallet(
  nk: INakama,
  userId: string,
  sourceKey: string,
  changeset: { coins?: number; gems?: number },
): void {
  if (Object.keys(changeset).length === 0) return;
  const meta: LedgerMetadata = {
    reason: 'pass',
    sourceId: sourceKey,
  };
  grant(nk, userId, changeset, meta, sourceKey);
}

/**
 * Grant a cosmetic to the player's garage bag. Returns `true` on a
 * fresh append, `false` if the cosmetic was already in the bag OR
 * missing from the catalog. Never throws.
 */
function grantCosmetic(
  nk: INakama,
  logger: ILogger,
  userId: string,
  cosmeticId: string,
): boolean {
  const catalog = getCosmeticsCatalog();
  const exists = catalog.items.some((c) => c.id === cosmeticId);
  if (!exists) {
    logger.warn(
      'pass reward_granter: not in catalog id=%s user=%s — skipping',
      cosmeticId, userId,
    );
    return false;
  }

  const garageRead = readGarageObject(nk, userId);
  if (garageRead === null) {
    // No garage yet — lazy-create with the cosmetic already in the bag.
    const fresh: Garage = {
      ...defaultGarage(userId, Date.now()),
      cosmeticsBag: [cosmeticId],
    };
    try {
      writeGarageCreate(nk, fresh);
      logger.info(
        'pass reward_granter: cosmetic via fresh-create id=%s user=%s',
        cosmeticId, userId,
      );
      return true;
    } catch (e) {
      logger.warn(
        'pass reward_granter: fresh-create failed id=%s user=%s: %s',
        cosmeticId, userId,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  const garage = garageRead.value;
  if (garage.cosmeticsBag.includes(cosmeticId)) {
    // Already owned — no-op.
    return false;
  }

  const next = addCosmeticToBag(garage, cosmeticId);
  try {
    writeGarageUpdate(nk, next, garageRead.version);
    return true;
  } catch (e) {
    logger.warn(
      'pass reward_granter: cosmetic CAS failed id=%s user=%s: %s',
      cosmeticId, userId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Grant a car to the player's garage. Returns `true` on a fresh
 * append, `false` if the car was already owned OR missing from the
 * catalog. Never throws.
 */
function grantCar(
  nk: INakama,
  logger: ILogger,
  userId: string,
  carId: string,
): boolean {
  const cat = getCarsCatalog().cars.find((c) => c.id === carId);
  if (!cat) {
    logger.warn(
      'pass reward_granter: car not in catalog id=%s user=%s — skipping',
      carId, userId,
    );
    return false;
  }

  const garageRead = readGarageObject(nk, userId);
  if (garageRead === null) {
    const fresh = defaultGarage(userId, Date.now());
    const updated = { ...fresh, cars: [...fresh.cars] };
    // Append the granted car on top of the starter car.
    const withGranted = addCarToGarage(updated, cat);
    try {
      writeGarageCreate(nk, withGranted);
      logger.info(
        'pass reward_granter: car via fresh-create id=%s user=%s',
        carId, userId,
      );
      return true;
    } catch (e) {
      logger.warn(
        'pass reward_granter: fresh-create (car) failed id=%s user=%s: %s',
        carId, userId,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  const garage = garageRead.value;
  if (garage.cars.some((c) => c.carId === carId)) {
    return false;
  }

  const next = addCarToGarage(garage, cat);
  try {
    writeGarageUpdate(nk, next, garageRead.version);
    return true;
  } catch (e) {
    logger.warn(
      'pass reward_granter: car CAS failed id=%s user=%s: %s',
      carId, userId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Grant every applicable portion of a pass-level reward:
 *   - coins / gems via wallet.grant (idempotent)
 *   - cosmeticId via garage CAS
 *   - carId via garage CAS
 *
 * `refId` is the source for the wallet idempotency key
 * (`pass:${userId}:${refId}`). Callers pass the level number / claim id.
 *
 * NEVER throws.
 */
export function grantPassReward(
  nk: INakama,
  logger: ILogger,
  userId: string,
  reward: PassLevelReward,
  refId: string,
): GrantPassRewardResult {
  const result: GrantPassRewardResult = {
    coins: 0,
    gems: 0,
    cosmetics: [],
    skippedCosmetics: [],
    cars: [],
    skippedCars: [],
  };

  const changeset = walletChangeset(reward);
  if (Object.keys(changeset).length > 0) {
    const sourceKey = `pass:${userId}:${refId}`;
    grantWallet(nk, userId, sourceKey, changeset);
    if (typeof changeset.coins === 'number') result.coins = changeset.coins;
    if (typeof changeset.gems === 'number') result.gems = changeset.gems;
  }

  if (typeof reward.cosmeticId === 'string' && reward.cosmeticId.length > 0) {
    const granted = grantCosmetic(nk, logger, userId, reward.cosmeticId);
    if (granted) result.cosmetics.push(reward.cosmeticId);
    else result.skippedCosmetics.push(reward.cosmeticId);
  }

  if (typeof reward.carId === 'string' && reward.carId.length > 0) {
    const granted = grantCar(nk, logger, userId, reward.carId);
    if (granted) result.cars.push(reward.carId);
    else result.skippedCars.push(reward.carId);
  }

  return result;
}