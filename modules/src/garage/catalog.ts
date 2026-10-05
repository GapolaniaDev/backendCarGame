// Phase 3 garage catalog: cars + upgrades + cosmetics. Loaded at
// InitModule, cross-worker persisted via localcache. Three JSON
// sources collapse into one frozen runtime object.

import type { ILogger, INakama } from '../nkruntime';
import type { ClassId } from '../economy/types';
import type {
  CarsCatalog,
  CosmeticsCatalog,
  UpgradesCatalog,
  CarCatalogEntry,
  CosmeticCatalogEntry,
  UpgradeLevelEntry,
  UpgradeLine,
} from './types';

export interface GarageCatalog {
  cars: CarsCatalog;
  upgrades: UpgradesCatalog;
  cosmetics: CosmeticsCatalog;
}

/** Raw mutable input shape (matches the JSON). */
export interface RawCarsFile {
  version: number;
  cars: CarCatalogEntry[];
}
export interface RawUpgradesFile {
  version: number;
  lines: UpgradeLine[];
  maxLevel: number;
  perCarClass: Record<ClassId, Record<UpgradeLine, UpgradeLevelEntry[]>>;
}
export interface RawCosmeticsFile {
  version: number;
  items: CosmeticCatalogEntry[];
}

export interface RawGarageFiles {
  cars: RawCarsFile;
  upgrades: RawUpgradesFile;
  cosmetics: RawCosmeticsFile;
}

export const GARAGE_CATALOG_CACHE_KEY = 'garage:catalog:v1';

let moduleCatalog: GarageCatalog | null = null;

export function getGarageCatalog(): GarageCatalog {
  if (moduleCatalog === null) {
    throw new Error('garage catalog not loaded; call loadGarageCatalog() first');
  }
  return moduleCatalog;
}

export function getCarsCatalog(): CarsCatalog {
  return getGarageCatalog().cars;
}
export function getUpgradesCatalog(): UpgradesCatalog {
  return getGarageCatalog().upgrades;
}
export function getCosmeticsCatalog(): CosmeticsCatalog {
  return getGarageCatalog().cosmetics;
}

