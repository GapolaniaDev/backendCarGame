// Leaderboards catalog: declarative table registry loaded from JSON
// at InitModule. Each entry produces one authoritative leaderboard
// table via `nk.leaderboardCreate`. The track-scoped patterns expand
// at boot time to the cartesian product of (track, class).
//
// Persistence: like the tracks/modes catalog, the resolved table list
// (after expansion) is serialized to `nk.localcachePut` so the other
// JS runtime pool workers can resolve it.
//
// Season-scoped patterns (`ranked_{season}`) are not expanded at boot:
// the season id is only known at run time (a lazy close can mint one),
// so `getSeasonTable` resolves them on demand. Their sort order and
// operator still come from this catalog (plan T-13).

import type { ILogger, INakama } from '../nkruntime';

export type LeaderboardOperator = 'best' | 'set' | 'incr' | 'decr';
export type LeaderboardSortOrder = 'asc' | 'desc';

export interface LeaderboardTableEntry {
  /** Final, fully-expanded table id (e.g. `tt_neon_blvd_B_all`). */
  id: string;
  /** Aggregation operator. */
  operator: LeaderboardOperator;
  /** Sort order for the leaderboard view. */
  sortOrder: LeaderboardSortOrder;
  /** Cron schedule string for periodic resets (empty = never). */
  resetSchedule: string;
  /** Free-form description, surfaced in `lb_get` metadata. */
  description: string;
  /** Which `key` from the table-scoped catalog this row came from. */
  source: string;
}

export interface LeaderboardCatalog {
  version: number;
  tables: ReadonlyArray<LeaderboardTableEntry>;
}

// ─── JSON source shapes ───────────────────────────────────────────────────────

export interface RawTablesFile {
  version: number;
  tables: Array<{
    id: string;
    operator: LeaderboardOperator;
    sortOrder: LeaderboardSortOrder;
    resetSchedule: string;
    description: string;
  }>;
  trackScoped: {
    tracks: string[];
    classes: string[];
    patterns: Record<
      string,
      {
        template: string;
        operator: LeaderboardOperator;
        sortOrder: LeaderboardSortOrder;
        resetSchedule: string;
        description: string;
      }
    >;
  };
  /** Tables whose id carries a season (`{season}`); keyed by source name. */
  seasonScoped: Record<string, RawPattern>;
  deprecated: Array<{ id: string; reason: string }>;
}

interface RawPattern {
  template: string;
  operator: LeaderboardOperator;
  sortOrder: LeaderboardSortOrder;
  resetSchedule: string;
  description: string;
}

// ─── Loader state (cross-worker via localcache) ───────────────────────────────

export const LEADERBOARD_CATALOG_CACHE_KEY = 'leaderboards:catalog:v1';

let moduleTables: ReadonlyArray<LeaderboardTableEntry> | null = null;
let moduleById: ReadonlyMap<string, LeaderboardTableEntry> | null = null;
let moduleSeasonPatterns: ReadonlyMap<string, RawPattern> | null = null;

/** Source name of the ranked rating table pattern in `seasonScoped`. */
export const RANKED_TABLE_SOURCE = 'ranked';
const SEASON_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function getLeaderboardTables(): ReadonlyArray<LeaderboardTableEntry> {
  return resolveTables();
}

export function getLeaderboardTable(id: string): LeaderboardTableEntry | undefined {
  resolveTables();
  return moduleById!.get(id);
}

/** Like `getLeaderboardTables` but only returns tables that fit a `(track, class)` pair. */
export function getTrackScopedTables(): ReadonlyArray<LeaderboardTableEntry> {
  return resolveTables().filter((t) => t.source !== 'wins_week');
}

/** Returns only the always-on (never-reset) time-trial tables for a track. */
export function getTtAllTables(trackId: string): LeaderboardTableEntry[] {
  return resolveTables().filter((t) => t.id.startsWith(`tt_${trackId}_`) && t.id.endsWith('_all'));
}

/** Returns the weekly time-trial tables for a track. */
export function getTtWeekTables(trackId: string): LeaderboardTableEntry[] {
  return resolveTables().filter((t) => t.id.startsWith(`tt_${trackId}_`) && t.id.endsWith('_week'));
}

/** Returns the always-on best-lap tables for a track. */
export function getLapAllTables(trackId: string): LeaderboardTableEntry[] {
  return resolveTables().filter((t) => t.id.startsWith(`lap_${trackId}_`) && t.id.endsWith('_all'));
}

