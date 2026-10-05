// Phase 3 progression catalog: XP curve (table or synthetic) and
// per-level unlocks. Loaded at InitModule, cross-worker persisted via
// localcache.

import type { ILogger, INakama } from '../nkruntime';
import type { LevelEntry, LevelsCatalog } from './types';
import { MAX_LEVEL } from './types';

export interface RawLevelsFile {
  version: number;
  maxLevel: number;
  xpCurve: 'exponential' | 'table';
  table: LevelEntry[];
}

export const LEVELS_CATALOG_CACHE_KEY = 'levels:catalog:v1';

let moduleCatalog: LevelsCatalog | null = null;

export function getLevelsCatalog(): LevelsCatalog {
  if (moduleCatalog === null) {
    throw new Error('levels catalog not loaded; call loadLevelsCatalog() first');
  }
  return moduleCatalog;
}

export function loadLevelsCatalog(
  logger: ILogger,
  raw: RawLevelsFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleCatalog = Object.freeze({
    version: raw.version,
    maxLevel: raw.maxLevel,
    xpCurve: raw.xpCurve,
    table: Object.freeze(raw.table.map((e) => Object.freeze({ ...e, unlocks: Object.freeze([...e.unlocks]) }))),
  });
  if (nk) {
    nk.localcachePut(LEVELS_CATALOG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'levels catalog loaded: curve=%s levels=%d maxLevel=%d',
    raw.xpCurve,
    raw.table.length,
    raw.maxLevel,
  );
}

export function _resetLevelsForTests(): void {
  moduleCatalog = null;
}

// ─── Validators ───────────────────────────────────────────────────────────────

export function validate(raw: unknown): asserts raw is RawLevelsFile {
  const fail = (msg: string): never => {
    throw new Error(`levels catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const max = r['maxLevel'];
  if (typeof max !== 'number' || max !== MAX_LEVEL) {
    fail(`maxLevel must be ${MAX_LEVEL}, got ${String(max)}`);
  }
  const curve = r['xpCurve'];
  if (curve !== 'exponential' && curve !== 'table') {
    fail(`xpCurve must be 'exponential' or 'table', got ${String(curve)}`);
  }
  const table = r['table'];
  if (!Array.isArray(table)) fail('table must be an array');
  const t = table as unknown[];
  if (t.length !== MAX_LEVEL) {
    fail(`table must have exactly ${MAX_LEVEL} rows, got ${t.length}`);
  }

  let prevXp = -1;
  const seenLevels = new Set<number>();
  t.forEach((rawEntry: unknown, idx: number) => {
    if (!isPlainObject(rawEntry)) fail(`table[${idx}] must be an object`);
    const e = rawEntry as Record<string, unknown>;
    const lvl = e['level'];
    if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 1 || lvl > MAX_LEVEL) {
      fail(`table[${idx}].level must be an integer 1..${MAX_LEVEL}, got ${String(lvl)}`);
    }
    if (seenLevels.has(lvl as number)) fail(`duplicate level ${String(lvl)} in table`);
    seenLevels.add(lvl as number);
    const xp = e['xpRequired'];
    if (typeof xp !== 'number' || !Number.isInteger(xp) || xp < 0) {
      fail(`table[${idx}].xpRequired must be a non-negative integer, got ${String(xp)}`);
    }
    if ((xp as number) <= prevXp) fail(`table[${idx}].xpRequired must be strictly increasing`);
    prevXp = xp as number;
    const rewards = e['rewards'];
    if (!isPlainObject(rewards)) fail(`table[${idx}].rewards must be an object`);
    for (const k of ['coins', 'gems'] as const) {
      const v = (rewards as Record<string, unknown>)[k];
      if (v !== undefined) {
        if (typeof v !== 'number' || !Number.isInteger(v) || (v as number) < 0) {
          fail(`table[${idx}].rewards.${k} must be a non-negative integer when present`);
        }
      }
    }
    const unlocks = e['unlocks'];
    if (!Array.isArray(unlocks)) fail(`table[${idx}].unlocks must be an array`);
    for (const u of unlocks as unknown[]) {
      if (typeof u !== 'string' || u.length === 0) {
        fail(`table[${idx}].unlocks entries must be non-empty strings`);
      }
    }
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}