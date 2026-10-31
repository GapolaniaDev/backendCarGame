// Phase 3 store RPCs. `store_get` returns the catalog after applying
// the player's filters (level, ownership, expiry) plus the daily
// rotation. `store_buy` charges and delivers an offer in one wallet
// movement (`economy/wallet.ts` `moveWallet`, plan T-11).
//
// All decisions enforced here:
//   - Daily offer deterministic per UTC day (D4 in the Phase 3 plan).
//   - `store_get` hides already-owned cars/cosmetics/packs and
//     level-gated offers the player doesn't yet qualify for.
//   - `store_buy` is owner-only (caller identity enforced). Packs
//     are one-time entitlements; cars and cosmetics are forever.

import { resolveActiveSpecialOfferIds } from '../events/scanner';
import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { emit } from '../core/admin/analytics';
import { getStoreCatalog } from './catalog';
import {
  dayKeyUtc,
  resolveDailyRotation,
  withDailyRotation,
} from './rotation';
import {
  filterCatalog,
  filterOffersForSection,
  ownershipFromGarage,
  type FilterContext,
  type FilteredOffer,
} from './filter';
import { resolvePackDelivery } from './packs';
import {
  defaultGarage,
  readGarage,
  readGarageObject,
  writeGarageCreate,
  addCarToGarage,
  addCosmeticToBag,
  garageWrite,
  markPackPurchased,
} from '../garage/storage';
import { getCarsCatalog, getCosmeticsCatalog } from '../garage/catalog';
import { moveWallet, type WalletMove } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type {
  StoreSection,
  StoreOffer,
} from './types';
import { assertNotInMaintenance } from '../core/liveops';
import {
  basePrice,
  finalPrice,
  findStoreOffer,
  specialOfferPricing,
  type OfferPrice,
  type SpecialOfferPricing,
} from './pricing';
import { requireCallerId } from '../core/caller';
import { locKey } from '../core/loc_keys';
import { withRuntime } from '../core/runtime_state';

export interface StoreGetInput {
  /** Optional client-supplied "now" for deterministic tests. */
  nowMs?: number;
  callerUserId: string;
}

export interface StoreGetOutput {
  /** UTC day key (base36) the rotation is anchored to. */
  dailySeed: string;
  /** Sections after rotation + filtering. */
  sections: ReadonlyArray<{
    /** displayNameKey is the Unity Localization key of displayName (D-11). */
    section: { id: StoreSection['id']; displayName: string; displayNameKey: string };
    offers: ReadonlyArray<{
      /** The catalog offer plus displayNameKey, the localization key of its displayName (D-11). */
      offer: StoreOffer & { displayNameKey: string };
      isDailyOffer: boolean;
      basePrice: OfferPrice;
      /** What `store_buy` charges right now (T-12). */
      finalPrice: OfferPrice;
      activeSpecialOfferId?: string;
      /** Additive (T-12). Owned offers are hidden, so a listed one is false. */
      owned: boolean;
    }>;
  }>;
}

export interface StoreBuyInput {
  offerId: string;
  /**
   * Ignored since T-12: prices, discounts and expiry use the server
   * clock, so a client cannot buy inside a past discount window.
   */
  nowMs?: number;
  callerUserId: string;
}

export interface StoreBuyOutput {
  /** What was delivered. */
  delivery:
    | { kind: 'car'; refId: string }
    | { kind: 'cosmetic'; refId: string }
    | { kind: 'pack'; refId: string; changeset: { coins?: number; gems?: number } };
  newBalance: { coins: number; gems: number };
  /** Additive (T-12): the price charged, equal to `store_get` `finalPrice`. */
  pricePaid: OfferPrice;
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

// ─── store_get ───────────────────────────────────────────────────────────────

export const store_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<StoreGetInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;
  // LiveOps gate (T-12, audit X2-d): maintenance only. The Unity client
  // sends no clientVersion, so the min-version half would reject it; the
  // version gate is T-14's.
  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  const nowMs = parsed.value.nowMs ?? Date.now();
  const catalog = getStoreCatalog();

  // Read player's garage for the ownership filter. Auto-create on
  // first read so the filter always has something to look at.
  let garage = readGarage(nk, userId);
  if (!garage) {
    const created = defaultGarage(userId, nowMs);
    try {
      writeGarageCreate(nk, created);
    } catch (e) {
      logger.warn('store_get: garage auto-create failed for %s: %s', userId, JSON.stringify(e));
      return toJson(err('INTERNAL', 'failed to create default garage'));
    }
    garage = created;
  }

  const ownership = ownershipFromGarage(garage);
  const level = readLevelFromProfile(nk, userId);

  // Apply rotation BEFORE filtering — the daily section is
  // rewritten to today's pool before ownership / level checks.
  const rotated = withDailyRotation(catalog, nowMs);

  const ctxFilter: FilterContext = {
    nowMs,
    playerLevel: level,
    ownedCarIds: ownership.ownedCarIds,
    ownedCosmeticIds: ownership.ownedCosmeticIds,
    purchasedPackIds: new Set<string>(garage.purchasedPacks),
  };

