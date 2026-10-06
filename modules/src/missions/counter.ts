// Phase 6 — pure counter engine.
//
// Given a `RaceCompletedEvent` and a single mission/achievement
// definition, returns the integer increment to add to a user's
// progress counter. NO storage writes — that happens in the
// subscriber (Chunk 8).
//
// Rules (canonical, do NOT improvise):
//
//   race_count       → 1 if user finished
//   race_position    → 1 if user finished AND position <= filters.maxPosition
//   race_track       → 1 if user finished AND event.trackId === filters.trackId
//                        AND (filters.maxPosition == null OR position <= filters.maxPosition)
//   race_class       → 1 if user finished AND result.classId === filters.classId
//   wins_quick       → 1 if event.mode === 'quick' AND user finished AND position === 1
//   wins_ranked      → 1 if event.mode === 'ranked' AND user finished AND position === 1
//   race_no_abandon  → 1 if user finished AND event.abandonedCount === 0
//
// Defensive defaults:
//   - Bots filtered before any kind is evaluated.
//   - `filters: {}` matches every event (no narrowing applied).
//   - `requireFirstWinOfDay`: NOT evaluated here. If the event has
//     `firstWinOfDayFor[userId] === false` and the definition requires
//     it, the evaluator returns 0 (the subscriber will recompute once
//     Chunk 8 is in).
//   - Unknown kind → returns 0 (NEVER throws — keeps the subscriber
//     hot path safe from a malformed catalog).
//   - The `def` argument is NEVER mutated. Frozen or not.

import type { MissionFilter, MissionKind } from './types';
import type { RaceCompletedEvent, RaceCompletedResult } from './event';

interface CounterDef {
  kind: MissionKind;
  filters: MissionFilter;
}

// ─── Filter matching helpers (exported for unit tests) ───────────────────────

export function filterMatchesMode(
  filters: MissionFilter,
  mode: RaceCompletedEvent['mode'],
): boolean {
  return filters.mode === undefined || filters.mode === mode;
}

export function filterMatchesSize(
  filters: MissionFilter,
  size: RaceCompletedEvent['size'],
): boolean {
  return filters.size === undefined || filters.size === size;
}

export function filterMatchesClass(
  filters: MissionFilter,
  classId: RaceCompletedResult['classId'],
): boolean {
  return filters.classId === undefined || filters.classId === classId;
}

export function filterMatchesTrack(
  filters: MissionFilter,
  trackId: string,
): boolean {
  return filters.trackId === undefined || filters.trackId === trackId;
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Returns the integer increment (0 or 1) for the given user against
 * the provided mission/achievement definition.
 */
export function evaluateIncrement(
  event: RaceCompletedEvent,
  def: CounterDef,
  targetUserId: string,
): number {
  if (!matchesEvent(event, def, targetUserId)) return 0;
  return 1;
}

/**
 * Returns true if the event matches `def` for `targetUserId`. Filter
 * matching follows the canonical rules table above; helper predicates
 * (`filterMatchesMode` etc.) are exposed for tests.
 *
 * Bots are filtered out FIRST — a non-human `targetUserId` is a
 * programming error and never matches.
 */
export function matchesEvent(
  event: RaceCompletedEvent,
  def: CounterDef,
  targetUserId: string,
): boolean {
  if (!event.results || event.results.length === 0) return false;
  const result = findHumanResult(event, targetUserId);
  if (result === null) return false;

  // Mode/size/track/class filters apply to ALL kinds.
  if (!filterMatchesMode(def.filters, event.mode)) return false;
  if (!filterMatchesSize(def.filters, event.size)) return false;
  if (!filterMatchesTrack(def.filters, event.trackId)) return false;
  if (!filterMatchesClass(def.filters, result.classId)) return false;

  // requireFirstWinOfDay: only respected if the subscriber has stamped
  // the flag. When the definition requires it but the map is absent,
  // we defer to the subscriber by returning false (the subscriber in
  // Chunk 8 re-evaluates with the flag populated).
  if (def.filters.requireFirstWinOfDay === true) {
    const flag = event.firstWinOfDayFor?.[targetUserId];
    if (flag !== true) return false;
  }

  switch (def.kind) {
    case 'race_count':
      return result.finishedRace === true;
    case 'race_position':
      return result.finishedRace === true
        && typeof def.filters.maxPosition === 'number'
        && typeof result.position === 'number'
        && result.position <= def.filters.maxPosition;
    case 'race_track':
      return result.finishedRace === true
        && (def.filters.maxPosition === undefined
          || (typeof result.position === 'number'
            && result.position <= (def.filters.maxPosition as number)));
    case 'race_class':
      return result.finishedRace === true;
    case 'wins_quick':
      return event.mode === 'quick'
        && result.finishedRace === true
        && result.position === 1;
    case 'wins_ranked':
      return event.mode === 'ranked'
        && result.finishedRace === true
        && result.position === 1;
    case 'race_no_abandon':
      return result.finishedRace === true && event.abandonedCount === 0;
    default:
      // Defensive: unknown kind never throws.
      return false;
  }
}

function findHumanResult(
  event: RaceCompletedEvent,
  userId: string,
): RaceCompletedResult | null {
  for (const r of event.results) {
    if (r.isHuman && r.userId === userId) return r;
  }
  return null;
}