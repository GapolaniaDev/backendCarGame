// Phase 6 — battle pass catalog loader + level helpers.
//
// Loads pass_<seasonId>.json at InitModule. Catalog stores level
// thresholds (xpRequired) plus per-level rewards for both tracks.
//
// The XP → level curve is monotonic: xpToLevel(xp) returns the level
// whose xpRequired ≤ xp and is the highest such level (or 1 when
// xp < first non-1 threshold).

import type { ILogger, INakama } from '../nkruntime';
import type {
  PassCatalog,
  PassLevel,
  PassLevelReward,
  PassRecord,
} from './types';

export interface RawPassFile {
  version: number;
  seasonId: string;
  startUtc: string;
  endUtc: string;
  maxLevel: number;
  levels: PassLevel[];
  premiumPriceGems: number;
}

const PASS_CACHE_PREFIX = 'pass:catalog:';
const PASS_CACHE_TTL_SEC = 7 * 24 * 60 * 60;

let moduleCatalog: Readonly<PassCatalog> | null = null;

export function getPassCatalog(): Readonly<PassCatalog> {
  if (moduleCatalog === null) {
    throw new Error('pass catalog not loaded; call loadPassCatalog() first');
  }
  return moduleCatalog;
}

export function loadPassCatalog(
  logger: ILogger,
  raw: RawPassFile,
  nk?: INakama,
): void {
  validate(raw);
  const catalog: PassCatalog = Object.freeze({
    version: 1,
    seasonId: raw.seasonId,
    startUtc: raw.startUtc,
    endUtc: raw.endUtc,
    maxLevel: raw.maxLevel,
    levels: Object.freeze(
      raw.levels.map((lvl) => Object.freeze({
        level: lvl.level,
        xpRequired: lvl.xpRequired,
        freeReward: Object.freeze({ ...lvl.freeReward }) as PassLevelReward,
        premiumReward: Object.freeze({ ...lvl.premiumReward }) as PassLevelReward,
      })),
    ),
    premiumPriceGems: raw.premiumPriceGems,
  });
  moduleCatalog = catalog;
  if (nk) {
    nk.localcachePut(
      `${PASS_CACHE_PREFIX}${raw.seasonId}:v1`,
      JSON.stringify(raw),
      PASS_CACHE_TTL_SEC,
    );
  }
  logger.info(
    'pass catalog loaded: seasonId=%s levels=%d maxLevel=%d premiumPrice=%d gems',
    catalog.seasonId, catalog.levels.length, catalog.maxLevel, catalog.premiumPriceGems,
  );
}