  // Phase 8 Chunk 8: decorate each visible offer with basePrice/finalPrice
  // and an optional `activeSpecialOfferId` from the live special offers of
  // the events calendar. The server clock decides the window, as in
  // store_buy (T-12).
  const pricingByOffer = playerPricing(nk, userId, Date.now());

  const filtered = rotated.map((section) => {
    const { visible } = filterOffersForSection(section, ctxFilter);
    return {
      section: {
        id: section.id,
        displayName: section.displayName,
        displayNameKey: locKey('store_section', section.id, 'name'),
      },
      offers: visible.map((v: FilteredOffer) => {
        const offer = v.offer;
        const pricing = pricingByOffer.get(offer.offerId);
        return {
          offer: { ...offer, displayNameKey: locKey('store_offer', offer.offerId, 'name') },
          isDailyOffer: v.isDailyOffer,
          basePrice: basePrice(offer),
          finalPrice: finalPrice(offer, pricingByOffer),
          ...(pricing ? { activeSpecialOfferId: pricing.eventId } : {}),
          owned: isOwned(offer, ctxFilter),
        };
      }),
    };
  });

  // The daily offer for today's seed (for the rotating set).
  const dailyRotation = resolveDailyRotation(catalog, nowMs);

  logger.info(
    'store_get user=%s dailySeed=%s dailyPoolSize=%d visibleOffers=%d',
    userId,
    dayKeyUtc(nowMs),
    dailyRotation.length,
    filtered.reduce((s, sec) => s + sec.offers.length, 0),
  );

  return toJson(ok({ dailySeed: dayKeyUtc(nowMs), sections: filtered }));
};

// ─── store_buy ───────────────────────────────────────────────────────────────

