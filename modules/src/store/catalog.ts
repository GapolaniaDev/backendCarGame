// Phase 3 store catalog. The store is read-only catalog data with a
// daily rotation overlay. Loaded at InitModule, cross-worker persisted
// via localcache.

import type { ILogger, INakama } from '../nkruntime';
import type { StoreCatalog, StoreOffer, StoreSection, StoreSectionId } from './types';
import { STORE_SECTION_IDS } from './types';

export interface RawStoreFile {
  version: number;
  sections: StoreSection[];
  dailyRotationPoolSize: number;
}

export const STORE_CATALOG_CACHE_KEY = 'store:catalog:v1';

let moduleCatalog: StoreCatalog | null = null;

export function getStoreCatalog(): StoreCatalog {
  if (moduleCatalog === null) {
    throw new Error('store catalog not loaded; call loadStoreCatalog() first');
  }
  return moduleCatalog;
}

export function loadStoreCatalog(
  logger: ILogger,
  raw: RawStoreFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleCatalog = Object.freeze({
    version: raw.version,
    sections: Object.freeze(
      raw.sections.map((s) =>
        Object.freeze({
          ...s,
          offers: Object.freeze(s.offers.map((o) => Object.freeze({ ...o }))),
        }),
      ),
    ),
    dailyRotationPoolSize: raw.dailyRotationPoolSize,
  });
  if (nk) {
    nk.localcachePut(STORE_CATALOG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'store catalog loaded: sections=%d dailyPoolSize=%d',
    raw.sections.length,
    raw.dailyRotationPoolSize,
  );
}

export function _resetStoreForTests(): void {
  moduleCatalog = null;
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALID_KINDS = new Set(['car', 'cosmetic', 'pack']);
const VALID_SECTION_IDS = new Set<StoreSectionId>(STORE_SECTION_IDS);

export function validate(raw: unknown): asserts raw is RawStoreFile {
  const fail = (msg: string): never => {
    throw new Error(`store catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const sections = r['sections'];
  if (!Array.isArray(sections) || sections.length === 0) {
    fail('sections must be a non-empty array');
  }
  const seenSections = new Set<string>();
  const seenOffers = new Set<string>();
  (sections as unknown[]).forEach((rawS: unknown, sIdx: number) => {
    if (!isPlainObject(rawS)) fail(`sections[${sIdx}] must be an object`);
    const s = rawS as Record<string, unknown>;
    if (typeof s['id'] !== 'string' || !VALID_SECTION_IDS.has(s['id'] as StoreSectionId)) {
      fail(`sections[${sIdx}].id must be one of ${Array.from(VALID_SECTION_IDS).join('|')}`);
    }
    if (seenSections.has(s['id'] as string)) fail(`duplicate section id: ${s['id']}`);
    seenSections.add(s['id'] as string);
    if (typeof s['displayName'] !== 'string') fail(`sections[${sIdx}].displayName must be a string`);
    if (!Array.isArray(s['offers'])) fail(`sections[${sIdx}].offers must be an array`);
    (s['offers'] as unknown[]).forEach((rawO: unknown, oIdx: number) => {
      validateOffer(rawO, `sections[${sIdx}].offers[${oIdx}]`, seenOffers, fail);
    });
  });

  const poolSize = r['dailyRotationPoolSize'];
  if (typeof poolSize !== 'number' || !Number.isInteger(poolSize) || poolSize < 1) {
    fail(`dailyRotationPoolSize must be a positive integer`);
  }
}

function validateOffer(
  rawO: unknown,
  path: string,
  seenOffers: Set<string>,
  fail: (msg: string) => never,
): asserts rawO is StoreOffer {
  if (!isPlainObject(rawO)) fail(`${path} must be an object`);
  const o = rawO as Record<string, unknown>;
  if (typeof o['offerId'] !== 'string' || o['offerId'].length === 0) {
    fail(`${path}.offerId must be a non-empty string`);
  }
  if (seenOffers.has(o['offerId'] as string)) {
    fail(`duplicate offerId: ${o['offerId']}`);
  }
  seenOffers.add(o['offerId'] as string);
  if (typeof o['kind'] !== 'string' || !VALID_KINDS.has(o['kind'] as string)) {
    fail(`${path}.kind must be one of car|cosmetic|pack`);
  }
  if (typeof o['refId'] !== 'string' || (o['refId'] as string).length === 0) {
    fail(`${path}.refId must be a non-empty string`);
  }
  if (typeof o['displayName'] !== 'string') {
    fail(`${path}.displayName must be a string`);
  }
  if (o['priceCoins'] === undefined && o['priceGems'] === undefined) {
    fail(`${path} must declare at least priceCoins or priceGems`);
  }
  if (o['priceCoins'] !== undefined) {
    if (typeof o['priceCoins'] !== 'number' || (o['priceCoins'] as number) < 0) {
      fail(`${path}.priceCoins must be a non-negative integer when present`);
    }
  }
  if (o['priceGems'] !== undefined) {
    if (typeof o['priceGems'] !== 'number' || (o['priceGems'] as number) < 0) {
      fail(`${path}.priceGems must be a non-negative integer when present`);
    }
  }
  if (o['requiredLevel'] !== undefined) {
    if (typeof o['requiredLevel'] !== 'number' || (o['requiredLevel'] as number) < 1 || (o['requiredLevel'] as number) > 50) {
      fail(`${path}.requiredLevel must be an integer 1..50`);
    }
  }
  if (o['expiresAt'] !== undefined && o['expiresAt'] !== null) {
    if (typeof o['expiresAt'] !== 'number') {
      fail(`${path}.expiresAt must be a number or null`);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}