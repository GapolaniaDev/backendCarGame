// Phase 4 ranked config. Per-mode rating parameters, division bands,
// K-factor windows, abandon thresholds, and grace window. Loaded at
// `InitModule` from `modules/src/catalogs/ranked_config.json`.
//
// Chunk 1 of the Phase 4 plan ships the catalog + types + loaders
// only — no RPCs yet. The decision context (D9 rating window,
// hiddenMarkThreshold for the close-time quorum rule, graceSeconds for
// the host-claim grace window) is locked in here so Chunks 2-10 can
// reference it without re-reading the JSON.

import type { ILogger, INakama } from '../nkruntime';

export interface RankedDivision {
  id: string;
  displayName: string;
  minRating: number;
  maxRating: number;
}

export interface RatingWindow {
  /** Upper bound (inclusive) of the elapsed-since-finished window, in seconds. */
  elapsedMax: number;
  /** Maximum |rating delta| allowed within this window. */
  window: number;
}

export interface RankedConfig {
  version: number;
  /** K-factor used after the player's first 10 ranked races. */
  kFactorNormal: number;
  /** K-factor used during the player's first 10 ranked races. */
  kFactorInitial: number;
  /** Rating assigned to a new account on its first ranked race. */
  initialRating: number;
  divisions: ReadonlyArray<RankedDivision>;
  /** Time-decay rating window — small windows early, wide later. */
  ratingWindowBySeconds: ReadonlyArray<RatingWindow>;
  /**
   * Number of consecutive abandons (over 24h) that trigger a 15-minute
   * matchmaking block. D6 in the Phase 4 plan.
   */
  hiddenMarkThreshold: number;
  /** Host-claim grace window (D5): a disconnected host has this many
   *  seconds to rejoin before the room is rehosted or closed. */
  graceSeconds: number;
}

export interface RawRankedConfigFile {
  version: number;
  kFactorNormal: number;
  kFactorInitial: number;
  initialRating: number;
  divisions: ReadonlyArray<{
    id: string;
    displayName: string;
    minRating: number;
    maxRating: number;
  }>;
  ratingWindowBySeconds: ReadonlyArray<{
    elapsedMax: number;
    window: number;
  }>;
  hiddenMarkThreshold: number;
  graceSeconds: number;
}

export const RANKED_CONFIG_CACHE_KEY = 'ranked:config:v1';

let moduleConfig: RankedConfig | null = null;

export function getRankedConfig(): RankedConfig {
  if (moduleConfig === null) {
    throw new Error('ranked config not loaded; call loadRankedConfig() first');
  }
  return moduleConfig;
}

