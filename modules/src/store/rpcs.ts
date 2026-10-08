// Phase 3 store RPCs. `store_get` returns the catalog after applying
// the player's filters (level, ownership, expiry) plus the daily
// rotation. `store_buy` redeems an offer using the compensating-
// refund pattern (Decision 3 — see [[carvideogamebackend-phase3-chunk7]]).
//
// All decisions enforced here:
//   - Daily offer deterministic per UTC day (D4 in the Phase 3 plan).
//   - `store_get` hides already-owned cars/cosmetics/packs and
//     level-gated offers the player doesn't yet qualify for.
//   - `store_buy` is owner-only (caller identity enforced). Packs
//     are one-time entitlements; cars and cosmetics are forever.

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
  writeGarageUpdate,
  addCarToGarage,
  addCosmeticToBag,
  markPackPurchased,
} from '../garage/storage';
import { getCarsCatalog, getCosmeticsCatalog } from '../garage/catalog';
import { grant, spend, walletGet } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type {
  StoreSection,
  StoreOffer,
} from './types';
import { getEventsCatalog } from '../core/active_events';
import { readProfile } from '../profiles/storage';

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
    section: { id: StoreSection['id']; displayName: string };
    offers: ReadonlyArray<{ offer: StoreOffer; isDailyOffer: boolean }>;
  }>;
}

export interface StoreBuyInput {
  offerId: string;
  /** Optional client-supplied "now" for deterministic tests. */
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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

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

  // Phase 8 Chunk 8: read the player's `activeSpecialOffers` so we can
  // decorate each visible offer with basePrice/finalPrice and an
  // optional `activeSpecialOfferId`. The list is reconciled by the
  // 5min `startEventScanner`; a profile without the field simply sees
  // no discount (default path).
  const profile = readProfile(nk, userId);
  const activeOfferIds = new Set<string>(profile?.activeSpecialOffers ?? []);
  const pricingByOffer = computeSpecialOfferPricing(activeOfferIds, nowMs);

