// garage_get RPC. Returns the full garage (cars + loadout + daily
// counters) in a single call (Decision 2 — no pagination, no
// partial reads). Auto-creates a default garage on first read so a
// client that authenticates via a channel the after-auth hook
// doesn't cover (e.g. Facebook) still gets a usable garage on the
// first `garage_get`.
//
// All decisions enforced here:
//   - D2: garage_get returns everything; the client doesn't need
//     subsequent per-car fetches.
//   - Caller must own the garage (HTTP gateway passes callerUserId
//     in the payload; the resolver enforces identity).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import {
  addCarToGarage,
  applyUpgrade,
  defaultGarage,
  equipCosmetic,
  unequipCosmetic,
  garageWrite,
  readGarage,
  readGarageObject,
  readOrCreateGarageObject,
  setActiveCar,
  writeGarageCreate,
  writeGarageUpdate,
} from './storage';
import { getCarsCatalog, getCosmeticsCatalog, getUpgradesCatalog } from './catalog';
import { computeStats } from './stats';
import { moveWallet } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type {
  CosmeticSlot,
  Garage as GarageRecord,
  OwnedCar,
  Loadout,
  UpgradeLine,
} from './types';
import { COSMETIC_SLOTS, UPGRADE_LINES } from './types';
import { liveopsGate } from '../core/liveops';
import type { ClientPlatform } from '../liveops/types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

const PLATFORM_DEFAULT: ClientPlatform = 'ios';

export interface GarageGetInput {
  /** Target userId. Defaults to the caller. */
  userId?: string;
  callerUserId: string;
  /** Client semver — sent in payload (RPC handler can't read HTTP headers). */
  clientVersion?: string;
  /** Client platform (defaults to 'ios' when omitted). */
  platform?: ClientPlatform;
}

export interface GarageGetOutput {
  garage: GarageView;
}

export interface GarageView {
  userId: string;
  cars: OwnedCarView[];
  cosmeticsBag: string[];
  purchasedPacks: string[];
  loadout: LoadoutView | null;
  lastDailyWin: number;
  dailyPrivateCount: number;
  dailyResetAt: number;
}

export interface OwnedCarView {
  carId: string;
  classId: OwnedCar['classId'];
  upgrades: OwnedCar['upgrades'];
  cosmetics: OwnedCar['cosmetics'];
  computedStats: OwnedCar['computedStats'];
}

export interface LoadoutView {
  activeCarId: string;
  equipped: OwnedCar['cosmetics'];
  stats: Loadout['stats'];
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const garage_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<GarageGetInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const gate = liveopsGate(logger, nk, callerId.id, parsed.value.clientVersion, parsed.value.platform ?? PLATFORM_DEFAULT);
  if (gate !== null) return toJson(gate);

  const targetUserId = parsed.value.userId ?? callerId.id;

  // Caller can only read their own garage. Admins / spectators are
  // out of scope for Phase 3.
  if (targetUserId !== callerId.id) {
    return toJson(err('FORBIDDEN', 'cannot read another user\'s garage'));
  }

  // Auto-create on first read so a missing record still yields a
  // usable response (mirrors profile_get).
  const existing = readGarage(nk, targetUserId);
  if (!existing) {
    const created = defaultGarage(targetUserId, Date.now());
    try {
      writeGarageCreate(nk, created);
    } catch (e) {
      logger.warn(
        'garage_get: auto-create failed for %s: %s',
        targetUserId,
        e instanceof Error ? e.message : String(e),
      );
      return toJson(err('INTERNAL', 'failed to create default garage'));
    }
    logger.info('garage_get auto-created default garage for %s', targetUserId);
    return toJson(ok({ garage: toView(created) }));
  }

  return toJson(ok({ garage: toView(existing) }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput<T>(body: string): ParseOk<T> | ParseErr {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload is not valid JSON')) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload must be an object')) };
  }
  // Pass the parsed object through; gate fields (clientVersion, platform)
  // are extracted by the gate helper from `parsed.value` directly.
  return { ok: true, value: raw as T };
}