export const store_buy_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<StoreBuyInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.value);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;
  const maint = assertNotInMaintenance(logger, nk, userId);
  if (maint !== null) return toJson(maint);

  // The server clock only (T-12): expiry and discount windows.
  const nowMs = Date.now();

  // 1) Look up the offer in the catalog.
  const offer = findStoreOffer(parsed.value.offerId);
  if (!offer) {
    return toJson(err('NOT_FOUND', `offer not in catalog: ${parsed.value.offerId}`));
  }

  // 2) Validity checks (mirror the store_get filter).
  if (offer.expiresAt !== undefined && offer.expiresAt !== null && nowMs >= offer.expiresAt) {
    return toJson(err('BAD_REQUEST', `offer expired at ${offer.expiresAt}`));
  }

  // 3) Read garage (auto-create so the player can buy from a fresh
  //    state without first calling garage_get).
  let garage = readGarage(nk, userId);
  if (!garage) {
    const created = defaultGarage(userId, nowMs);
    try {
      writeGarageCreate(nk, created);
    } catch (e) {
      logger.warn('store_buy: garage auto-create failed for %s: %s', userId, JSON.stringify(e));
      return toJson(err('INTERNAL', 'failed to create default garage'));
    }
    garage = created;
  }

  // 4) Ownership checks.
  if (offer.kind === 'car' && garage.cars.some((c) => c.carId === offer.refId)) {
    return toJson(err('CONFLICT', `car already owned: ${offer.refId}`));
  }
  if (offer.kind === 'cosmetic' && garage.cosmeticsBag.includes(offer.refId)) {
    return toJson(err('CONFLICT', `cosmetic already owned: ${offer.refId}`));
  }
  if (offer.kind === 'pack' && garage.purchasedPacks.includes(offer.refId)) {
    return toJson(err('CONFLICT', `pack already purchased: ${offer.refId}`));
  }

  // 5) Level check.
  if (offer.requiredLevel !== undefined) {
    const level = readLevelFromProfile(nk, userId);
    if (level < offer.requiredLevel) {
      return toJson(err('FORBIDDEN', `level ${offer.requiredLevel} required for ${offer.offerId}`, {
        requiredLevel: offer.requiredLevel,
        currentLevel: level,
      }));
    }
  }

  // 6) Charge and deliver in ONE transaction (plan T-11): the price, the
  //    pack contents, the idempotency record and the garage CAS write go
  //    in the same `nk.multiUpdate`. A lost CAS or a short balance leaves
  //    everything untouched, so there is no refund to undo and a retry
  //    charges normally (HT-73, audit 05 f11); there is no pack reversal
  //    to get wrong either (audit 05 f12).
  const grantKey = `store:buy:${offer.kind}:${userId}:${offer.refId}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: offer.offerId,
  };
  const garageRead = readGarageObject(nk, userId);
  if (!garageRead) return toJson(err('INTERNAL', 'garage vanished mid-buy'));
  const garageVersion = garageRead.version;
  const currentGarage = garageRead.value;

  // 7) Assemble the delivery before charging: catalog drift fails here,
  //    with nothing charged.
  let delivery: StoreBuyOutput['delivery'];
  let nextGarage = currentGarage;
  let packChangeset: Record<string, number> = {};
  try {
    if (offer.kind === 'car') {
      const car = getCarsCatalog().cars.find((c) => c.id === offer.refId);
      if (!car) return toJson(err('INTERNAL', `car not in catalog: ${offer.refId}`));
      nextGarage = addCarToGarage(currentGarage, car);
      delivery = { kind: 'car', refId: offer.refId };
    } else if (offer.kind === 'cosmetic') {
      const cosmetic = getCosmeticsCatalog().items.find((c) => c.id === offer.refId);
      if (!cosmetic) return toJson(err('INTERNAL', `cosmetic not in catalog: ${offer.refId}`));
      nextGarage = addCosmeticToBag(currentGarage, offer.refId);
      delivery = { kind: 'cosmetic', refId: offer.refId };
    } else {
      const pack = resolvePackDelivery(offer.refId);
      const changeset = pack?.changeset ?? {};
      packChangeset = positiveAmounts(changeset);
      nextGarage = markPackPurchased(currentGarage, offer.refId);
      delivery = { kind: 'pack', refId: offer.refId, changeset };
    }
  } catch (e) {
    logger.warn('store_buy: delivery assembly failed: %s — nothing charged', JSON.stringify(e));
    return toJson(err('CONFLICT', `delivery failed: ${(e as Error).message} — nothing was charged`));
  }

  // The price store_get showed: same function, same clock (T-12, PC-20).
  let pricePaid = finalPrice(offer, playerPricing(nk, userId, nowMs));
  const moves: WalletMove[] = [];
  const priceChangeset: Record<string, number> = {};
  for (const [k, v] of Object.entries(positiveAmounts(pricePaid))) {
    priceChangeset[k] = -v;
  }
  if (Object.keys(priceChangeset).length > 0) moves.push({ changeset: priceChangeset, metadata });
  if (Object.keys(packChangeset).length > 0) {
    moves.push({ changeset: packChangeset, metadata: { ...metadata, sourceId: `${offer.offerId}:pack` } });
  }
  const moved = moveWallet(nk, userId, grantKey, moves, {
    extraWrites: [garageWrite(nextGarage, garageVersion)],
    result: { delivery, pricePaid },
  });
  if (!moved.ok) {
    if (moved.error.code === 'CONFLICT') {
      logger.warn('store_buy CAS conflict for %s offer=%s — nothing charged', userId, offer.offerId);
      return toJson(err('CONFLICT', 'concurrent garage update — nothing was charged, please retry'));
    }
    return toJson(err(moved.error.code, moved.error.message, moved.error.details));
  }
  if (moved.data.replayed) {
    // A concurrent call with the same key bought it: answer what it delivered.
    const stored = moved.data.record.result as Partial<Pick<StoreBuyOutput, 'delivery' | 'pricePaid'>> | undefined;
    if (stored?.delivery) delivery = stored.delivery;
    if (stored?.pricePaid) pricePaid = stored.pricePaid;
  }

  // 8) The balance after the movement (the pack contents included).
  const finalBalance = moved.data.balance;

  logger.info(
    'store_buy user=%s offer=%s kind=%s refId=%s newBalance.coins=%d',
    userId, offer.offerId, offer.kind, offer.refId, finalBalance.coins,
  );
  emit(nk, logger, 'store_purchase', {
    userId,
    offerId: offer.offerId,
    kind: offer.kind,
    refId: offer.refId,
    priceCoins: pricePaid.coins,
    priceGems: pricePaid.gems,
    finalBalance,
  });
  return toJson(ok({ delivery, newBalance: finalBalance, pricePaid }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Special-offer pricing at `nowMs`: the live `special_offer` events of the
 * events calendar (plan T-23: one event source; it read a per-profile
 * copy that a scanner rewrote every 5 minutes).
 */
function playerPricing(_nk: INakama, _userId: string, nowMs: number): Map<string, SpecialOfferPricing> {
  return specialOfferPricing(new Set<string>(resolveActiveSpecialOfferIds(nowMs)), nowMs);
}

/** The ownership rule of the store filter, for the `owned` flag. */
function isOwned(offer: StoreOffer, ctx: FilterContext): boolean {
  if (offer.kind === 'car') return ctx.ownedCarIds.has(offer.refId);
  if (offer.kind === 'cosmetic') return ctx.ownedCosmeticIds.has(offer.refId);
  return ctx.purchasedPackIds.has(offer.refId);
}

/** The strictly positive whole amounts of a `{coins, gems}` price/changeset. */
function positiveAmounts(c: { coins?: number | undefined; gems?: number | undefined }): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof c.coins === 'number' && c.coins > 0) out['coins'] = c.coins;
  if (typeof c.gems === 'number' && c.gems > 0) out['gems'] = c.gems;
  return out;
}

function readLevelFromProfile(nk: INakama, userId: string): number {
  const profile = nk.storageRead([{ collection: 'profiles', key: userId, userId }])[0];
  if (!profile) return 1;
  const v = profile.value as Record<string, unknown>;
  const prog = v['progression'] as { level?: number } | undefined;
  return typeof prog?.level === 'number' ? prog.level : 1;
}

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


function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level bindings for the goja AST scanner.
export const store_get: RpcHandler = withRuntime(store_get_impl);
export const store_buy: RpcHandler = withRuntime(store_buy_impl);