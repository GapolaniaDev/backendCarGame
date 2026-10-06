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
  readGarage,
  readGarageObject,
  setActiveCar,
  writeGarageCreate,
  writeGarageUpdate,
} from './storage';
import { getCarsCatalog, getCosmeticsCatalog, getUpgradesCatalog } from './catalog';
import { grant, spend, walletGet } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type {
  CosmeticSlot,
  Garage as GarageRecord,
  OwnedCar,
  Loadout,
  UpgradeLine,
} from './types';
import { COSMETIC_SLOTS, UPGRADE_LINES } from './types';

export interface GarageGetInput {
  /** Target userId. Defaults to the caller. */
  userId?: string;
  callerUserId: string;
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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;

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
  return { ok: true, value: raw as T };
}

interface CallerOk {
  ok: true;
  id: string;
}
interface CallerErr {
  ok: false;
  error: string;
}
function resolveCaller(
  ctx: IContext,
  declared: string | undefined,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = typeof declared === 'string' ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(
          err('FORBIDDEN', 'callerUserId does not match authenticated user'),
        ),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('garage_get RPC called with no caller identity');
  return {
    ok: false,
    error: toJson(err('UNAUTHENTICATED', 'no caller identity')),
  };
}

function toView(g: GarageRecord): GarageView {
  return {
    userId: g.userId,
    cars: g.cars.map(toOwnedCarView),
    cosmeticsBag: [...g.cosmeticsBag],
    purchasedPacks: [...g.purchasedPacks],
    loadout: g.loadout ? toLoadoutView(g.loadout) : null,
    lastDailyWin: g.lastDailyWin,
    dailyPrivateCount: g.dailyPrivateCount,
    dailyResetAt: g.dailyResetAt,
  };
}

function toOwnedCarView(c: OwnedCar): OwnedCarView {
  return {
    carId: c.carId,
    classId: c.classId,
    upgrades: { ...c.upgrades },
    cosmetics: { ...c.cosmetics },
    computedStats: { ...c.computedStats },
  };
}

function toLoadoutView(l: Loadout): LoadoutView {
  return {
    activeCarId: l.activeCarId,
    equipped: { ...l.equipped },
    stats: { ...l.stats },
  };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const garage_get: RpcHandler = garage_get_impl;

// ─── car_buy ─────────────────────────────────────────────────────────────────

export interface CarBuyInput {
  carId: string;
  callerUserId: string;
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
 *   4. Wallet spend() — INSUFFICIENT_FUNDS if balance too low.
 *   5. Garage CAS write — on version conflict, refund via grant().
 *
 * The "atomic" guarantee (Decision 3) is approximated via the
 * compensating-write pattern: spend first, then CAS write, refund on
 * CAS conflict. Nakama 3.27 JS runtime doesn't expose wallet ops in
 * multiUpdate, so a true single-transaction commit isn't available.
 */
export const car_buy_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<CarBuyInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;

  const userId = callerId.id;

  // 1) Catalog lookup.
  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) {
    return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));
  }

  // 2) Read garage (capture version).
  const read = readGarageObject(nk, userId);
  if (!read) {
    return toJson(err('NOT_FOUND', 'garage does not exist — call garage_get first'));
  }
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

  // 5) Spend wallet.
  const grantKey = `garage:buy:${userId}:${car.id}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: car.id,
  };
  const spendChangeset: { coins?: number; gems?: number } = {};
  if (car.priceCoins > 0) spendChangeset.coins = car.priceCoins;
  if (car.priceGems !== undefined && car.priceGems > 0) spendChangeset.gems = car.priceGems;
  // Free car (priceCoins === 0 && priceGems === 0) → no spend call.
  let postBuyBalance: { coins: number; gems: number } | undefined;
  if (Object.keys(spendChangeset).length > 0) {
    const spendResp = spend(nk, userId, spendChangeset, metadata, grantKey);
    if (!spendResp.ok) {
      return toJson(err(spendResp.error.code, spendResp.error.message, spendResp.error.details));
    }
    postBuyBalance = spendResp.data;
  } else {
    postBuyBalance = walletGetLocal(nk, userId);
  }

  // 6) Mutate garage and CAS-write. On version conflict, refund.
  let next: GarageRecord;
  try {
    next = addCarToGarage(garage, car);
  } catch (e) {
    // Should not happen — addCarToGarage is pure.
    logger.error('car_buy: addCarToGarage threw for %s: %s', car.id, JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to assemble new garage'));
  }
  try {
    writeGarageUpdate(nk, next, version);
  } catch (e) {
    logger.warn('car_buy CAS conflict for %s: %s — refunding', userId, JSON.stringify(e));
    const refundChangeset: { coins?: number; gems?: number } = {};
    if (car.priceCoins > 0) refundChangeset.coins = car.priceCoins;
    if (car.priceGems !== undefined && car.priceGems > 0) refundChangeset.gems = car.priceGems;
    if (Object.keys(refundChangeset).length > 0) {
      grant(nk, userId, refundChangeset, metadata, `garage:buy:refund:${userId}:${car.id}`);
    }
    return toJson(err('CONFLICT', 'concurrent garage update — refund issued, please retry'));
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
}

export interface CarUpgradeOutput {
  garage: GarageView;
  costPaid: { coins: number; gems: number };
}

/**
 * Upgrade one line on an owned car. Charges the upgrade-level cost
 * from the catalog table for the car's class. Refund-on-CAS-conflict
 * pattern (same as car_buy).
 */
export const car_upgrade_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<CarUpgradeInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
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
  const read = readGarageObject(nk, userId);
  if (!read) return toJson(err('NOT_FOUND', 'garage does not exist — call garage_get first'));
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

  // Spend.
  const idempKey = `garage:upgrade:${userId}:${car.id}:${parsed.value.line}:${newLevel}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: `${car.id}:${parsed.value.line}`,
  };
  const spendChangeset: { coins?: number; gems?: number } = {};
  if (cost > 0) spendChangeset.coins = cost;
  if (spendChangeset.coins === undefined && spendChangeset.gems === undefined) {
    return toJson(err('INTERNAL', 'upgrade cost is zero — refusing free spend'));
  }
  const spendResp = spend(nk, userId, spendChangeset, metadata, idempKey);
  if (!spendResp.ok) {
    return toJson(err(spendResp.error.code, spendResp.error.message, spendResp.error.details));
  }

  // Mutate + CAS.
  let next: GarageRecord;
  try {
    next = applyUpgrade(garage, car.id, parsed.value.line, newLevel);
  } catch (e) {
    logger.error('car_upgrade: applyUpgrade threw for %s: %s', car.id, JSON.stringify(e));
    return toJson(err('INTERNAL', 'failed to apply upgrade'));
  }
  try {
    writeGarageUpdate(nk, next, version);
  } catch (e) {
    logger.warn('car_upgrade CAS conflict for %s: %s — refunding', userId, JSON.stringify(e));
    if (cost > 0) {
      grant(nk, userId, { coins: cost }, metadata, `garage:upgrade:refund:${userId}:${car.id}:${parsed.value.line}:${newLevel}`);
    }
    return toJson(err('CONFLICT', 'concurrent garage update — refund issued, please retry'));
  }

  logger.info(
    'car_upgrade user=%s car=%s line=%s newLevel=%d cost=%d',
    userId, car.id, parsed.value.line, newLevel, cost,
  );
  return toJson(ok({ garage: toView(next), costPaid: { coins: cost, gems: 0 } }));
};

