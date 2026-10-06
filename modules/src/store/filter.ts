// Phase 3 store filter. `store_get` returns the catalog sections
// after applying:
//   - per-offer expiry (offers past `expiresAt` are dropped)
//   - per-player `requiredLevel` (level-gated offers hide when the
//     player's level is below the threshold)
//   - per-player ownership (cars in `garage.cars`, cosmetics in
//     `garage.cosmeticsBag` — bought items are hidden so the client
//     doesn't re-prompt for an already-owned item)
//
// This module is pure — the RPC layer threads the player state in.

import type { StoreOffer, StoreSection, StoreCatalog } from './types';
import type { Garage } from '../garage/types';

export interface FilterContext {
  /** UTC epoch-ms to use as "now" for expiry checks. */
  nowMs: number;
  /** Player's current level. */
  playerLevel: number;
  /** Player's owned cars + cosmetics + purchased packs (from the garage doc). */
  ownedCarIds: ReadonlySet<string>;
  ownedCosmeticIds: ReadonlySet<string>;
  /** Pack ref ids the player has already redeemed. */
  purchasedPackIds: ReadonlySet<string>;
}

export interface FilteredOffer {
  offer: StoreOffer;
  /** True if the offer is one of today's daily-rotation winners. */
  isDailyOffer: boolean;
  /** Diagnostic — why the offer is visible (or hidden) after filtering. */
  reason?: 'expired' | 'level_low' | 'already_owned';
}

/** Convert a Garage into the sets used by `filterOffersForSection`. */
export function ownershipFromGarage(garage: Garage): {
  ownedCarIds: ReadonlySet<string>;
  ownedCosmeticIds: ReadonlySet<string>;
} {
  const ownedCarIds = new Set<string>(garage.cars.map((c) => c.carId));
  const ownedCosmeticIds = new Set<string>(garage.cosmeticsBag);
  return { ownedCarIds, ownedCosmeticIds };
}

/**
 * Filter a single section's offers. Returns the visible offers
 * (preserving the input order from the section) and the reason
 * each hidden one was dropped — useful for an "expiring soon"
 * subview in the future.
 */
export function filterOffersForSection(
  section: StoreSection,
  ctx: FilterContext,
): { visible: FilteredOffer[]; hidden: FilteredOffer[] } {
  const visible: FilteredOffer[] = [];
  const hidden: FilteredOffer[] = [];
  for (const offer of section.offers) {
    const reason = shouldHide(offer, ctx);
    if (reason === null) {
      visible.push({ offer, isDailyOffer: section.id === 'daily' });
    } else {
      hidden.push({ offer, isDailyOffer: false, reason });
    }
  }
  return { visible, hidden };
}

function shouldHide(offer: StoreOffer, ctx: FilterContext): 'expired' | 'level_low' | 'already_owned' | null {
  if (offer.expiresAt !== undefined && offer.expiresAt !== null && ctx.nowMs >= offer.expiresAt) {
    return 'expired';
  }
  if (offer.requiredLevel !== undefined && ctx.playerLevel < offer.requiredLevel) {
    return 'level_low';
  }
  if (offer.kind === 'car' && ctx.ownedCarIds.has(offer.refId)) {
    return 'already_owned';
  }
  if (offer.kind === 'cosmetic' && ctx.ownedCosmeticIds.has(offer.refId)) {
    return 'already_owned';
  }
  if (offer.kind === 'pack' && ctx.purchasedPackIds.has(offer.refId)) {
    return 'already_owned';
  }
  return null;
}

/**
 * Filter the whole catalog. Returns a new array of sections with
 * `visible` offers attached. `hidden` is kept for diagnostics but
 * never sent to the client.
 */
export function filterCatalog(
  catalog: StoreCatalog,
  ctx: FilterContext,
): ReadonlyArray<{ section: StoreSection; visible: FilteredOffer[] }> {
  return catalog.sections.map((section) => {
    const { visible } = filterOffersForSection(section, ctx);
    return { section, visible };
  });
}