export function loadGarageCatalog(
  logger: ILogger,
  raw: RawGarageFiles,
  nk?: INakama,
): void {
  validateCars(raw.cars);
  validateUpgrades(raw.upgrades);
  validateCosmetics(raw.cosmetics);
  moduleCatalog = {
    cars: Object.freeze({
      version: raw.cars.version,
      cars: Object.freeze(raw.cars.cars.map((c) => freezeCar(c))),
    }),
    upgrades: Object.freeze({
      version: raw.upgrades.version,
      lines: Object.freeze([...raw.upgrades.lines]),
      maxLevel: raw.upgrades.maxLevel,
      perCarClass: freezePerCarClass(raw.upgrades.perCarClass),
    }),
    cosmetics: Object.freeze({
      version: raw.cosmetics.version,
      items: Object.freeze(raw.cosmetics.items.map((c) => freezeCosmetic(c))),
    }),
  };
  if (nk) {
    nk.localcachePut(GARAGE_CATALOG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'garage catalog loaded: cars=%d cosmetics=%d upgradeLines=%d',
    raw.cars.cars.length,
    raw.cosmetics.items.length,
    raw.upgrades.lines.length,
  );
}

export function _resetGarageForTests(): void {
  moduleCatalog = null;
}

// ─── Frozen-shape helpers ─────────────────────────────────────────────────────

function freezeCar(c: CarCatalogEntry): CarCatalogEntry {
  return Object.freeze({
    ...c,
    baseStats: Object.freeze({ ...c.baseStats }),
    maxStats: Object.freeze({ ...c.maxStats }),
  });
}

function freezeCosmetic(c: CosmeticCatalogEntry): CosmeticCatalogEntry {
  return Object.freeze({
    ...c,
    compatibleClasses: Object.freeze([...c.compatibleClasses]),
  });
}

function freezeUpgradeLevel(u: UpgradeLevelEntry): UpgradeLevelEntry {
  return Object.freeze({
    ...u,
    delta: Object.freeze({ ...u.delta }),
  });
}

function freezePerCarClass(
  perCarClass: RawUpgradesFile['perCarClass'],
): UpgradesCatalog['perCarClass'] {
  const out = {} as Record<ClassId, Record<UpgradeLine, ReadonlyArray<Readonly<UpgradeLevelEntry>>>>;
  for (const cls of Object.keys(perCarClass) as ClassId[]) {
    const linesRaw = perCarClass[cls];
    const linesOut = {} as Record<UpgradeLine, ReadonlyArray<Readonly<UpgradeLevelEntry>>>;
    for (const line of Object.keys(linesRaw) as UpgradeLine[]) {
      const levels = linesRaw[line];
      linesOut[line] = Object.freeze(levels.map((l) => freezeUpgradeLevel(l)));
    }
    (out as Record<string, unknown>)[cls] = Object.freeze(linesOut);
  }
  return out;
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALID_CLASSES = new Set(['D', 'C', 'B', 'A', 'S']);
const VALID_UPGRADE_LINES = new Set(['engine', 'tires', 'nitro', 'handling']);
const VALID_SLOTS = new Set(['paint', 'wheels', 'decal', 'trail', 'horn']);
const VALID_RARITIES = new Set(['common', 'rare', 'epic', 'legendary']);
const VALID_STATS = ['speed', 'acceleration', 'handling', 'nitro'] as const;

export function validateCars(raw: unknown): asserts raw is RawCarsFile {
  const fail = (msg: string): never => {
    throw new Error(`cars catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);
  const cars = r['cars'];
  if (!Array.isArray(cars) || cars.length === 0) fail('cars must be a non-empty array');
  const carsArr = cars as unknown[];
  const seen = new Set<string>();
  let starterCount = 0;
  carsArr.forEach((rawC: unknown, idx: number) => {
    if (!isPlainObject(rawC)) fail(`cars[${idx}] must be an object`);
    const c = rawC as Record<string, unknown>;
    const id = c['id'];
    if (typeof id !== 'string' || id.length === 0) fail(`cars[${idx}].id must be a non-empty string`);
    if (seen.has(id as string)) fail(`duplicate car id: ${String(id)}`);
    seen.add(id as string);
    if (typeof c['displayName'] !== 'string') fail(`cars[${idx}].displayName must be a string`);
    const cls = c['classId'];
    if (typeof cls !== 'string' || !VALID_CLASSES.has(cls)) {
      fail(`cars[${idx}].classId must be one of D|C|B|A|S, got ${String(cls)}`);
    }
    for (const k of VALID_STATS) {
      const bs = (c['baseStats'] as Record<string, unknown> | undefined)?.[k];
      const ms = (c['maxStats'] as Record<string, unknown> | undefined)?.[k];
      if (typeof bs !== 'number' || bs < 0) fail(`cars[${idx}].baseStats.${k} must be ≥ 0`);
      if (typeof ms !== 'number' || ms < 0) fail(`cars[${idx}].maxStats.${k} must be ≥ 0`);
      if (typeof bs === 'number' && typeof ms === 'number' && ms < bs) {
        fail(`cars[${idx}].maxStats.${k} (${ms}) must be ≥ baseStats.${k} (${bs})`);
      }
    }
    const price = c['priceCoins'];
    if (typeof price !== 'number' || !Number.isInteger(price) || (price as number) < 0) {
      fail(`cars[${idx}].priceCoins must be a non-negative integer`);
    }
    if (c['priceGems'] !== undefined) {
      if (typeof c['priceGems'] !== 'number' || (c['priceGems'] as number) < 0) {
        fail(`cars[${idx}].priceGems must be a non-negative integer when present`);
      }
    }
    const req = c['requiredLevel'];
    if (typeof req !== 'number' || !Number.isInteger(req) || (req as number) < 1 || (req as number) > 50) {
      fail(`cars[${idx}].requiredLevel must be an integer 1..50`);
    }
    if (c['isStarter'] === true) starterCount += 1;
  });
  if (starterCount !== 1) {
    fail(`exactly one car must have isStarter=true, got ${starterCount}`);
  }
}

export function validateUpgrades(raw: unknown): asserts raw is RawUpgradesFile {
  const fail = (msg: string): never => {
    throw new Error(`upgrades catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);
  const lines = r['lines'];
  if (!Array.isArray(lines) || lines.length !== 4) fail('lines must be a 4-entry array');
  const linesArr = lines as unknown[];
  for (const l of linesArr) {
    if (typeof l !== 'string' || !VALID_UPGRADE_LINES.has(l)) {
      fail(`lines contains invalid upgrade line "${String(l)}"`);
    }
  }
  const max = r['maxLevel'];
  if (typeof max !== 'number' || max !== 5) fail(`maxLevel must be 5, got ${String(max)}`);
  const perCarClass = r['perCarClass'];
  if (!isPlainObject(perCarClass)) fail('perCarClass must be an object');
  for (const cls of VALID_CLASSES) {
    const classTable = (perCarClass as Record<string, unknown>)[cls];
    if (!isPlainObject(classTable)) fail(`perCarClass.${cls} must be an object`);
    for (const line of linesArr) {
      if (typeof line !== 'string') continue;
      const levels = (classTable as Record<string, unknown>)[line];
      if (!Array.isArray(levels) || levels.length !== 5) {
        fail(`perCarClass.${cls}.${line} must be a 5-entry array`);
      }
      const arr = levels as unknown[];
      arr.forEach((rawL: unknown, idx: number) => {
        if (!isPlainObject(rawL)) fail(`perCarClass.${cls}.${line}[${idx}] must be an object`);
        const l = rawL as Record<string, unknown>;
        if (l['level'] !== idx + 1) {
          fail(`perCarClass.${cls}.${line}[${idx}].level must equal ${idx + 1}`);
        }
        const cost = l['cost'];
        if (typeof cost !== 'number' || !Number.isInteger(cost) || (cost as number) < 0) {
          fail(`perCarClass.${cls}.${line}[${idx}].cost must be a non-negative integer`);
        }
        if (!isPlainObject(l['delta'])) {
          fail(`perCarClass.${cls}.${line}[${idx}].delta must be an object`);
        }
      });
    }
  }
}

export function validateCosmetics(raw: unknown): asserts raw is RawCosmeticsFile {
  const fail = (msg: string): never => {
    throw new Error(`cosmetics catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);
  const items = r['items'];
  if (!Array.isArray(items)) fail('items must be an array');
  const itemsArr = items as unknown[];
  const seen = new Set<string>();
  itemsArr.forEach((rawI: unknown, idx: number) => {
    if (!isPlainObject(rawI)) fail(`items[${idx}] must be an object`);
    const i = rawI as Record<string, unknown>;
    const id = i['id'];
    if (typeof id !== 'string' || id.length === 0) fail(`items[${idx}].id must be a non-empty string`);
    if (seen.has(id as string)) fail(`duplicate cosmetic id: ${String(id)}`);
    seen.add(id as string);
    if (typeof i['displayName'] !== 'string') fail(`items[${idx}].displayName must be a string`);
    if (typeof i['type'] !== 'string' || !VALID_SLOTS.has(i['type'] as string)) {
      fail(`items[${idx}].type must be one of paint|wheels|decal|trail|horn`);
    }
    if (typeof i['rarity'] !== 'string' || !VALID_RARITIES.has(i['rarity'] as string)) {
      fail(`items[${idx}].rarity must be one of common|rare|epic|legendary`);
    }
    if (i['priceCoins'] === undefined && i['priceGems'] === undefined) {
      fail(`items[${idx}] must declare at least priceCoins or priceGems`);
    }
    if (i['priceCoins'] !== undefined) {
      if (typeof i['priceCoins'] !== 'number' || (i['priceCoins'] as number) < 0) {
        fail(`items[${idx}].priceCoins must be a non-negative integer when present`);
      }
    }
    if (i['priceGems'] !== undefined) {
      if (typeof i['priceGems'] !== 'number' || (i['priceGems'] as number) < 0) {
        fail(`items[${idx}].priceGems must be a non-negative integer when present`);
      }
    }
    const cc = i['compatibleClasses'];
    if (!Array.isArray(cc) || (cc as unknown[]).length === 0) {
      fail(`items[${idx}].compatibleClasses must be a non-empty array`);
    }
    for (const cls of cc as unknown[]) {
      if (typeof cls !== 'string' || !VALID_CLASSES.has(cls as string)) {
        fail(`items[${idx}].compatibleClasses contains invalid class "${String(cls)}"`);
      }
    }
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}