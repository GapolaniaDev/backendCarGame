// Phase 6 Chunk 7 — pure XP computation helpers.
//
// Three sources feed pass XP:
//   1. Race finish    →  RACE_XP_BASE × mode multiplier  (D7)
//   2. Mission claim  →  reward.xp from the catalog       (D8)
//   3. Achievement    →  reward.xp from the catalog       (D8)
//
// This module holds the PURE math; the storage side lives in
// `pass_repo.ts` (`addPassXp` with optional dedupeKey).

import type { MissionRaceMode } from '../missions/event';

/** Base XP per finished race (any mode). */
export const RACE_XP_BASE = 20;

/** D7 multipliers per race mode. */
export const RACE_XP_MULTIPLIER: Readonly<Record<MissionRaceMode, number>> = {
  quick: 1,
  ranked: 1.25,
  private: 0.25,
  time_trial: 0.5,
};

/** All sources that can grant pass XP. Used by `pass_xp_gained` analytics. */
export const PASS_XP_SOURCES = [
  'race_quick',
  'race_ranked',
  'race_private',
  'race_time_trial',
  'mission_claim',
  'achievement_claim',
] as const;

export type PassXPSource = (typeof PASS_XP_SOURCES)[number];

/** Map a race mode to its pass XP source tag. */
export function passXPSourceForRace(mode: MissionRaceMode): PassXPSource {
  switch (mode) {
    case 'quick': return 'race_quick';
    case 'ranked': return 'race_ranked';
    case 'private': return 'race_private';
    case 'time_trial': return 'race_time_trial';
  }
}

/**
 * Compute the integer XP grant for a finished race.
 * Returns `Math.floor(RACE_XP_BASE × multiplier)`. Always integer;
 * a float value (e.g. 25 from 1.25 * 20) is floored so storage holds
 * no fractional XP.
 */
export function raceXPFor(mode: MissionRaceMode): number {
  const mult = RACE_XP_MULTIPLIER[mode];
  if (typeof mult !== 'number') return 0;
  return Math.floor(RACE_XP_BASE * mult);
}

/**
 * XP from a mission reward. Returns `reward.xp ?? 0`. Defensive
 * against missing / non-positive / non-integer values — anything that
 * isn't a positive integer → 0.
 */
export function missionXPFor(reward: { xp?: unknown }): number {
  const v = reward?.xp;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    return 0;
  }
  return v;
}

/** XP from an achievement reward. Same shape as mission. */
export function achievementXPFor(reward: { xp?: unknown }): number {
  return missionXPFor(reward);
}