// Phase 4 ranked division helpers (no storage, no `nk`).
//
// This module is a thin layer on top of `ranked/config.ts`:
//   - re-exports `divisionForRating` so callers can import everything
//     from one place.
//   - adds `divisionAtBoundary` (used by Chunk 6 `ranked_get` to
//     surface "1 win from promotion" badges).
//   - adds `promotionBoundary` (returns the rating at which a player
//     moves from `divisionId` into the next-higher one).
//   - adds `divisionForRatingStrict` for the "empty divisions → throw"
//     test and any defensive paths Chunk 7-8 may want.
//
// All helpers are pure functions of `(config, rating, divisionId)`.

import type { RankedConfig } from './config';
import { divisionForRating as configDivisionForRating } from './config';

/** Re-export of the Chunk 1 helper — kept here so callers don't import both files. */
export function divisionForRating(config: RankedConfig, rating: number): string {
  return configDivisionForRating(config, rating);
}

/**
 * Throwing variant of `divisionForRating`. Use this when an empty
 * `divisions` array is a programmer error (e.g. inside the rating
 * subscriber or a `ranked_get` cache miss path). The bundled
 * `ranked_config.json` is validated at boot, so in practice this
 * never fires — it's defensive against a future runtime config
 * reload bug.
 */
export function divisionForRatingStrict(config: RankedConfig, rating: number): string {
  if (config.divisions.length === 0) {
    throw new Error('divisionForRating: config has no divisions');
  }
  return configDivisionForRating(config, rating);
}

/**
 * Returns the rating value at which a player transitions OUT of
 * `divisionId` into the next-higher division. The returned value is
 * the LAST valid rating of `divisionId` (i.e. the player is still
 * in `divisionId` when `rating <= promotionBoundary()`).
 *
 * @throws when `divisionId` is unknown or is the topmost division
 *         (no promotion possible — use `topDivision()` to identify).
 */
export function promotionBoundary(config: RankedConfig, divisionId: string): number {
  const divisions = config.divisions;
  const idx = divisions.findIndex((d) => d.id === divisionId);
  if (idx === -1) {
    throw new Error(`promotionBoundary: unknown division id "${divisionId}"`);
  }
  if (idx === divisions.length - 1) {
    throw new Error(
      `promotionBoundary: "${divisionId}" is the top division — no promotion boundary`,
    );
  }
  return divisions[idx]!.maxRating;
}

/**
 * True when `rating` is exactly at the upper edge of `divisionId`
 * — i.e. the next rating value (after a win) would push the player
 * out of that division. Returns false when:
 *   - `divisionId` is not in the config
 *   - `divisionId` is the topmost (no promotion possible)
 *   - `rating` is not in `divisionId` at all (already promoted, or
 *     never was in it)
 *   - `rating` is below the upper edge (more wins needed)
 */
export function divisionAtBoundary(
  config: RankedConfig,
  rating: number,
  divisionId: string,
): boolean {
  const divisions = config.divisions;
  const idx = divisions.findIndex((d) => d.id === divisionId);
  if (idx === -1) return false;
  if (idx === divisions.length - 1) return false;
  return divisions[idx]!.maxRating === rating;
}

/**
 * Returns the id of the topmost division (last entry in `config.divisions`).
 * Used by `ranked_get` to short-circuit "no promotion possible" badges.
 */
export function topDivision(config: RankedConfig): string {
  if (config.divisions.length === 0) {
    throw new Error('topDivision: config has no divisions');
  }
  return config.divisions[config.divisions.length - 1]!.id;
}

/**
 * Returns true if `rating` is inside the named division (per its
 * `[minRating, maxRating]` band). This is a stricter check than
 * `divisionForRating` because it requires an exact match — useful
 * for the "X wins from promotion" UI hint where we want to know if
 * the player is still in the same division the badge refers to.
 */
export function isInDivision(
  config: RankedConfig,
  rating: number,
  divisionId: string,
): boolean {
  const div = config.divisions.find((d) => d.id === divisionId);
  if (div === undefined) return false;
  return rating >= div.minRating && rating <= div.maxRating;
}