function toView(g: GarageRecord): GarageView {
  return {
    userId: g.userId,
    cars: g.cars.map(toOwnedCarView),
    cosmeticsBag: [...g.cosmeticsBag],
    purchasedPacks: [...g.purchasedPacks],
    loadout: g.loadout ? toLoadoutView(g.loadout, g) : null,
    lastDailyWin: g.lastDailyWin,
    dailyPrivateCount: g.dailyPrivateCount,
    dailyResetAt: g.dailyResetAt,
  };
}

// Stats are recomputed from the current catalogs when served (plan B3, D-03), so a stored
// snapshot made with an older stat table never reaches the client.
function toOwnedCarView(c: OwnedCar): OwnedCarView {
  const car = getCarsCatalog().cars.find((x) => x.id === c.carId);
  return {
    carId: c.carId,
    classId: c.classId,
    upgrades: { ...c.upgrades },
    cosmetics: { ...c.cosmetics },
    computedStats: car ? computeStats(car, getUpgradesCatalog(), c.upgrades) : { ...c.computedStats },
  };
}

function toLoadoutView(l: Loadout, g: GarageRecord): LoadoutView {
  const active = g.cars.find((x) => x.carId === l.activeCarId);
  return {
    activeCarId: l.activeCarId,
    equipped: { ...l.equipped },
    stats: active ? toOwnedCarView(active).computedStats : { ...l.stats },
  };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const garage_get: RpcHandler = withRuntime(garage_get_impl);

// ─── car_buy ─────────────────────────────────────────────────────────────────

export interface CarBuyInput {
  carId: string;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface CarBuyOutput {
  garage: GarageView;
  newBalance: { coins: number; gems: number };
}

/**
 * Buy a car from the catalog. Steps (Phase 3):
 *   1. Caller identity resolved + garage read.
 *   2. Player must meet `car.requiredLevel` (FORBIDDEN if not).
 *   3. Player must not already own the car (CONFLICT if so).
 *   4+5. Wallet spend() with the garage CAS write in the same
 *      `nk.multiUpdate` (plan T-11): INSUFFICIENT_FUNDS or a lost CAS
 *      (CONFLICT) leave both the wallet and the garage untouched, so no
 *      refund exists and a retry charges normally (audit 05 f11).
 */
export const car_buy_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<CarBuyInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const gate = liveopsGate(logger, nk, callerId.id, parsed.value.clientVersion, parsed.value.platform ?? PLATFORM_DEFAULT);
  if (gate !== null) return toJson(gate);

  const userId = callerId.id;

  // 1) Catalog lookup.
  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) {
    return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));
  }

  // 2) Read garage (capture version).
  const read = readOrCreateGarageObject(nk, logger, userId, Date.now());
  if (!read) return toJson(err('INTERNAL', 'failed to create default garage'));
  const { value: garage, version } = read;

  // 3) Already-owned check.
  try {
    ensureCarNotOwnedFn(garage, car.id);
  } catch {
    return toJson(err('CONFLICT', `car already owned: ${car.id}`));
  }

  // 4) Level requirement — read from profile.
  const profile = nk.storageRead([
    { collection: 'profiles', key: userId, userId },
  ])[0];
  const playerLevel = readLevelFromProfile(profile);
  if (playerLevel < car.requiredLevel) {
    return toJson(err('FORBIDDEN', `level ${car.requiredLevel} required`, {
      requiredLevel: car.requiredLevel,
      currentLevel: playerLevel,
    }));
  }

  // 5) Spend and deliver in one transaction.
  const grantKey = `garage:buy:${userId}:${car.id}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: car.id,
  };
  const spendChangeset: Record<string, number> = {};
  if (car.priceCoins > 0) spendChangeset['coins'] = -car.priceCoins;
  if (car.priceGems !== undefined && car.priceGems > 0) spendChangeset['gems'] = -car.priceGems;
  let next: GarageRecord;
  try {
    next = addCarToGarage(garage, car);
  } catch (e) {
    // Should not happen — addCarToGarage is pure.
    logger.error('car_buy: addCarToGarage threw for %s: %s', car.id, JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to assemble new garage'));
  }
  // A free car (no price) still records the key and writes the garage.
  const moves = Object.keys(spendChangeset).length > 0 ? [{ changeset: spendChangeset, metadata }] : [];
  const moved = moveWallet(nk, userId, grantKey, moves, { extraWrites: [garageWrite(next, version)] });
  if (!moved.ok) {
    if (moved.error.code === 'CONFLICT') {
      logger.warn('car_buy CAS conflict for %s — nothing charged', userId);
      return toJson(err('CONFLICT', 'concurrent garage update — nothing was charged, please retry'));
    }
    return toJson(moved);
  }
  const postBuyBalance = moved.data.balance;
  if (moved.data.replayed) {
    // A concurrent call with the same key bought it: report that garage.
    next = readGarageObject(nk, userId)?.value ?? next;
  }

  logger.info('car_buy user=%s car=%s priceCoins=%d newBalance.coins=%d', userId, car.id, car.priceCoins, postBuyBalance.coins);
  return toJson(ok({ garage: toView(next), newBalance: postBuyBalance }));
};

// ─── car_upgrade ─────────────────────────────────────────────────────────────

export interface CarUpgradeInput {
  carId: string;
  line: UpgradeLine;
  newLevel: number;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface CarUpgradeOutput {
  garage: GarageView;
  costPaid: { coins: number; gems: number };
  /** Wallet after the charge (plan B3, D-07). */
  newBalance: { coins: number; gems: number };
}

/**
 * Upgrade one line on an owned car. Charges the upgrade-level cost
 * from the catalog table for the car's class. Refund-on-CAS-conflict
 * pattern (same as car_buy).
 */
export const car_upgrade_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<CarUpgradeInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const gate = liveopsGate(logger, nk, callerId.id, parsed.value.clientVersion, parsed.value.platform ?? PLATFORM_DEFAULT);
  if (gate !== null) return toJson(gate);
  const userId = callerId.id;

  // Validate inputs.
  if (!UPGRADE_LINES.includes(parsed.value.line)) {
    return toJson(err('BAD_REQUEST', `invalid upgrade line: ${parsed.value.line}`));
  }
  const newLevel = parsed.value.newLevel;
  if (!Number.isInteger(newLevel) || newLevel < 1 || newLevel > 5) {
    return toJson(err('BAD_REQUEST', 'newLevel must be an integer 1..5'));
  }

  // Catalog lookup.
  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) {
    return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));
  }

  // Read garage.
  const read = readOrCreateGarageObject(nk, logger, userId, Date.now());
  if (!read) return toJson(err('INTERNAL', 'failed to create default garage'));
  const { value: garage, version } = read;
  const owned = garage.cars.find((c) => c.carId === car.id);
  if (!owned) return toJson(err('FORBIDDEN', `car not owned: ${car.id}`));

  // Cap check: must be exactly currentLevel + 1 (or any value up to max? — Decision: monotonic; reject non-monotonic).
  const currentLevel = owned.upgrades[parsed.value.line];
  if (newLevel !== currentLevel + 1) {
    return toJson(err('BAD_REQUEST', `newLevel must equal currentLevel+1 (${currentLevel + 1})`, {
      currentLevel,
      requestedLevel: newLevel,
    }));
  }

  // Cost lookup.
  const upgrades = getUpgradesCatalog();
  const levels = upgrades.perCarClass[car.classId]?.[parsed.value.line];
  if (!levels || newLevel - 1 >= levels.length) {
    return toJson(err('INTERNAL', 'upgrade table misaligned'));
  }
  const entry = levels[newLevel - 1];
  if (!entry) return toJson(err('INTERNAL', 'upgrade entry missing'));
  const cost = entry.cost;

  // Spend and apply in one transaction (plan T-11): a lost CAS charges
  // nothing, so there is no refund and the retry charges normally.
  const idempKey = `garage:upgrade:${userId}:${car.id}:${parsed.value.line}:${newLevel}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: `${car.id}:${parsed.value.line}`,
  };
  if (!(cost > 0)) {
    return toJson(err('INTERNAL', 'upgrade cost is zero — refusing free spend'));
  }
  let next: GarageRecord;
  try {
    next = applyUpgrade(garage, car.id, parsed.value.line, newLevel);
  } catch (e) {
    logger.error('car_upgrade: applyUpgrade threw for %s: %s', car.id, JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to apply upgrade'));
  }
  const moved = moveWallet(nk, userId, idempKey, [{ changeset: { coins: -cost }, metadata }], {
    extraWrites: [garageWrite(next, version)],
  });
  if (!moved.ok) {
    if (moved.error.code === 'CONFLICT') {
      logger.warn('car_upgrade CAS conflict for %s — nothing charged', userId);
      return toJson(err('CONFLICT', 'concurrent garage update — nothing was charged, please retry'));
    }
    return toJson(moved);
  }
  if (moved.data.replayed) {
    next = readGarageObject(nk, userId)?.value ?? next;
  }

  logger.info(
    'car_upgrade user=%s car=%s line=%s newLevel=%d cost=%d',
    userId, car.id, parsed.value.line, newLevel, cost,
  );
  return toJson(ok({ garage: toView(next), costPaid: { coins: cost, gems: 0 }, newBalance: moved.data.balance }));
};

