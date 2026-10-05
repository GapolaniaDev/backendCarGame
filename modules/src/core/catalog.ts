// Catalog loader. Loads versioned JSON game-data catalogs (tracks, modes,
// …) at startup and freezes them so all subsequent reads are safe to
// share across RPC handlers.
//
// Validation runs at load — a malformed catalog throws, which Nakama
// propagates out of `InitModule` causing the container to exit non-zero.
// This matches the Phase 1 spec's "un catálogo inválido impide el
// arranque".

import type { ILogger } from '../nkruntime';
import { err, ok, type Resp } from './response';
import type { ErrorCode } from './errors';

// ─── Tracks catalog ──────────────────────────────────────────────────────────

export interface TrackEntry {
  id: string;
  displayName: string;
  /** Number of laps per mode. */
  modes: {
    quick: number;
    ranked: number;
    private: number;
    time_trial: number;
  };
  /** Number of checkpoints per lap. */
  checkpoints: number;
  /** Minimum plausible per-lap time in milliseconds, by car class. */
  minTimeMsByClass: {
    D: number;
    C: number;
    B: number;
    A: number;
    S: number;
  };
}

export interface TracksCatalog {
  version: number;
  tracks: TrackEntry[];
}

// ─── Modes catalog ───────────────────────────────────────────────────────────

export type ModeId = 'quick' | 'ranked' | 'private' | 'time_trial';

export interface ModeEntry {
  id: ModeId;
  displayName: string;
  /** Allowed session sizes for this mode. */
  allowedSizes: Array<2 | 4 | 6 | 1>;
  /** Multiplier applied to score / reward formulas. */
  scoreMultiplier: number;
  /** Whether the mode participates in rating (ranked). */
  usesRating: boolean;
}

export interface ModesCatalog {
  version: number;
  modes: ModeEntry[];
}

// ─── Loader state ────────────────────────────────────────────────────────────

interface CatalogState {
  tracks: ReadonlyArray<Readonly<TrackEntry>>;
  modes: ReadonlyArray<Readonly<ModeEntry>>;
  tracksById: ReadonlyMap<string, Readonly<TrackEntry>>;
  modesById: ReadonlyMap<ModeId, Readonly<ModeEntry>>;
  /** SHA-256 hash of the JSON source of both catalogs (client cache key). */
  hash: string;
}

let state: CatalogState | null = null;

export function getTracks(): ReadonlyArray<Readonly<TrackEntry>> {
  if (!state) throw new Error('catalogs not loaded; call loadCatalogs() first');
  return state.tracks;
}
export function getTrack(id: string): Readonly<TrackEntry> | undefined {
  if (!state) throw new Error('catalogs not loaded');
  return state.tracksById.get(id);
}
export function getModes(): ReadonlyArray<Readonly<ModeEntry>> {
  if (!state) throw new Error('catalogs not loaded');
  return state.modes;
}
export function getMode(id: ModeId): Readonly<ModeEntry> | undefined {
  if (!state) throw new Error('catalogs not loaded');
  return state.modesById.get(id);
}
export function getCatalogsHash(): string {
  if (!state) throw new Error('catalogs not loaded');
  return state.hash;
}

// ─── Load entrypoint ─────────────────────────────────────────────────────────

export interface CatalogSources {
  tracks: TracksCatalog;
  modes: ModesCatalog;
}

export function loadCatalogs(
  logger: ILogger,
  sources: CatalogSources,
  hashFn: (input: string) => string,
): void {
  validateTracks(sources.tracks);
  validateModes(sources.modes);

  const hash = hashFn(JSON.stringify(sources));

  const tracksById = new Map<string, Readonly<TrackEntry>>();
  for (const t of sources.tracks.tracks) {
    tracksById.set(t.id, Object.freeze({ ...t }));
  }
  const modesById = new Map<ModeId, Readonly<ModeEntry>>();
  for (const m of sources.modes.modes) {
    modesById.set(m.id, Object.freeze({ ...m }));
  }

  state = {
    tracks: Object.freeze(sources.tracks.tracks.map((t) => Object.freeze({ ...t }))),
    modes: Object.freeze(sources.modes.modes.map((m) => Object.freeze({ ...m }))),
    tracksById,
    modesById,
    hash,
  };

  logger.info(
    'catalogs loaded: tracks=%d modes=%d hash=%s',
    sources.tracks.tracks.length,
    sources.modes.modes.length,
    state.hash.slice(0, 12),
  );
}

/** Test-only: reset the in-memory catalog state between tests. */
export function _resetCatalogsForTests(): void {
  state = null;
}

// ─── Validators ──────────────────────────────────────────────────────────────

