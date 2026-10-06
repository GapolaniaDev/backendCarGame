// Phase 3 pack delivery. The store catalog has `kind: 'pack'`
// offers whose `refId` names a pack (e.g. `coin_sack_small`). The
// contents of each pack live here as a tiny lookup table — packs
// are deliberately small in v1 (just coin bundles) so the catalog
// doesn't need to encode the contents inline.
//
// When a pack is bought, `resolvePackDelivery(refId)` returns the
// `{ coins?, gems? }` changeset to grant to the player. The caller
// is responsible for the spend/grant + the storage write that
// records the purchase.

import type { WalletChangeset } from '../economy/types';

export interface PackDelivery {
  changeset: WalletChangeset;
  /** Display name for logging. */
  displayName: string;
}

const PACK_TABLE: Record<string, PackDelivery> = {
  starter_pack: {
    displayName: 'Pack inicial',
    changeset: { coins: 5000, gems: 50 },
  },
  coin_sack: {
    displayName: 'Bolsa de monedas',
    changeset: { coins: 2500 },
  },
  coin_sack_small: {
    displayName: 'Bolsa monedas pequeña',
    changeset: { coins: 1000 },
  },
  coin_sack_large: {
    displayName: 'Bolsa monedas grande',
    changeset: { coins: 5000 },
  },
};

export function resolvePackDelivery(refId: string): PackDelivery | null {
  return PACK_TABLE[refId] ?? null;
}

export function listKnownPackIds(): ReadonlyArray<string> {
  return Object.keys(PACK_TABLE);
}