// ─── cosmetic_equip ──────────────────────────────────────────────────────────

export interface CosmeticEquipInput {
  carId: string;
  slot: CosmeticSlot;
  /** null, absent or '' empties the slot (plan B3, D-09). */
  cosmeticId?: string | null;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface CosmeticEquipOutput {
  garage: GarageView;
}

/**
 * Equip a cosmetic (Decision 4 — strict compatibility check):
 *   - The cosmetic must be in `garage.cosmeticsBag` (owned).
 *   - `car.classId` must be in `cosmetic.compatibleClasses`.
 *   - The slot must match the cosmetic's type.
 *
 * No wallet charge (cosmetics are pre-purchased in Chunk 8). Just a
 * CAS write on garage.
 */
export const cosmetic_equip_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<CosmeticEquipInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const gate = liveopsGate(logger, nk, callerId.id, parsed.value.clientVersion, parsed.value.platform ?? PLATFORM_DEFAULT);
  if (gate !== null) return toJson(gate);
  const userId = callerId.id;

  // Validate inputs.
  if (!COSMETIC_SLOTS.includes(parsed.value.slot)) {
    return toJson(err('BAD_REQUEST', `invalid slot: ${parsed.value.slot}`));
  }
  const rawCosmeticId = parsed.value.cosmeticId;
  if (rawCosmeticId === undefined || rawCosmeticId === null || rawCosmeticId === '') {
    // Unequip branch (D-09).
    const unequipCar = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
    if (!unequipCar) return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));
    const unequipRead = readOrCreateGarageObject(nk, logger, userId, Date.now());
    if (!unequipRead) return toJson(err('INTERNAL', 'failed to create default garage'));
    if (!unequipRead.value.cars.some((c) => c.carId === unequipCar.id)) {
      return toJson(err('FORBIDDEN', `car not owned: ${unequipCar.id}`));
    }
    let unequipped: GarageRecord;
    try {
      unequipped = unequipCosmetic(unequipRead.value, unequipCar.id, parsed.value.slot);
    } catch (e) {
      logger.error('cosmetic_equip: unequipCosmetic threw: %s', JSON.stringify(e));
      return toJson(err('INTERNAL', 'failed to unequip cosmetic'));
    }
    try {
      writeGarageUpdate(nk, unequipped, unequipRead.version);
    } catch (e) {
      logger.warn('cosmetic_equip CAS conflict for %s: %s', userId, JSON.stringify(e));
      return toJson(err('CONFLICT', 'concurrent garage update — please retry'));
    }
    logger.info('cosmetic_unequip user=%s car=%s slot=%s', userId, unequipCar.id, parsed.value.slot);
    return toJson(ok({ garage: toView(unequipped) }));
  }
  const cosmetic = getCosmeticsCatalog().items.find((c) => c.id === rawCosmeticId);
  if (!cosmetic) {
    return toJson(err('NOT_FOUND', `cosmetic not in catalog: ${rawCosmeticId}`));
  }
  if (cosmetic.type !== parsed.value.slot) {
    return toJson(err('BAD_REQUEST', `cosmetic slot mismatch: cosmetic.type=${cosmetic.type}, requested=${parsed.value.slot}`));
  }
  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));

  // Read garage.
  const read = readOrCreateGarageObject(nk, logger, userId, Date.now());
  if (!read) return toJson(err('INTERNAL', 'failed to create default garage'));
  const { value: garage, version } = read;

  // 2) Owned?
  if (!garage.cosmeticsBag.includes(cosmetic.id)) {
    return toJson(err('FORBIDDEN', `cosmetic not owned: ${cosmetic.id}`));
  }

  // 3) Owned car?
  const ownedCar = garage.cars.find((c) => c.carId === car.id);
  if (!ownedCar) return toJson(err('FORBIDDEN', `car not owned: ${car.id}`));

  // 4) Compatibility (Decision 4 — strict).
  if (!cosmetic.compatibleClasses.includes(car.classId)) {
    return toJson(err('FORBIDDEN', `cosmetic ${cosmetic.id} not compatible with class ${car.classId}`, {
      cosmeticId: cosmetic.id,
      compatibleClasses: [...cosmetic.compatibleClasses],
      carClass: car.classId,
    }));
  }

  // 5) Mutate + CAS.
  let next: GarageRecord;
  try {
    next = equipCosmetic(garage, car.id, parsed.value.slot, cosmetic.id);
  } catch (e) {
    logger.error('cosmetic_equip: equipCosmetic threw: %s', JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to equip cosmetic'));
  }
  try {
    writeGarageUpdate(nk, next, version);
  } catch (e) {
    logger.warn('cosmetic_equip CAS conflict for %s: %s', userId, JSON.stringify(e));
    return toJson(err('CONFLICT', 'concurrent garage update — please retry'));
  }
  logger.info('cosmetic_equip user=%s car=%s slot=%s cosmetic=%s', userId, car.id, parsed.value.slot, cosmetic.id);
  return toJson(ok({ garage: toView(next) }));
};

