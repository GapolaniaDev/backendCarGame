// Phase 6 — missions + achievements catalog loaders.
//
// Loads the three JSON catalogs at InitModule, validates each row,
// and freezes the result for safe cross-worker reuse.
//
// The loader pattern matches Phase 3 / Phase 4: the file is bundled
// into `modules/index.js` via esbuild's JSON import; validation
// runs synchronously at boot; failure throws (boot crashes — better
// than silent bad config).

import type { ILogger, INakama } from '../nkruntime';
import type {
  AchievementDefinition,
  DailyMissions,
  MissionDefinition,
  MissionFilter,
  MissionKind,
  MissionReward,
  WeeklyMissions,
} from './types';

export type MissedMissionsCatalog =
  | MissionDefinition
  | AchievementDefinition;

export interface RawMissionsFile {
  version: number;
  missions: MissionDefinition[];
}

export interface RawAchievementsFile {
  version: number;
  achievements: AchievementDefinition[];
}

const MISSIONS_DAILY_CACHE_KEY = 'missions:catalog:daily:v1';
const MISSIONS_WEEKLY_CACHE_KEY = 'missions:catalog:weekly:v1';
const ACHIEVEMENTS_CACHE_KEY = 'missions:catalog:achievements:v1';

const VALID_KINDS: ReadonlySet<MissionKind> = new Set([
  'race_count', 'race_position', 'race_track',
  'race_class', 'wins_quick', 'wins_ranked', 'race_no_abandon',
]);
const VALID_MODES = new Set(['quick', 'ranked', 'private', 'time_trial']);
const VALID_CLASSES = new Set(['D', 'C', 'B', 'A', 'S']);
const VALID_SIZES = new Set([2, 4, 6]);

let dailyModule: ReadonlyArray<MissionDefinition> | null = null;
let weeklyModule: ReadonlyArray<MissionDefinition> | null = null;
let achievementsModule: ReadonlyArray<AchievementDefinition> | null = null;

export function getMissionsDailyCatalog(): ReadonlyArray<MissionDefinition> {
  if (dailyModule === null) {
    throw new Error('daily missions catalog not loaded; call loadMissionsDailyCatalog() first');
  }
  return dailyModule;
}

export function getMissionsWeeklyCatalog(): ReadonlyArray<MissionDefinition> {
  if (weeklyModule === null) {
    throw new Error('weekly missions catalog not loaded; call loadMissionsWeeklyCatalog() first');
  }
  return weeklyModule;
}

export function getAchievementsCatalog(): ReadonlyArray<AchievementDefinition> {
  if (achievementsModule === null) {
    throw new Error('achievements catalog not loaded; call loadAchievementsCatalog() first');
  }
  return achievementsModule;
}

