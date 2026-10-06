// Phase 4 seasons catalog. Each season defines its date window
// (UTC) and the rating bands that map to divisions. Loaded at
// `InitModule` from `modules/src/catalogs/seasons.json`.
//
// Chunk 1 of the Phase 4 plan ships only the catalog loader and
// types — the RPCs (`mm_ticket_params`, `ranked_get`) come in later
// chunks. The boot wiring is wired in `modules/src/main.ts` after
// the Phase 3 catalog chain.
//
// Decision 2 (Phase 4 plan): the track picker (Chunk 2) excludes the
// last 2 tracks per player — requires no season-level data here, but
// the season boundaries are what `ranked_get` reads for "current
// season" lookup.

import type { ILogger, INakama } from '../nkruntime';

export interface SeasonDivision {
  id: string;
  displayName: string;
  ratingMin: number;
  ratingMax: number;
}

export interface Season {
  id: string;
  displayName: string;
  /** UTC epoch-ms when the season starts. */
  startsAt: number;
  /** UTC epoch-ms when the season ends (exclusive). */
  endsAt: number;
  divisions: ReadonlyArray<SeasonDivision>;
}

export interface SeasonsCatalog {
  version: number;
  seasons: ReadonlyArray<Season>;
}

export interface RawSeasonsFile {
  version: number;
  seasons: ReadonlyArray<{
    id: string;
    displayName: string;
    startsAt: number;
    endsAt: number;
    divisions: ReadonlyArray<{
      id: string;
      displayName: string;
      ratingMin: number;
      ratingMax: number;
    }>;
  }>;
}

export const SEASONS_CATALOG_CACHE_KEY = 'seasons:catalog:v1';

let moduleCatalog: SeasonsCatalog | null = null;

export function getSeasonsCatalog(): SeasonsCatalog {
  if (moduleCatalog === null) {
    throw new Error('seasons catalog not loaded; call loadSeasonsCatalog() first');
  }
  return moduleCatalog;
}

export function loadSeasonsCatalog(
  logger: ILogger,
  raw: RawSeasonsFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleCatalog = Object.freeze({
    version: raw.version,
    seasons: Object.freeze(
      raw.seasons.map((s) =>
        Object.freeze({
          id: s.id,
          displayName: s.displayName,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          divisions: Object.freeze(
            s.divisions.map((d) => Object.freeze({ ...d })),
          ),
        }),
      ),
    ),
  });
  if (nk) {
    nk.localcachePut(SEASONS_CATALOG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'seasons catalog loaded: seasons=%d firstEndsAt=%s',
    raw.seasons.length,
    raw.seasons[0]?.endsAt ?? 'none',
  );
}

export function _resetSeasonsForTests(): void {
  moduleCatalog = null;
}

/**
 * Return the season whose UTC window contains `nowMs`, or `null` if
 * we're between seasons. Pure function used by `ranked_get` and the
 * RaceCompleted reward path.
 */
export function findActiveSeason(catalog: SeasonsCatalog, nowMs: number): Season | null {
  for (const s of catalog.seasons) {
    if (nowMs >= s.startsAt && nowMs < s.endsAt) return s;
  }
  return null;
}

export function validate(raw: unknown): asserts raw is RawSeasonsFile {
  const fail = (msg: string): never => {
    throw new Error(`seasons catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const arr = r['seasons'];
  if (!Array.isArray(arr)) fail('seasons must be an array');
  const arrTyped = arr as unknown[];
  if (arrTyped.length === 0) fail('seasons must contain at least one entry');

  const seen = new Set<string>();
  for (let i = 0; i < arrTyped.length; i += 1) {
    const s = arrTyped[i];
    if (!isPlainObject(s)) fail(`seasons[${i}] must be an object`);
    const ss = s as Record<string, unknown>;
    if (typeof ss['id'] !== 'string' || ss['id'].length === 0) {
      fail(`seasons[${i}].id must be a non-empty string`);
    }
    if (seen.has(ss['id'] as string)) {
      fail(`seasons[${i}].id duplicates an earlier entry: ${String(ss['id'])}`);
    }
    seen.add(ss['id'] as string);
    if (typeof ss['displayName'] !== 'string' || (ss['displayName'] as string).length === 0) {
      fail(`seasons[${i}].displayName must be a non-empty string`);
    }
    if (typeof ss['startsAt'] !== 'number' || !Number.isInteger(ss['startsAt'] as number) || (ss['startsAt'] as number) < 0) {
      fail(`seasons[${i}].startsAt must be a non-negative integer epoch-ms`);
    }
    if (typeof ss['endsAt'] !== 'number' || !Number.isInteger(ss['endsAt'] as number) || (ss['endsAt'] as number) < 0) {
      fail(`seasons[${i}].endsAt must be a non-negative integer epoch-ms`);
    }
    if ((ss['endsAt'] as number) <= (ss['startsAt'] as number)) {
      fail(`seasons[${i}].endsAt must be > startsAt`);
    }
    const divisions = ss['divisions'];
    if (!Array.isArray(divisions)) fail(`seasons[${i}].divisions must be an array`);
    if ((divisions as unknown[]).length === 0) {
      fail(`seasons[${i}].divisions must contain at least one entry`);
    }
    let prevMax = -1;
    const divSeen = new Set<string>();
    for (let j = 0; j < (divisions as unknown[]).length; j += 1) {
      const d = (divisions as unknown[])[j];
      if (!isPlainObject(d)) fail(`seasons[${i}].divisions[${j}] must be an object`);
      const dd = d as Record<string, unknown>;
      if (typeof dd['id'] !== 'string' || (dd['id'] as string).length === 0) {
        fail(`seasons[${i}].divisions[${j}].id must be a non-empty string`);
      }
      if (divSeen.has(dd['id'] as string)) {
        fail(`seasons[${i}].divisions[${j}].id duplicates an earlier entry`);
      }
      divSeen.add(dd['id'] as string);
      if (typeof dd['ratingMin'] !== 'number' || !Number.isInteger(dd['ratingMin'] as number) || (dd['ratingMin'] as number) < 0) {
        fail(`seasons[${i}].divisions[${j}].ratingMin must be a non-negative integer`);
      }
      if (typeof dd['ratingMax'] !== 'number' || !Number.isInteger(dd['ratingMax'] as number) || (dd['ratingMax'] as number) < 0) {
        fail(`seasons[${i}].divisions[${j}].ratingMax must be a non-negative integer`);
      }
      if ((dd['ratingMax'] as number) <= (dd['ratingMin'] as number)) {
        fail(`seasons[${i}].divisions[${j}].ratingMax must be > ratingMin`);
      }
      if ((dd['ratingMin'] as number) <= prevMax) {
        fail(`seasons[${i}].divisions[${j}] must start at or after the previous max (${prevMax})`);
      }
      prevMax = (dd['ratingMax'] as number);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}