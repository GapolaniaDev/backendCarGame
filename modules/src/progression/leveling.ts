// Phase 3 progression helpers. Pure functions over the levels
// catalog — no Nakama calls. The RaceCompleted subscriber (Chunk 5)
// uses these to compute level-ups from accumulated XP; `profile_get`
// reads them when serving the player-facing progression view.

import { getLevelsCatalog } from './catalog';
import { MAX_LEVEL, type LevelEntry, type LevelInfo, type LevelsCatalog } from './types';

/**
 * Return the player's current level for a given cumulative XP.
 * Levels are 1-indexed; XP below the first level's threshold counts
 * as level 1. XP that overflows MAX_LEVEL is silently capped (the
 * caller can detect overflow via `xpOverflow`).
 */
export function levelFromXp(
  catalog: LevelsCatalog,
  xp: number,
): { level: number; xpIntoLevel: number; xpToNextLevel: number; xpOverflow: number } {
  if (!Number.isFinite(xp) || xp < 0) {
    return { level: 1, xpIntoLevel: 0, xpToNextLevel: catalog.table[0]?.xpRequired ?? 0, xpOverflow: 0 };
  }
  const table = catalog.table;
  let level = 1;
  let prevThreshold = 0;
  for (let i = 0; i < table.length; i += 1) {
    const entry = table[i];
    if (!entry) break;
    if (xp < entry.xpRequired) {
      // Player is between `level` (1-indexed = i) and `level + 1`
      const nextThreshold = entry.xpRequired;
      return {
        level,
        xpIntoLevel: xp - prevThreshold,
        xpToNextLevel: nextThreshold - xp,
        xpOverflow: 0,
      };
    }
    level = entry.level;
    prevThreshold = entry.xpRequired;
  }
  // Past the last entry: clamp at MAX_LEVEL.
  const last = table[table.length - 1];
  return {
    level: last?.level ?? MAX_LEVEL,
    xpIntoLevel: xp - prevThreshold,
    xpToNextLevel: 0,
    xpOverflow: Math.max(0, xp - (last?.xpRequired ?? prevThreshold)),
  };
}

/**
 * Convenience wrapper that uses the loaded catalog.
 */
export function levelFromCurrentXp(xp: number): ReturnType<typeof levelFromXp> {
  return levelFromXp(getLevelsCatalog(), xp);
}

/**
 * Compute the LevelInfo view (level, xpToNextLevel, unlockedLevels
 * cumulative) for a given cumulative XP.
 */
export function buildLevelInfo(catalog: LevelsCatalog, xp: number): LevelInfo {
  const { level, xpToNextLevel } = levelFromXp(catalog, xp);
  return {
    level,
    xp,
    xpToNextLevel,
    unlockedLevels: collectUnlocksUpTo(catalog, level),
  };
}

export function buildLevelInfoFor(xp: number): LevelInfo {
  return buildLevelInfo(getLevelsCatalog(), xp);
}

/**
 * Collect all catalog-level unlocks from level 1 up to and including
 * the given level. Returns a fresh array so callers can mutate without
 * touching the frozen catalog state.
 */
export function collectUnlocksUpTo(catalog: LevelsCatalog, level: number): string[] {
  if (level < 1) return [];
  const out: string[] = [];
  for (const entry of catalog.table) {
    if (entry.level > level) break;
    for (const u of entry.unlocks) {
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}

/**
 * Apply a positive XP gain to a player's current XP. Returns the new
 * XP value, the previous level, the new level, the delta, and whether
 * a level-up actually happened. XP overflow past MAX_LEVEL is
 * discarded (Decision 3) and surfaced via `xpOverflow`.
 */
export interface XpGainResult {
  prevXp: number;
  newXp: number;
  prevLevel: number;
  newLevel: number;
  leveledUp: boolean;
  /** XP that was thrown away because the player is already at MAX_LEVEL. */
  xpOverflow: number;
  /** The level-entry rewards for each level-up that happened, in order. */
  levelUps: ReadonlyArray<LevelEntry>;
}

export function applyXpGain(catalog: LevelsCatalog, currentXp: number, gain: number): XpGainResult {
  const safeGain = Math.max(0, Math.floor(gain));
  const prev = levelFromXp(catalog, currentXp);
  const attempted = currentXp + safeGain;
  const next = levelFromXp(catalog, attempted);
  const levelUps: LevelEntry[] = [];
  if (next.level > prev.level) {
    for (const entry of catalog.table) {
      if (entry.level > prev.level && entry.level <= next.level) {
        levelUps.push(entry);
      }
    }
  }
  return {
    prevXp: currentXp,
    newXp: attempted - next.xpOverflow,
    prevLevel: prev.level,
    newLevel: next.level,
    leveledUp: next.level > prev.level,
    xpOverflow: next.xpOverflow,
    levelUps,
  };
}

/**
 * Compute how much XP a race is worth, given the coins it grants. Per
 * spec: `xp = max(coins / xpDivisor, xpFloor)`. Both numbers come from
 * the rewards catalog. Returns a non-negative integer.
 */
export function xpFromCoins(coins: number, xpDivisor: number, xpFloor: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 0;
  if (!Number.isFinite(xpDivisor) || xpDivisor <= 0) return Math.max(0, Math.floor(xpFloor));
  if (!Number.isFinite(xpFloor) || xpFloor < 0) return 0;
  return Math.max(Math.floor(coins / xpDivisor), Math.floor(xpFloor));
}