export function getWinsWeekTable(): LeaderboardTableEntry | undefined {
  return resolveTables().find((t) => t.id === 'wins_week');
}

/** The `source` table of the season `seasonId` (e.g. `ranked_season_2`). */
export function getSeasonTable(source: string, seasonId: string): LeaderboardTableEntry {
  resolveTables();
  const pattern = moduleSeasonPatterns!.get(source);
  if (pattern === undefined) {
    throw new Error(`leaderboards catalog: no season-scoped pattern "${source}"`);
  }
  if (!SEASON_ID_PATTERN.test(seasonId)) {
    throw new Error(`leaderboards catalog: invalid season id "${seasonId}"`);
  }
  return seasonEntry(source, pattern, seasonId);
}

/** The ranked rating table of `seasonId`: `desc`, so rank 1 is the best rating. */
export function getRankedTable(seasonId: string): LeaderboardTableEntry {
  return getSeasonTable(RANKED_TABLE_SOURCE, seasonId);
}

/**
 * A catalog table, or a season-scoped one whose id matches a pattern
 * (`ranked_season_2`). Used by `lb_get` to accept the ranked table.
 */
export function resolveLeaderboardTable(id: string): LeaderboardTableEntry | undefined {
  const fixed = getLeaderboardTable(id);
  if (fixed !== undefined) return fixed;
  for (const [source, pattern] of moduleSeasonPatterns!) {
    const [prefix, suffix] = pattern.template.split('{season}') as [string, string];
    if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
    const seasonId = id.slice(prefix.length, id.length - suffix.length);
    if (SEASON_ID_PATTERN.test(seasonId)) return seasonEntry(source, pattern, seasonId);
  }
  return undefined;
}

function seasonEntry(source: string, pattern: RawPattern, seasonId: string): LeaderboardTableEntry {
  return {
    id: pattern.template.replace('{season}', seasonId),
    operator: pattern.operator,
    sortOrder: pattern.sortOrder,
    resetSchedule: pattern.resetSchedule,
    description: pattern.description,
    source,
  };
}

// ─── Load entrypoint ──────────────────────────────────────────────────────────

/**
 * Validate and expand the raw catalog JSON into a flat list of
 * resolved `LeaderboardTableEntry`s. Persist into `nk.localcache` for
 * other JS runtime pool workers to resolve.
 */
export function loadLeaderboardsCatalog(
  logger: ILogger,
  raw: RawTablesFile,
  nk?: INakama,
): void {
  validate(raw);

  const tables: LeaderboardTableEntry[] = [];
  for (const t of raw.tables) {
    tables.push({
      id: t.id,
      operator: t.operator,
      sortOrder: t.sortOrder,
      resetSchedule: t.resetSchedule,
      description: t.description,
      source: t.id,
    });
  }
  for (const [patternName, pattern] of Object.entries(raw.trackScoped.patterns)) {
    for (const track of raw.trackScoped.tracks) {
      for (const cls of raw.trackScoped.classes) {
        const id = pattern.template
          .replace('{track}', track)
          .replace('{class}', cls);
        tables.push({
          id,
          operator: pattern.operator,
          sortOrder: pattern.sortOrder,
          resetSchedule: pattern.resetSchedule,
          description: pattern.description,
          source: patternName,
        });
      }
    }
  }

  const byId = new Map<string, LeaderboardTableEntry>();
  for (const t of tables) {
    if (byId.has(t.id)) {
      throw new Error(`leaderboard catalog: duplicate table id "${t.id}"`);
    }
    byId.set(t.id, t);
  }

  moduleTables = Object.freeze(tables);
  moduleById = byId;
  moduleSeasonPatterns = new Map(Object.entries(raw.seasonScoped));

  if (nk) {
    const serialized = JSON.stringify({
      tables: tables.map((t) => ({
        id: t.id,
        operator: t.operator,
        sortOrder: t.sortOrder,
        resetSchedule: t.resetSchedule,
        description: t.description,
        source: t.source,
      })),
    });
    nk.localcachePut(LEADERBOARD_CATALOG_CACHE_KEY, serialized, 7 * 24 * 60 * 60);
  }

  logger.info(
    'leaderboards catalog loaded: tables=%d seasonScoped=%d',
    tables.length,
    moduleSeasonPatterns.size,
  );
}