export function loadMissionsDailyCatalog(
  logger: ILogger,
  raw: RawMissionsFile,
  nk?: INakama,
): void {
  validate(raw, 'missions');
  dailyModule = Object.freeze(raw.missions.map(freezeMission));
  if (nk) {
    nk.localcachePut(MISSIONS_DAILY_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info('missions_daily catalog loaded: %d missions', dailyModule.length);
}

export function loadMissionsWeeklyCatalog(
  logger: ILogger,
  raw: RawMissionsFile,
  nk?: INakama,
): void {
  validate(raw, 'missions');
  weeklyModule = Object.freeze(raw.missions.map(freezeMission));
  if (nk) {
    nk.localcachePut(MISSIONS_WEEKLY_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info('missions_weekly catalog loaded: %d missions', weeklyModule.length);
}

export function loadAchievementsCatalog(
  logger: ILogger,
  raw: RawAchievementsFile,
  nk?: INakama,
): void {
  validate(raw, 'achievements');
  achievementsModule = Object.freeze(raw.achievements.map(freezeAchievement));
  if (nk) {
    nk.localcachePut(ACHIEVEMENTS_CACHE_KEY, JSON.stringify(raw), 7 * 24 * 60 * 60);
  }
  logger.info('achievements catalog loaded: %d achievements', achievementsModule.length);
}

export function _resetMissionsCatalogsForTests(): void {
  dailyModule = null;
  weeklyModule = null;
  achievementsModule = null;
}

// ─── Validators ───────────────────────────────────────────────────────────────

function validate(
  raw: unknown,
  kind: 'missions' | 'achievements',
): asserts raw is RawMissionsFile | RawAchievementsFile {
  const fail = (msg: string): never => {
    throw new Error(`${kind} catalog invalid: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) fail(`version must be 1, got ${String(r['version'])}`);

  const listRaw = kind === 'missions' ? r['missions'] : r['achievements'];
  if (!Array.isArray(listRaw)) fail(`expected "missions" or "achievements" array`);
  const list = listRaw as unknown[];
  if (list.length === 0) fail('list must be non-empty');

  const ids = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) fail('item not an object');
    const m = item as Record<string, unknown>;
    const idRaw = m['id'];
    if (typeof idRaw !== 'string' || idRaw.length === 0) {
      fail('item.id must be a non-empty string');
    }
    const id = idRaw as string;
    if (ids.has(id)) fail(`duplicate id: ${id}`);
    ids.add(id);

    if (typeof m['title'] !== 'string' || m['title'].length === 0) {
      fail(`${id}: title must be a non-empty string`);
    }
    if (typeof m['description'] !== 'string') {
      fail(`${id}: description must be a string`);
    }
    if (typeof m['kind'] !== 'string' || !VALID_KINDS.has(m['kind'] as MissionKind)) {
      fail(`${id}: kind must be one of ${Array.from(VALID_KINDS).join('|')}, got ${String(m['kind'])}`);
    }
    const target = m['target'];
    if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0) {
      fail(`${id}: target must be a positive integer, got ${String(target)}`);
    }
    if (kind === 'missions') {
      const ul = m['unlockLevel'];
      if (typeof ul !== 'number' || !Number.isInteger(ul) || ul < 1) {
        fail(`${id}: unlockLevel must be an integer ≥ 1, got ${String(ul)}`);
      }
    }
    validateFilters(m['filters'], id, kind === 'missions');
    validateReward(m['reward'], id);
  }
}

function validateFilters(raw: unknown, id: string, allowUnlock: boolean): void {
  const fail = (msg: string): never => {
    throw new Error(`missions catalog invalid: ${id}: filters: ${msg}`);
  };
  if (raw === undefined || raw === null) return; // optional
  if (typeof raw !== 'object') fail('must be an object');
  const f = raw as Record<string, unknown>;
  if (f['mode'] !== undefined && !VALID_MODES.has(f['mode'] as string)) {
    fail(`mode must be one of ${Array.from(VALID_MODES).join('|')}`);
  }
  if (f['trackId'] !== undefined && typeof f['trackId'] !== 'string') {
    fail('trackId must be a string');
  }
  if (f['classId'] !== undefined && !VALID_CLASSES.has(f['classId'] as string)) {
    fail(`classId must be one of ${Array.from(VALID_CLASSES).join('|')}`);
  }
  if (f['maxPosition'] !== undefined) {
    const p = f['maxPosition'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 6) {
      fail('maxPosition must be an integer in [1, 6]');
    }
  }
  if (f['size'] !== undefined && !VALID_SIZES.has(f['size'] as number)) {
    fail(`size must be one of ${Array.from(VALID_SIZES).join('|')}`);
  }
  if (f['requireFirstWinOfDay'] !== undefined && typeof f['requireFirstWinOfDay'] !== 'boolean') {
    fail('requireFirstWinOfDay must be a boolean');
  }
}

function validateReward(raw: unknown, id: string): void {
  const fail = (msg: string): never => {
    throw new Error(`missions catalog invalid: ${id}: reward: ${msg}`);
  };
  if (raw === undefined || raw === null) fail('reward is required');
  if (typeof raw !== 'object') fail('must be an object');
  const r = raw as Record<string, unknown>;
  const numericFields = ['coins', 'xp', 'gems'] as const;
  let hasAny = false;
  for (const k of numericFields) {
    if (r[k] !== undefined) {
      hasAny = true;
      const v = r[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        fail(`${k} must be a non-negative integer, got ${String(v)}`);
      }
    }
  }
  if (r['cosmeticId'] !== undefined) {
    hasAny = true;
    if (typeof r['cosmeticId'] !== 'string' || r['cosmeticId'].length === 0) {
      fail('cosmeticId must be a non-empty string');
    }
  }
  if (!hasAny) fail('at least one of coins/xp/gems/cosmeticId is required');
}

// ─── Freezing helpers ─────────────────────────────────────────────────────────

function freezeMission(m: MissionDefinition): MissionDefinition {
  return Object.freeze({
    id: m.id,
    title: m.title,
    description: m.description,
    kind: m.kind,
    filters: Object.freeze({ ...m.filters }) as MissionFilter,
    target: m.target,
    reward: Object.freeze({ ...m.reward }) as MissionReward,
    unlockLevel: m.unlockLevel,
  });
}

function freezeAchievement(a: AchievementDefinition): AchievementDefinition {
  return Object.freeze({
    id: a.id,
    title: a.title,
    description: a.description,
    kind: a.kind,
    filters: Object.freeze({ ...a.filters }) as MissionFilter,
    target: a.target,
    reward: Object.freeze({ ...a.reward }) as MissionReward,
  });
}

// Re-export types that tests need.
export type { AchievementDefinition, MissionDefinition };
export type { DailyMissions, WeeklyMissions };