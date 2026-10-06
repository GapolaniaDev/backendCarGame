// Phase 4 liveops config (D8, D6). The runtime loads
// `modules/src/catalogs/liveops_config.json` at `InitModule` and
// freezes the parsed shape into `liveopsConfig`. Other modules reach
// for `getLiveOpsConfig()` to read the live override of any
// matchmaking or anti-abuse threshold.
//
// Storage layout:
//   collection: `liveops_config`
//   key:        `current`
//   owner:      SYSTEM_USER_ID (server-only read + write)
//
// The bundled JSON ships the defaults; an admin tool can publish an
// override at runtime and the helper prefers the storage value when
// present. The cache key is stable so the loader can re-validate
// without re-reading every call.

import type { ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';

export type SegmentBy = 'none' | 'input' | 'platform';

export interface LiveOpsRatingWindow {
  elapsedMax: number;
  window: number;
}

export interface LiveOpsConfig {
  version: number;
  mm: {
    segmentBy: SegmentBy;
    ratingWindowBySeconds: ReadonlyArray<LiveOpsRatingWindow>;
  };
  matchmaking: {
    /** Number of abandons in 24h that triggers the block. */
    abandonBlockThreshold: number;
    /** Block duration in minutes. */
    abandonBlockMinutes: number;
    /** Host-claim grace window — duplicate of ranked_config.graceSeconds so liveops can override it. */
    graceSeconds: number;
  };
}

export interface RawLiveOpsFile {
  version: number;
  mm: {
    segmentBy: SegmentBy;
    ratingWindowBySeconds: ReadonlyArray<{ elapsedMax: number; window: number }>;
  };
  matchmaking: {
    abandonBlockThreshold: number;
    abandonBlockMinutes: number;
    graceSeconds: number;
  };
}

export const LIVEOPS_CONFIG_CACHE_KEY = 'liveops:config:v1';
export const LIVEOPS_CONFIG_COLLECTION = 'liveops_config';
export const LIVEOPS_CONFIG_KEY = 'current';

let moduleConfig: LiveOpsConfig | null = null;

export function getLiveOpsConfig(): LiveOpsConfig {
  if (moduleConfig === null) {
    throw new Error('liveops config not loaded; call loadLiveOpsConfig() first');
  }
  return moduleConfig;
}

/**
 * Idempotent loader. Validates the bundled JSON, freezes it, caches it,
 * and (if storage already holds an override) prefers the storage copy.
 *
 * Returns the resolved config so the boot log can dump it once.
 */
export function loadLiveOpsConfig(
  logger: ILogger,
  raw: RawLiveOpsFile,
  nk?: INakama,
): LiveOpsConfig {
  validate(raw);
  const bundled = Object.freeze({
    version: raw.version,
    mm: Object.freeze({
      segmentBy: raw.mm.segmentBy,
      ratingWindowBySeconds: Object.freeze(
        raw.mm.ratingWindowBySeconds.map((w) => Object.freeze({ ...w })),
      ),
    }),
    matchmaking: Object.freeze({
      abandonBlockThreshold: raw.matchmaking.abandonBlockThreshold,
      abandonBlockMinutes: raw.matchmaking.abandonBlockMinutes,
      graceSeconds: raw.matchmaking.graceSeconds,
    }),
  });

  let resolved: LiveOpsConfig = bundled;
  if (nk) {
    const reads = nk.storageRead([
      {
        collection: LIVEOPS_CONFIG_COLLECTION,
        key: LIVEOPS_CONFIG_KEY,
        userId: SYSTEM_USER_ID,
      },
    ]);
    const obj = reads[0];
    if (obj !== undefined && obj.value !== undefined) {
      try {
        const stored = obj.value as RawLiveOpsFile;
        validate(stored);
        resolved = Object.freeze({
          version: stored.version,
          mm: Object.freeze({
            segmentBy: stored.mm.segmentBy,
            ratingWindowBySeconds: Object.freeze(
              stored.mm.ratingWindowBySeconds.map((w) => Object.freeze({ ...w })),
            ),
          }),
          matchmaking: Object.freeze({
            abandonBlockThreshold: stored.matchmaking.abandonBlockThreshold,
            abandonBlockMinutes: stored.matchmaking.abandonBlockMinutes,
            graceSeconds: stored.matchmaking.graceSeconds,
          }),
        });
        logger.info(
          'liveops config overridden from storage: mm.segmentBy=%s threshold=%d',
          resolved.mm.segmentBy,
          resolved.matchmaking.abandonBlockThreshold,
        );
      } catch (e) {
        logger.error(
          'liveops config in storage failed validation — using bundled copy: %s',
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    nk.localcachePut(LIVEOPS_CONFIG_CACHE_KEY, JSON.stringify(resolved), 7 * 24 * 60 * 60);
  }

  moduleConfig = resolved;
  logger.info(
    'liveops config loaded: mm.segmentBy=%s threshold=%d blockMinutes=%d',
    resolved.mm.segmentBy,
    resolved.matchmaking.abandonBlockThreshold,
    resolved.matchmaking.abandonBlockMinutes,
  );
  return resolved;
}

export function _resetLiveOpsConfigForTests(): void {
  moduleConfig = null;
}

export function validate(raw: unknown): asserts raw is RawLiveOpsFile {
  const fail = (msg: string): never => {
    throw new Error(`liveops config invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const mmRaw = r['mm'];
  if (!isPlainObject(mmRaw)) fail('mm must be an object');
  const mm: Record<string, unknown> = mmRaw as Record<string, unknown>;
  const segmentBy = mm['segmentBy'];
  if (segmentBy !== 'none' && segmentBy !== 'input' && segmentBy !== 'platform') {
    fail(`mm.segmentBy must be 'none'|'input'|'platform', got ${String(segmentBy)}`);
  }

  const windows = mm['ratingWindowBySeconds'];
  if (!Array.isArray(windows) || (windows as unknown[]).length === 0) {
    fail('mm.ratingWindowBySeconds must be a non-empty array');
  }
  let prevElapsed = 0;
  for (let i = 0; i < (windows as unknown[]).length; i += 1) {
    const w = (windows as unknown[])[i];
    if (!isPlainObject(w)) fail(`mm.ratingWindowBySeconds[${i}] must be an object`);
    const ww = w as Record<string, unknown>;
    const elapsed = ww['elapsedMax'];
    if (typeof elapsed !== 'number' || !Number.isInteger(elapsed as number) || (elapsed as number) <= 0) {
      fail(`mm.ratingWindowBySeconds[${i}].elapsedMax must be a positive integer`);
    }
    if ((elapsed as number) < prevElapsed) {
      fail(`mm.ratingWindowBySeconds[${i}].elapsedMax must be ≥ ${prevElapsed}`);
    }
    prevElapsed = elapsed as number;
    const win = ww['window'];
    if (typeof win !== 'number' || !Number.isInteger(win as number) || (win as number) <= 0) {
      fail(`mm.ratingWindowBySeconds[${i}].window must be a positive integer`);
    }
  }

  const mkRaw = r['matchmaking'];
  if (!isPlainObject(mkRaw)) fail('matchmaking must be an object');
  const mk: Record<string, unknown> = mkRaw as Record<string, unknown>;
  const threshold = mk['abandonBlockThreshold'];
  if (typeof threshold !== 'number' || !Number.isInteger(threshold as number) || (threshold as number) < 1) {
    fail(`matchmaking.abandonBlockThreshold must be a positive integer, got ${String(threshold)}`);
  }
  const blockMinutes = mk['abandonBlockMinutes'];
  if (typeof blockMinutes !== 'number' || !Number.isInteger(blockMinutes as number) || (blockMinutes as number) < 1) {
    fail(`matchmaking.abandonBlockMinutes must be a positive integer, got ${String(blockMinutes)}`);
  }
  const grace = mk['graceSeconds'];
  if (typeof grace !== 'number' || !Number.isInteger(grace as number) || (grace as number) < 1 || (grace as number) > 300) {
    fail(`matchmaking.graceSeconds must be in [1,300], got ${String(grace)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}