/** Test-only: reset the in-memory leaderboard catalog. */
export function _resetLeaderboardsForTests(): void {
  moduleTables = null;
  moduleById = null;
  moduleSeasonPatterns = null;
}

function resolveTables(): ReadonlyArray<LeaderboardTableEntry> {
  if (moduleTables !== null) return moduleTables;
  throw new Error('leaderboards catalog not loaded; call loadLeaderboardsCatalog() first');
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALID_OPERATORS: ReadonlySet<LeaderboardOperator> = new Set([
  'best',
  'set',
  'incr',
  'decr',
]);
const VALID_SORT: ReadonlySet<LeaderboardSortOrder> = new Set(['asc', 'desc']);
const ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

function validate(c: unknown): asserts c is RawTablesFile {
  const fail = (msg: string): never => {
    throw new Error(`leaderboards catalog invalid: ${msg}`);
  };
  if (!isPlainObject(c)) fail('not an object');
  const obj = c as Record<string, unknown>;
  if (obj['version'] !== 1) fail(`version must be 1, got ${String(obj['version'])}`);

  const tables = obj['tables'];
  if (!Array.isArray(tables)) fail('tables must be an array');
  for (const t of tables as unknown[]) {
    if (!isPlainObject(t)) fail('each table must be an object');
    const tr = t as Record<string, unknown>;
    if (typeof tr['id'] !== 'string' || !ID_PATTERN.test(tr['id'])) {
      fail(`table id must match ${ID_PATTERN.source}, got ${String(tr['id'])}`);
    }
    if (!VALID_OPERATORS.has(tr['operator'] as LeaderboardOperator)) {
      fail(`table ${String(tr['id'])}: operator invalid`);
    }
    if (!VALID_SORT.has(tr['sortOrder'] as LeaderboardSortOrder)) {
      fail(`table ${String(tr['id'])}: sortOrder invalid`);
    }
    if (typeof tr['resetSchedule'] !== 'string') {
      fail(`table ${String(tr['id'])}: resetSchedule must be a string`);
    }
    if (typeof tr['description'] !== 'string') {
      fail(`table ${String(tr['id'])}: description must be a string`);
    }
  }

  const ts = obj['trackScoped'];
  if (!isPlainObject(ts)) fail('trackScoped must be an object');
  const tsObj = ts as Record<string, unknown>;
  if (!Array.isArray(tsObj['tracks']) || (tsObj['tracks'] as unknown[]).length === 0) {
    fail('trackScoped.tracks must be a non-empty array');
  }
  if (!Array.isArray(tsObj['classes']) || (tsObj['classes'] as unknown[]).length === 0) {
    fail('trackScoped.classes must be a non-empty array');
  }
  const patterns = tsObj['patterns'];
  if (!isPlainObject(patterns)) fail('trackScoped.patterns must be an object');
  for (const [name, p] of Object.entries(patterns as Record<string, unknown>)) {
    validatePattern(name, p, fail);
  }

  const seasonScoped = obj['seasonScoped'];
  if (!isPlainObject(seasonScoped)) fail('seasonScoped must be an object');
  for (const [name, p] of Object.entries(seasonScoped as Record<string, unknown>)) {
    validatePattern(name, p, fail);
    const template = (p as Record<string, unknown>)['template'] as string;
    if (template.split('{season}').length !== 2) {
      fail(`seasonScoped "${name}" template must contain {season} once`);
    }
  }
  if (!isPlainObject((seasonScoped as Record<string, unknown>)[RANKED_TABLE_SOURCE])) {
    fail(`seasonScoped.${RANKED_TABLE_SOURCE} is required (the ranked rating table)`);
  }

  if (!Array.isArray(obj['deprecated'])) fail('deprecated must be an array');
}

function validatePattern(name: string, p: unknown, fail: (msg: string) => never): void {
  if (!isPlainObject(p)) fail(`pattern "${name}" must be an object`);
  const pp = p as Record<string, unknown>;
  if (typeof pp['template'] !== 'string') fail(`pattern "${name}" template must be a string`);
  if (!VALID_OPERATORS.has(pp['operator'] as LeaderboardOperator)) {
    fail(`pattern "${name}": operator invalid`);
  }
  if (!VALID_SORT.has(pp['sortOrder'] as LeaderboardSortOrder)) {
    fail(`pattern "${name}": sortOrder invalid`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}