  const filtered = rotated.map((section) => {
    const { visible } = filterOffersForSection(section, ctxFilter);
    return {
      section: { id: section.id, displayName: section.displayName },
      offers: visible.map((v: FilteredOffer) => {
        const offer = v.offer;
        const pricing = pricingByOffer.get(offer.offerId);
        return {
          offer,
          isDailyOffer: v.isDailyOffer,
          basePrice: {
            coins: typeof offer.priceCoins === 'number' ? offer.priceCoins : 0,
            gems: typeof offer.priceGems === 'number' ? offer.priceGems : 0,
          },
          finalPrice: pricing
            ? pricing.finalPrice
            : {
                coins: typeof offer.priceCoins === 'number' ? offer.priceCoins : 0,
                gems: typeof offer.priceGems === 'number' ? offer.priceGems : 0,
              },
          ...(pricing ? { activeSpecialOfferId: pricing.eventId } : {}),
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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const nowMs = parsed.value.nowMs ?? Date.now();

  // 1) Look up the offer in the catalog.
  const offer = findOffer(parsed.value.offerId);
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

  // 6) Spend wallet (filtered for positive values).
  const grantKey = `store:buy:${offer.kind}:${userId}:${offer.refId}`;
  const metadata: LedgerMetadata = {
    reason: 'store',
    sourceId: offer.offerId,
  };
  const spendChangeset: { coins?: number; gems?: number } = {};
  if (typeof offer.priceCoins === 'number' && offer.priceCoins > 0) spendChangeset.coins = offer.priceCoins;
  if (typeof offer.priceGems === 'number' && offer.priceGems > 0) spendChangeset.gems = offer.priceGems;

  // Capture version BEFORE the spend so we can refund on CAS conflict.
  const garageRead = readGarageObject(nk, userId);
  if (!garageRead) return toJson(err('INTERNAL', 'garage vanished mid-buy'));
  const garageVersion = garageRead.version;
  const currentGarage = garageRead.value;

  if (Object.keys(spendChangeset).length > 0) {
    const spendResp = spend(nk, userId, spendChangeset, metadata, grantKey);
    if (!spendResp.ok) {
      return toJson(err(spendResp.error.code, spendResp.error.message, spendResp.error.details));
    }
  }

  // 7) Apply the delivery. Each kind mutates the garage + may also
  //    call `grant` (for packs). CAS-write the garage; on conflict
  //    refund the spend via grant.
  const delivery: StoreBuyOutput['delivery'] = (() => {
    if (offer.kind === 'car') {
      return { kind: 'car' as const, refId: offer.refId };
    }
    if (offer.kind === 'cosmetic') {
      return { kind: 'cosmetic' as const, refId: offer.refId };
    }
    // pack
    const pack = resolvePackDelivery(offer.refId);
    const changeset = pack?.changeset ?? {};
    return { kind: 'pack' as const, refId: offer.refId, changeset };
  })();

  let nextGarage = currentGarage;
  try {
    if (offer.kind === 'car') {
      const car = getCarsCatalog().cars.find((c) => c.id === offer.refId);
      if (!car) {
        // Catalog drift — refund.
        refundSpend(offer, userId, nk, metadata);
        return toJson(err('INTERNAL', `car not in catalog: ${offer.refId}`));
      }
      nextGarage = addCarToGarage(currentGarage, car);
    } else if (offer.kind === 'cosmetic') {
      const cosmetic = getCosmeticsCatalog().items.find((c) => c.id === offer.refId);
      if (!cosmetic) {
        refundSpend(offer, userId, nk, metadata);
        return toJson(err('INTERNAL', `cosmetic not in catalog: ${offer.refId}`));
      }
      nextGarage = addCosmeticToBag(currentGarage, offer.refId);
    } else {
      nextGarage = markPackPurchased(currentGarage, offer.refId);
    }
  } catch (e) {
    logger.warn('store_buy: delivery assembly failed: %s — refunding', JSON.stringify(e));
    refundSpend(offer, userId, nk, metadata);
    return toJson(err('CONFLICT', `delivery failed: ${(e as Error).message} — refund issued`));
  }

  // 8) For packs, grant the pack contents in the SAME spend (so a
  //    failed CAS refund is the only window where the player gets
  //    the coins/gems without the pack being marked). On refund,
  //    we reverse the pack grant.
  if (offer.kind === 'pack') {
    const pack = resolvePackDelivery(offer.refId);
    if (pack) {
      const grantChangeset: { coins?: number; gems?: number } = {};
      const c = pack.changeset.coins;
      const g = pack.changeset.gems;
      if (typeof c === 'number' && c > 0) grantChangeset.coins = c;
      if (typeof g === 'number' && g > 0) grantChangeset.gems = g;
      if (Object.keys(grantChangeset).length > 0) {
        grant(
          nk,
          userId,
          grantChangeset,
          { ...metadata, sourceId: `${offer.offerId}:pack` },
          `${grantKey}:pack`,
        );
      }
    }
  }

  // 9) CAS-write the garage.
  try {
    writeGarageUpdate(nk, nextGarage, garageVersion);
  } catch (e) {
    logger.warn('store_buy CAS conflict for %s: %s — refunding spend + pack', userId, JSON.stringify(e));
    refundSpend(offer, userId, nk, metadata);
    if (offer.kind === 'pack') {
      const pack = resolvePackDelivery(offer.refId);
      if (pack) {
        const reverse: { coins?: number; gems?: number } = {};
        const c = pack.changeset.coins;
        const g = pack.changeset.gems;
        if (typeof c === 'number' && c > 0) reverse.coins = -c;
        if (typeof g === 'number' && g > 0) reverse.gems = -g;
        if (Object.keys(reverse).length > 0) {
          grant(
            nk,
            userId,
            reverse,
            { ...metadata, sourceId: `${offer.offerId}:pack:reverse` },
            `${grantKey}:pack:reverse`,
          );
        }
      }
    }
    return toJson(err('CONFLICT', 'concurrent garage update — refund issued, please retry'));
  }

  // 10) Return the post-buy balance (re-read since the pack grant
  //     may have changed it).
  const finalBalance = walletGetLocal(nk, userId);

  logger.info(
    'store_buy user=%s offer=%s kind=%s refId=%s newBalance.coins=%d',
    userId, offer.offerId, offer.kind, offer.refId, finalBalance.coins,
  );
  emit(nk, logger, 'store_purchase', {
    userId,
    offerId: offer.offerId,
    kind: offer.kind,
    refId: offer.refId,
    priceCoins: offer.priceCoins ?? 0,
    priceGems: offer.priceGems ?? 0,
    finalBalance,
  });
  return toJson(ok({ delivery, newBalance: finalBalance }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface SpecialOfferPricing {
  eventId: string;
  finalPrice: { coins: number; gems: number };
}

/**
 * Map offerId → special-offer pricing when the player has a `special_offer`
 * event whose `payload.sku` targets that offerId. Multiple matching events
 * are deduped by offerId (the player can only see the discount once per
 * offer even if two events match). Returns an empty map when no active
 * special offer applies.
 */
function computeSpecialOfferPricing(
  activeOfferIds: ReadonlySet<string>,
  nowUtc: number,
): Map<string, SpecialOfferPricing> {
  if (activeOfferIds.size === 0) return new Map();
  const catalog = getEventsCatalog();
  const out = new Map<string, SpecialOfferPricing>();
  for (const ev of catalog) {
    if (!activeOfferIds.has(ev.id)) continue;
    if (ev.kind !== 'special_offer') continue;
    const startsAt = Date.parse(ev.startsAtUtc);
    const endsAt = Date.parse(ev.endsAtUtc);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (!(startsAt <= nowUtc && nowUtc < endsAt)) continue;
    const payload = ev.payload as { sku?: unknown; discountPct?: unknown };
    if (typeof payload.sku !== 'string' || payload.sku.length === 0) continue;
    if (out.has(payload.sku)) continue; // first one wins
    const offer = findOffer(payload.sku);
    if (!offer) continue;
    const baseCoins = typeof offer.priceCoins === 'number' ? offer.priceCoins : 0;
    const baseGems = typeof offer.priceGems === 'number' ? offer.priceGems : 0;
    const pct = typeof payload.discountPct === 'number' && Number.isFinite(payload.discountPct)
      ? Math.max(0, Math.min(100, payload.discountPct))
      : 0;
    const finalCoins = pct > 0 && baseCoins > 0 ? Math.max(1, Math.floor(baseCoins * (100 - pct) / 100)) : baseCoins;
    const finalGems = pct > 0 && baseGems > 0 ? Math.max(1, Math.floor(baseGems * (100 - pct) / 100)) : baseGems;
    out.set(offer.offerId, { eventId: ev.id, finalPrice: { coins: finalCoins, gems: finalGems } });
  }
  return out;
}

function findOffer(offerId: string): StoreOffer | null {
  const catalog = getStoreCatalog();
  for (const section of catalog.sections) {
    for (const o of section.offers) {
      if (o.offerId === offerId) return o;
    }
  }
  return null;
}

function refundSpend(
  offer: StoreOffer,
  userId: string,
  nk: INakama,
  metadata: LedgerMetadata,
): void {
  const refund: { coins?: number; gems?: number } = {};
  const c = offer.priceCoins;
  const g = offer.priceGems;
  if (typeof c === 'number' && c > 0) refund.coins = c;
  if (typeof g === 'number' && g > 0) refund.gems = g;
  if (Object.keys(refund).length > 0) {
    grant(
      nk,
      userId,
      refund,
      { ...metadata, sourceId: `${offer.offerId}:refund` },
      `store:buy:${offer.kind}:${userId}:${offer.refId}:refund`,
    );
  }
}

function readLevelFromProfile(nk: INakama, userId: string): number {
  const profile = nk.storageRead([{ collection: 'profiles', key: userId, userId }])[0];
  if (!profile) return 1;
  const v = profile.value as Record<string, unknown>;
  const prog = v['progression'] as { level?: number } | undefined;
  return typeof prog?.level === 'number' ? prog.level : 1;
}

function walletGetLocal(nk: INakama, userId: string): { coins: number; gems: number } {
  const view = walletGet(nk, userId);
  return { coins: view.coins, gems: view.gems };
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
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('store RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level bindings for the goja AST scanner.
export const store_get: RpcHandler = store_get_impl;
export const store_buy: RpcHandler = store_buy_impl;