// ─── cosmetic_equip ──────────────────────────────────────────────────────────

export interface CosmeticEquipInput {
  carId: string;
  slot: CosmeticSlot;
  cosmeticId: string;
  callerUserId: string;
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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  // Validate inputs.
  if (!COSMETIC_SLOTS.includes(parsed.value.slot)) {
    return toJson(err('BAD_REQUEST', `invalid slot: ${parsed.value.slot}`));
  }
  const cosmetic = getCosmeticsCatalog().items.find((c) => c.id === parsed.value.cosmeticId);
  if (!cosmetic) {
    return toJson(err('NOT_FOUND', `cosmetic not in catalog: ${parsed.value.cosmeticId}`));
  }
  if (cosmetic.type !== parsed.value.slot) {
    return toJson(err('BAD_REQUEST', `cosmetic slot mismatch: cosmetic.type=${cosmetic.type}, requested=${parsed.value.slot}`));
  }
  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));

  // Read garage.
  const read = readGarageObject(nk, userId);
  if (!read) return toJson(err('NOT_FOUND', 'garage does not exist — call garage_get first'));
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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const car = getCarsCatalog().cars.find((c) => c.id === parsed.value.carId);
  if (!car) return toJson(err('NOT_FOUND', `car not in catalog: ${parsed.value.carId}`));

  const read = readGarageObject(nk, userId);
  if (!read) return toJson(err('NOT_FOUND', 'garage does not exist — call garage_get first'));
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
    return toJson(ok({ loadout: toLoadoutView(next.loadout), version }));
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

function walletGetLocal(nk: INakama, userId: string): { coins: number; gems: number } {
  const view = walletGet(nk, userId);
  return { coins: view.coins, gems: view.gems };
}

// Top-level bindings for the goja AST scanner.
export const car_buy: RpcHandler = car_buy_impl;
export const car_upgrade: RpcHandler = car_upgrade_impl;
export const cosmetic_equip: RpcHandler = cosmetic_equip_impl;
export const loadout_set: RpcHandler = loadout_set_impl;