const VALID_MODE_IDS: ReadonlySet<ModeId> = new Set([
  'quick',
  'ranked',
  'private',
  'time_trial',
]);
const VALID_CLASS_IDS = ['D', 'C', 'B', 'A', 'S'] as const;
type ClassId = (typeof VALID_CLASS_IDS)[number];
const VALID_SIZES = new Set([1, 2, 4, 6]);

export function validateTracks(c: unknown): asserts c is TracksCatalog {
  const fail = (msg: string): never => {
    throw new Error(`catalogs.tracks invalid: ${msg}`);
  };
  if (!isPlainObject(c)) fail('not an object');
  const catalog = c as Record<string, unknown>;
  if (catalog['version'] !== 1) fail(`version must be 1, got ${String(catalog['version'])}`);
  const tracksRaw = catalog['tracks'] as unknown[];
  if (tracksRaw.length === 0) fail('tracks must be a non-empty array');

  const seen = new Set<string>();
  tracksRaw.forEach((rawT: unknown, idx: number) => {
    if (!isPlainObject(rawT)) fail(`tracks[${idx}] must be an object`);
    const t = rawT as Record<string, unknown>;
    const id = t['id'] as string;
    if (typeof id !== 'string' || id.length === 0) fail(`tracks[${idx}].id must be a non-empty string`);
    if (seen.has(id)) fail(`duplicate track id: ${id}`);
    seen.add(id);
    if (typeof t['displayName'] !== 'string') fail(`tracks[${idx}].displayName must be a string`);
    const modes = t['modes'] as Record<string, unknown>;
    if (!isPlainObject(modes)) fail(`tracks[${idx}].modes must be an object`);
    for (const mid of VALID_MODE_IDS) {
      const v = modes[mid];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 99) {
        fail(`tracks[${idx}].modes.${mid} must be an integer 1..99, got ${String(v)}`);
      }
    }
    const cps = t['checkpoints'];
    if (typeof cps !== 'number' || !Number.isInteger(cps) || cps < 1) {
      fail(`tracks[${idx}].checkpoints must be a positive integer, got ${String(cps)}`);
    }
    const mt = t['minTimeMsByClass'] as Record<string, unknown>;
    if (!isPlainObject(mt)) fail(`tracks[${idx}].minTimeMsByClass must be an object`);
    for (const cls of VALID_CLASS_IDS) {
      const v = mt[cls as ClassId];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1000) {
        fail(`tracks[${idx}].minTimeMsByClass.${cls} must be ≥ 1000ms, got ${String(v)}`);
      }
    }
  });
}

export function validateModes(c: unknown): asserts c is ModesCatalog {
  const fail = (msg: string): never => {
    throw new Error(`catalogs.modes invalid: ${msg}`);
  };
  if (!isPlainObject(c)) fail('not an object');
  const catalog = c as Record<string, unknown>;
  if (catalog['version'] !== 1) fail(`version must be 1, got ${String(catalog['version'])}`);
  const modesRaw = catalog['modes'] as unknown[];
  if (modesRaw.length === 0) fail('modes must be a non-empty array');

  const seen = new Set<ModeId>();
  modesRaw.forEach((rawM: unknown, idx: number) => {
    if (!isPlainObject(rawM)) fail(`modes[${idx}] must be an object`);
    const m = rawM as Record<string, unknown>;
    const id = m['id'] as string;
    if (typeof id !== 'string' || !VALID_MODE_IDS.has(id as ModeId)) {
      fail(`modes[${idx}].id must be one of ${Array.from(VALID_MODE_IDS).join('|')}`);
    }
    if (seen.has(id as ModeId)) fail(`duplicate mode id: ${id}`);
    seen.add(id as ModeId);
    if (typeof m['displayName'] !== 'string') fail(`modes[${idx}].displayName must be a string`);
    const sizesRaw = m['allowedSizes'] as unknown[];
    if (sizesRaw.length === 0) fail(`modes[${idx}].allowedSizes must be a non-empty array`);
    for (const s of sizesRaw) {
      if (typeof s !== 'number' || !VALID_SIZES.has(s)) {
        fail(`modes[${idx}].allowedSizes contains invalid size ${String(s)}`);
      }
    }
    const mult = m['scoreMultiplier'];
    if (typeof mult !== 'number' || mult < 0) {
      fail(`modes[${idx}].scoreMultiplier must be ≥ 0, got ${String(mult)}`);
    }
    if (typeof m['usesRating'] !== 'boolean') {
      fail(`modes[${idx}].usesRating must be a boolean`);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Wrap a thrown catalog error into a `{ok:false}` response with CATALOG_INVALID. */
export function catalogErrorResponse(e: unknown): Resp<never> {
  const msg = e instanceof Error ? e.message : String(e);
  return err('CATALOG_INVALID' as ErrorCode, msg);
}

/** Export an `ok` helper for callers that want a typed `Resp<never>` on success. */
export const catalogOk = ok;