export function loadRankedConfig(
  logger: ILogger,
  raw: RawRankedConfigFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleConfig = Object.freeze({
    version: raw.version,
    kFactorNormal: raw.kFactorNormal,
    kFactorInitial: raw.kFactorInitial,
    initialRating: raw.initialRating,
    divisions: Object.freeze(raw.divisions.map((d) => Object.freeze({ ...d }))),
    ratingWindowBySeconds: Object.freeze(
      raw.ratingWindowBySeconds.map((w) => Object.freeze({ ...w })),
    ),
    hiddenMarkThreshold: raw.hiddenMarkThreshold,
    graceSeconds: raw.graceSeconds,
  });
  if (nk) {
    nk.localcachePut(RANKED_CONFIG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'ranked config loaded: kNormal=%d kInitial=%d initialRating=%d divisions=%d windows=%d grace=%ds',
    raw.kFactorNormal,
    raw.kFactorInitial,
    raw.initialRating,
    raw.divisions.length,
    raw.ratingWindowBySeconds.length,
    raw.graceSeconds,
  );
}

export function _resetRankedConfigForTests(): void {
  moduleConfig = null;
}

/**
 * Map a rating to its division id (e.g. 1240 → 'oro'). Returns the
 * lowest band's id when the rating is below the lowest band, and the
 * highest band's id when it exceeds the highest band.
 */
export function divisionForRating(config: RankedConfig, rating: number): string {
  if (config.divisions.length === 0) return 'unknown';
  for (const d of config.divisions) {
    if (rating >= d.minRating && rating <= d.maxRating) return d.id;
  }
  if (rating < (config.divisions[0]?.minRating ?? 0)) {
    return config.divisions[0]!.id;
  }
  return config.divisions[config.divisions.length - 1]!.id;
}

/**
 * Pick the rating window for a given elapsed-since-finished seconds
 * value. Largest `elapsedMax` less than or equal to `elapsedSec`
 * wins; falls back to the last entry (open-ended).
 */
export function ratingWindowFor(config: RankedConfig, elapsedSec: number): number {
  const ws = config.ratingWindowBySeconds;
  if (ws.length === 0) return 0;
  let picked = ws[0]?.window ?? 0;
  for (const w of ws) {
    if (elapsedSec <= w.elapsedMax) {
      return w.window;
    }
    picked = w.window;
  }
  return picked;
}

export function validate(raw: unknown): asserts raw is RawRankedConfigFile {
  const fail = (msg: string): never => {
    throw new Error(`ranked config invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const intField = (key: string, opts: { min?: number; max?: number } = {}): number => {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      fail(`${key} must be an integer, got ${String(v)}`);
    }
    const n = v as number;
    if (opts.min !== undefined && n < opts.min) fail(`${key} must be ≥ ${opts.min}, got ${n}`);
    if (opts.max !== undefined && n > opts.max) fail(`${key} must be ≤ ${opts.max}, got ${n}`);
    return n;
  };
  intField('kFactorNormal', { min: 1, max: 256 });
  intField('kFactorInitial', { min: 1, max: 256 });
  intField('initialRating', { min: 0 });
  intField('hiddenMarkThreshold', { min: 1 });
  intField('graceSeconds', { min: 1, max: 300 });

  const divisions = r['divisions'];
  if (!Array.isArray(divisions) || (divisions as unknown[]).length === 0) {
    fail('divisions must be a non-empty array');
  }
  const divIds = new Set<string>();
  let prevMax = -1;
  for (let i = 0; i < (divisions as unknown[]).length; i += 1) {
    const d = (divisions as unknown[])[i];
    if (!isPlainObject(d)) fail(`divisions[${i}] must be an object`);
    const dd = d as Record<string, unknown>;
    if (typeof dd['id'] !== 'string' || (dd['id'] as string).length === 0) {
      fail(`divisions[${i}].id must be a non-empty string`);
    }
    if (divIds.has(dd['id'] as string)) {
      fail(`divisions[${i}].id duplicates an earlier entry`);
    }
    divIds.add(dd['id'] as string);
    if (typeof dd['minRating'] !== 'number' || !Number.isInteger(dd['minRating'] as number) || (dd['minRating'] as number) < 0) {
      fail(`divisions[${i}].minRating must be a non-negative integer`);
    }
    if (typeof dd['maxRating'] !== 'number' || !Number.isInteger(dd['maxRating'] as number) || (dd['maxRating'] as number) < 0) {
      fail(`divisions[${i}].maxRating must be a non-negative integer`);
    }
    if ((dd['maxRating'] as number) <= (dd['minRating'] as number)) {
      fail(`divisions[${i}].maxRating must be > minRating`);
    }
    if ((dd['minRating'] as number) <= prevMax) {
      fail(`divisions[${i}] must start at or after the previous max (${prevMax})`);
    }
    prevMax = (dd['maxRating'] as number);
  }

  const windows = r['ratingWindowBySeconds'];
  if (!Array.isArray(windows) || (windows as unknown[]).length === 0) {
    fail('ratingWindowBySeconds must be a non-empty array');
  }
  let prevElapsed = 0;
  for (let i = 0; i < (windows as unknown[]).length; i += 1) {
    const w = (windows as unknown[])[i];
    if (!isPlainObject(w)) fail(`ratingWindowBySeconds[${i}] must be an object`);
    const ww = w as Record<string, unknown>;
    if (typeof ww['elapsedMax'] !== 'number' || !Number.isInteger(ww['elapsedMax'] as number) || (ww['elapsedMax'] as number) <= 0) {
      fail(`ratingWindowBySeconds[${i}].elapsedMax must be a positive integer`);
    }
    if ((ww['elapsedMax'] as number) < prevElapsed) {
      fail(`ratingWindowBySeconds[${i}].elapsedMax must be ≥ ${prevElapsed}`);
    }
    prevElapsed = (ww['elapsedMax'] as number);
    if (typeof ww['window'] !== 'number' || !Number.isInteger(ww['window'] as number) || (ww['window'] as number) <= 0) {
      fail(`ratingWindowBySeconds[${i}].window must be a positive integer`);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}