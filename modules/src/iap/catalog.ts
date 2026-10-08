// Phase 9 Chunk 1 — IAP packs catalog loader.
//
// Reads `catalogs/iap_packs.json` once at boot via
// `loadIapPacksCatalog`. The catalog is the source of truth for what
// the store sells. The runtime keeps an immutable, sorted view in
// `CACHED` and exposes a typed getter that throws if the boot loader
// hasn't run yet (mirrors the tournaments / events pattern).
//
// Cached ordering: `sortOrder` ascending, then `id` ascending as a
// tiebreaker. The store UI relies on this order for the carousel
// layout.

import type { ILogger } from '../nkruntime';
import {
  validateIapPacksFile,
  type IapPack,
} from './types';

let CACHED: ReadonlyArray<IapPack> | null = null;

/**
 * Validate and cache the IAP packs catalog at boot. Public for the
 * main.ts boot path. Idempotent; subsequent calls are no-ops (the
 * second call still validates so a corrupt catalog in the second
 * process rethrows).
 */
export function loadIapPacksCatalog(
  logger: ILogger,
  raw: unknown,
): ReadonlyArray<IapPack> {
  const v = validateIapPacksFile(raw);
  if (!v.ok) {
    throw new Error(`iap_packs catalog invalid: ${v.reason}`);
  }
  const sorted = v.value.slice().sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : 1;
  });
  CACHED = Object.freeze(sorted.map((p) => Object.freeze({ ...p })));
  logger.info('iap_packs catalog loaded: packs=%d', CACHED.length);
  return CACHED;
}

/** Throws if the boot loader hasn't run yet. */
export function getIapPacksCatalog(): ReadonlyArray<IapPack> {
  if (CACHED === null) {
    throw new Error(
      'iap_packs catalog not loaded — call loadIapPacksCatalog at boot',
    );
  }
  return CACHED;
}

/** Find a pack by `id` (the catalog id, not the platform product id). */
export function findIapPack(id: string): IapPack | undefined {
  if (CACHED === null) return undefined;
  return CACHED.find((p) => p.id === id);
}

/** Find a pack by the platform-specific product id. */
export function findIapPackByProductId(
  platform: 'apple' | 'google',
  productId: string,
): IapPack | undefined {
  if (CACHED === null) return undefined;
  return CACHED.find((p) =>
    platform === 'apple' ? p.appleProductId === productId : p.googleProductId === productId,
  );
}

/** Test hook: wipes the cached packs. */
export function _resetIapPacksCatalogForTests(): void {
  CACHED = null;
}