export function _resetPassCatalogForTests(): void {
  moduleCatalog = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the level whose entry matches `level`, or null when out of range. */
export function findLevel(catalog: Readonly<PassCatalog>, level: number): PassLevel | null {
  if (level < 1 || level > catalog.levels.length) return null;
  const idx = level - 1;
  const found = catalog.levels[idx];
  return found !== undefined ? found : null;
}

/**
 * Compute the current level from cumulative pass XP. The curve is
 * monotonic: every level N has xpRequired(N) > xpRequired(N-1), so
 * we walk backwards from the last level until we find the largest
 * one whose threshold ≤ xp.
 *
 * When xp is below the level-1 threshold (xpRequired=0) this returns
 * 1 (you start at level 1 with 0 XP).
 */
export function xpToLevel(catalog: Readonly<PassCatalog>, xp: number): number {
  if (xp <= 0) return 1;
  let current = 1;
  for (const lvl of catalog.levels) {
    if (xp >= lvl.xpRequired) current = lvl.level;
    else break;
  }
  return current;
}

/**
 * Returns the cumulative XP required to reach the next level from
 * the given XP. Returns 0 when already at maxLevel.
 */
export function xpToNextLevel(catalog: Readonly<PassCatalog>, xp: number): {
  currentLevel: number;
  nextLevel: number | null;
  xpRequired: number;
  xpRemaining: number;
} {
  const currentLevel = xpToLevel(catalog, xp);
  if (currentLevel >= catalog.maxLevel) {
    return { currentLevel, nextLevel: null, xpRequired: 0, xpRemaining: 0 };
  }
  const next = findLevel(catalog, currentLevel + 1);
  if (next === null) {
    return { currentLevel, nextLevel: null, xpRequired: 0, xpRemaining: 0 };
  }
  return {
    currentLevel,
    nextLevel: next.level,
    xpRequired: next.xpRequired,
    xpRemaining: next.xpRequired - xp,
  };
}

/** Validate a PassRecord (used when reading from storage to detect tampering). */
export function validatePassRecord(rec: unknown): rec is PassRecord {
  if (typeof rec !== 'object' || rec === null) return false;
  const r = rec as Record<string, unknown>;
  if (r['schemaVersion'] !== 1) return false;
  if (typeof r['userId'] !== 'string') return false;
  if (typeof r['seasonId'] !== 'string') return false;
  if (typeof r['xp'] !== 'number') return false;
  if (!Array.isArray(r['claimedFree'])) return false;
  if (!Array.isArray(r['claimedPremium'])) return false;
  if (typeof r['premiumPurchased'] !== 'boolean') return false;
  if (typeof r['seasonClosed'] !== 'boolean') return false;
  return true;
}

// ─── Validators ───────────────────────────────────────────────────────────────

function validate(raw: unknown): asserts raw is RawPassFile {
  const fail = (msg: string): never => {
    throw new Error(`pass catalog invalid: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);
  if (typeof r['seasonId'] !== 'string' || r['seasonId'].length === 0) {
    fail('seasonId must be a non-empty string');
  }
  if (typeof r['startUtc'] !== 'string') fail('startUtc must be a string');
  if (typeof r['endUtc'] !== 'string') fail('endUtc must be a string');
  const start = Date.parse(r['startUtc'] as string);
  if (Number.isNaN(start)) fail(`startUtc unparseable: ${String(r['startUtc'])}`);
  const end = Date.parse(r['endUtc'] as string);
  if (Number.isNaN(end)) fail(`endUtc unparseable: ${String(r['endUtc'])}`);
  if (end <= start) fail('endUtc must be after startUtc');

  const max = r['maxLevel'];
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    fail(`maxLevel must be a positive integer, got ${String(max)}`);
  }
  const levels = r['levels'];
  if (!Array.isArray(levels)) fail('levels must be an array');
  const levelsArr = levels as unknown[];
  if (levelsArr.length !== max) {
    fail(`levels.length (${levelsArr.length}) must equal maxLevel (${max})`);
  }

  const price = r['premiumPriceGems'];
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) {
    fail(`premiumPriceGems must be a positive integer, got ${String(price)}`);
  }

  let lastXp = -1;
  levelsArr.forEach((rawLvl, idx) => {
    if (typeof rawLvl !== 'object' || rawLvl === null) fail(`levels[${idx}] not an object`);
    const l = rawLvl as Record<string, unknown>;
    if (typeof l['level'] !== 'number' || l['level'] !== idx + 1) {
      fail(`levels[${idx}].level must be ${idx + 1}, got ${String(l['level'])}`);
    }
    const xpRaw = l['xpRequired'];
    if (typeof xpRaw !== 'number' || !Number.isInteger(xpRaw) || xpRaw < 0) {
      fail(`levels[${idx}].xpRequired must be a non-negative integer, got ${String(xpRaw)}`);
    }
    const xp: number = xpRaw as number;
    if (xp <= lastXp) {
      fail(`levels[${idx}].xpRequired must be strictly ascending (got ${xp} after ${lastXp})`);
    }
    lastXp = xp;
    validateReward(l['freeReward'], `levels[${idx}].freeReward`);
    validateReward(l['premiumReward'], `levels[${idx}].premiumReward`);
  });
}

function validateReward(raw: unknown, path: string): void {
  const fail = (msg: string): never => {
    throw new Error(`pass catalog invalid: ${path}: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('must be an object');
  const r = raw as Record<string, unknown>;
  for (const k of ['coins', 'gems'] as const) {
    if (r[k] !== undefined) {
      const v = r[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        fail(`${k} must be a non-negative integer, got ${String(v)}`);
      }
    }
  }
  if (r['cosmeticId'] !== undefined) {
    if (typeof r['cosmeticId'] !== 'string' || r['cosmeticId'].length === 0) {
      fail('cosmeticId must be a non-empty string');
    }
  }
  if (r['carId'] !== undefined) {
    if (typeof r['carId'] !== 'string' || r['carId'].length === 0) {
      fail('carId must be a non-empty string');
    }
  }
}