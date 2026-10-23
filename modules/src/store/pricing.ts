// Store prices (plan T-12, audit PC-20, 05 f20). `store_get` shows and
// `store_buy` charges the result of the SAME function, so the price
// charged is the price shown, special-offer discount included.
//
// A discount applies when a live `special_offer` event of the events
// calendar (the one event source, plan T-23) has the offer id as its
// `payload.sku` and a window that contains the server's "now". Unknown SKUs never get here: the events catalog
// drops them at load (`loadEventsCatalog`).

import { getEventsCatalog } from '../core/active_events';
import { getStoreCatalog } from './catalog';
import type { StoreOffer } from './types';

/** A price as `{currencyId: amount}` over the two soft currencies. */
export interface OfferPrice {
  coins: number;
  gems: number;
}

export interface SpecialOfferPricing {
  eventId: string;
  finalPrice: OfferPrice;
}

/** The catalog price of an offer (zeros for a currency it does not charge). */
export function basePrice(offer: StoreOffer): OfferPrice {
  return {
    coins: typeof offer.priceCoins === 'number' ? offer.priceCoins : 0,
    gems: typeof offer.priceGems === 'number' ? offer.priceGems : 0,
  };
}

/**
 * Map offerId → special-offer pricing for the player's active
 * `special_offer` events. Multiple matching events are deduped by
 * offerId (the first one wins). Empty when no special offer applies.
 */
export function specialOfferPricing(
  activeOfferIds: ReadonlySet<string>,
  nowUtc: number,
): Map<string, SpecialOfferPricing> {
  const out = new Map<string, SpecialOfferPricing>();
  if (activeOfferIds.size === 0) return out;
  for (const ev of getEventsCatalog()) {
    if (!activeOfferIds.has(ev.id)) continue;
    if (ev.kind !== 'special_offer') continue;
    const startsAt = Date.parse(ev.startsAtUtc);
    const endsAt = Date.parse(ev.endsAtUtc);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (!(startsAt <= nowUtc && nowUtc < endsAt)) continue;
    const payload = ev.payload as { sku?: unknown; discountPct?: unknown };
    if (typeof payload.sku !== 'string' || payload.sku.length === 0) continue;
    if (out.has(payload.sku)) continue;
    const offer = findStoreOffer(payload.sku);
    if (!offer) continue;
    const base = basePrice(offer);
    const pct = typeof payload.discountPct === 'number' && Number.isFinite(payload.discountPct)
      ? Math.max(0, Math.min(100, payload.discountPct))
      : 0;
    out.set(offer.offerId, {
      eventId: ev.id,
      finalPrice: { coins: discounted(base.coins, pct), gems: discounted(base.gems, pct) },
    });
  }
  return out;
}

/** The price the player pays: the special-offer price, else the catalog one. */
export function finalPrice(offer: StoreOffer, pricing: ReadonlyMap<string, SpecialOfferPricing>): OfferPrice {
  return pricing.get(offer.offerId)?.finalPrice ?? basePrice(offer);
}

export function findStoreOffer(offerId: string): StoreOffer | null {
  for (const section of getStoreCatalog().sections) {
    for (const o of section.offers) {
      if (o.offerId === offerId) return o;
    }
  }
  return null;
}

/** A discounted amount never drops a charged currency to 0. */
function discounted(amount: number, pct: number): number {
  if (pct <= 0 || amount <= 0) return amount;
  return Math.max(1, Math.floor(amount * (100 - pct) / 100));
}