// ─── loadout_set ─────────────────────────────────────────────────────────────

export interface LoadoutSetInput {
  carId: string;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface LoadoutSetOutput {
  loadout: LoadoutView;
  version: string;
}

/**
 * Set the active car in the loadout (Decision 5 — the loadout is
 * publicly readable; this handler only mutates the owner's garage).
 * Just a CAS write.
 */
export const loadout_set_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<LoadoutSetInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const gate = liveopsGate(logger, nk, callerId.id, parsed.value.clientVersion, parsed.value.platform ?? PLATFORM_DEFAULT);
  if (gate !== null) return toJson(gate);
  const userId = callerId.id;

  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));

  const read = readOrCreateGarageObject(nk, logger, userId, Date.now());
  if (!read) return toJson(err('INTERNAL', 'failed to create default garage'));
  const { value: garage, version } = read;
  if (!garage.cars.find((c) => c.carId === car.id)) {
    return toJson(err('FORBIDDEN', `car not owned: ${car.id}`));
  }

  let next: GarageRecord;
  try {
    next = setActiveCar(garage, car.id);
  } catch (e) {
    logger.error('loadout_set: setActiveCar threw: %s', JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to set active car'));
  }
  try {
    writeGarageUpdate(nk, next, version);
    logger.info('loadout_set user=%s activeCar=%s', userId, car.id);
    if (!next.loadout) {
      return toJson(err('INTERNAL', 'loadout missing after setActiveCar'));
    }
    return toJson(ok({ loadout: toLoadoutView(next.loadout, next), version }));
  } catch (e) {
    logger.warn('loadout_set CAS conflict for %s: %s', userId, JSON.stringify(e));
    return toJson(err('CONFLICT', 'concurrent garage update — please retry'));
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Re-export the in-storage version for the RPC implementations. */
function ensureCarNotOwnedFn(garage: GarageRecord, carId: string): void {
  for (const c of garage.cars) {
    if (c.carId === carId) {
      throw new Error(`car already owned: ${carId}`);
    }
  }
}

function readLevelFromProfile(profile: { value?: unknown } | undefined): number {
  if (!profile || profile.value === undefined) return 1;
  const v = profile.value as Record<string, unknown>;
  const prog = v['progression'] as { level?: number } | undefined;
  return typeof prog?.level === 'number' ? prog.level : 1;
}

// Top-level bindings for the goja AST scanner.
export const car_buy: RpcHandler = withRuntime(car_buy_impl);
export const car_upgrade: RpcHandler = withRuntime(car_upgrade_impl);
export const cosmetic_equip: RpcHandler = withRuntime(cosmetic_equip_impl);
export const loadout_set: RpcHandler = withRuntime(loadout_set_impl);