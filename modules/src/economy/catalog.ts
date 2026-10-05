// Phase 3 economy catalog: per-mode reward tables + bonuses + private
// cap + XP rule. Loaded at InitModule, cross-worker persisted via
// localcache the same way tracks/modes/leaderboards are.

import type { ILogger, INakama } from '../nkruntime';
import type { RaceModeId } from '../race/types';

export type RewardBonusType = 'coins' | 'gems';

export interface RewardBonus {
  type: RewardBonusType;
  amount: number;
}

export interface RewardsCatalog {
  version: number;
  /**
   * `positionBase[size][rank-1]` = coins awarded for finishing at that
   * rank in a session of that size. Sizes covered: 2, 4, 6.
   */
  positionBase: Readonly<Record<string, ReadonlyArray<number>>>;
  /** Multiplier applied per mode (quick ×1.0, ranked ×1.25, etc.). */
  modeMultiplier: Readonly<Record<RaceModeId, number>>;
  /** Conditional bonus grants. */
  bonuses: {
    readonly firstWinOfDay: Readonly<RewardBonus>;
    readonly noAbandon: Readonly<RewardBonus>;
  };
  /** Maximum rewarded private races per UTC day. */
  privateRoomCapPerDay: number;
  /** Minimum XP granted per race. */
  xpFloor: number;
  /** XP = max(coins / xpDivisor, xpFloor). */
  xpDivisor: number;
}

export interface RawRewardsFile {
  version: number;
  positionBase: Record<string, number[]>;
  modeMultiplier: Record<RaceModeId, number>;
  bonuses: { firstWinOfDay: RewardBonus; noAbandon: RewardBonus };
  privateRoomCapPerDay: number;
  xpFloor: number;
  xpDivisor: number;
}

export const REWARDS_CATALOG_CACHE_KEY = 'rewards:catalog:v1';

let moduleCatalog: RewardsCatalog | null = null;

export function getRewardsCatalog(): RewardsCatalog {
  if (moduleCatalog === null) {
    throw new Error('rewards catalog not loaded; call loadRewardsCatalog() first');
  }
  return moduleCatalog;
}

export function loadRewardsCatalog(
  logger: ILogger,
  raw: RawRewardsFile,
  nk?: INakama,
): void {
  validate(raw);
  moduleCatalog = Object.freeze({
    version: raw.version,
    positionBase: Object.freeze(raw.positionBase),
    modeMultiplier: Object.freeze(raw.modeMultiplier),
    bonuses: Object.freeze({
      firstWinOfDay: Object.freeze({ ...raw.bonuses.firstWinOfDay }),
      noAbandon: Object.freeze({ ...raw.bonuses.noAbandon }),
    }),
    privateRoomCapPerDay: raw.privateRoomCapPerDay,
    xpFloor: raw.xpFloor,
    xpDivisor: raw.xpDivisor,
  });
  if (nk) {
    nk.localcachePut(REWARDS_CATALOG_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info(
    'rewards catalog loaded: sizes=%s privateCap=%d xpFloor=%d xpDivisor=%d',
    Object.keys(raw.positionBase).join(','),
    raw.privateRoomCapPerDay,
    raw.xpFloor,
    raw.xpDivisor,
  );
}

export function _resetRewardsForTests(): void {
  moduleCatalog = null;
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALID_MODES: ReadonlySet<RaceModeId> = new Set([
  'quick',
  'ranked',
  'private',
  'time_trial',
]);
const VALID_BONUS_TYPES: ReadonlySet<RewardBonusType> = new Set(['coins', 'gems']);
const VALID_SIZES = new Set(['2', '4', '6']);

export function validate(raw: unknown): asserts raw is RawRewardsFile {
  const fail = (msg: string): never => {
    throw new Error(`rewards catalog invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const pb = r['positionBase'];
  if (!isPlainObject(pb)) fail('positionBase must be an object');
  for (const [size, arr] of Object.entries(pb as Record<string, unknown>)) {
    if (!VALID_SIZES.has(size)) fail(`positionBase contains invalid size "${size}"`);
    if (!Array.isArray(arr)) fail(`positionBase.${size} must be an array`);
    const a = arr as unknown[];
    if (a.length === 0) fail(`positionBase.${size} must be a non-empty array`);
    if (a.length > 6) fail(`positionBase.${size} must have ≤ 6 entries`);
    for (const n of a) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        fail(`positionBase.${size} entries must be non-negative integers, got ${String(n)}`);
      }
    }
  }

  const mm = r['modeMultiplier'];
  if (!isPlainObject(mm)) fail('modeMultiplier must be an object');
  for (const [mode, mult] of Object.entries(mm as Record<string, unknown>)) {
    if (!VALID_MODES.has(mode as RaceModeId)) {
      fail(`modeMultiplier contains invalid mode "${mode}"`);
    }
    if (typeof mult !== 'number' || mult < 0) {
      fail(`modeMultiplier.${mode} must be ≥ 0, got ${String(mult)}`);
    }
  }

  const bonuses = r['bonuses'];
  if (!isPlainObject(bonuses)) fail('bonuses must be an object');
  for (const key of ['firstWinOfDay', 'noAbandon'] as const) {
    const b = (bonuses as Record<string, unknown>)[key];
    if (!isPlainObject(b)) fail(`bonuses.${key} must be an object`);
    const bb = b as Record<string, unknown>;
    if (!VALID_BONUS_TYPES.has(bb['type'] as RewardBonusType)) {
      fail(`bonuses.${key}.type must be one of coins|gems`);
    }
    if (typeof bb['amount'] !== 'number' || !Number.isInteger(bb['amount']) || (bb['amount'] as number) < 0) {
      fail(`bonuses.${key}.amount must be a non-negative integer`);
    }
  }

  const cap = r['privateRoomCapPerDay'];
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) {
    fail(`privateRoomCapPerDay must be a non-negative integer, got ${String(cap)}`);
  }
  const floor = r['xpFloor'];
  if (typeof floor !== 'number' || floor < 0) {
    fail(`xpFloor must be ≥ 0, got ${String(floor)}`);
  }
  const div = r['xpDivisor'];
  if (typeof div !== 'number' || div <= 0) {
    fail(`xpDivisor must be > 0, got ${String(div)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── Helpers shared by Chunk 5 ────────────────────────────────────────────────

/**
 * Map a roster size to its positionBase key. Sizes outside the catalog
 * fall through to the closest supported one (currently `4`).
 */
export function sizeKeyFor(size: number): '2' | '4' | '6' {
  if (size === 2) return '2';
  if (size === 6) return '6';
  return '4';
}