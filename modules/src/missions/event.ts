// Phase 6 — RaceCompleted event shape consumed by the missions/achievements
// counter engine (counter.ts) and (in Chunk 8) the RaceCompleted
// subscriber.
//
// This is the Phase 6 payload — NOT the same shape as the in-process
// `RaceCompletedEvent` in `race/types.ts`. The Chunk 8 subscriber
// bridges the two: it reads the in-process event, derives the fields
// below (`finisherCount`, `abandonedCount`, `confidence`, etc.) and
// builds a Phase 6 event for the counter.
//
// Per spec: the subscriber (Chunk 8) is also responsible for stamping
// `firstWinOfDayFor[userId]` from cross-call state. This module only
// respects that map if it's already populated — it never computes it.

export type MissionRaceMode = 'quick' | 'ranked' | 'private' | 'time_trial';
export type MissionCarClass = 'D' | 'C' | 'B' | 'A' | 'S';
export type MissionConfidence = 'high' | 'low';
export type MissionRaceSize = 2 | 4 | 6;

export interface RaceCompletedResult {
  userId: string;
  carId: string;
  classId: MissionCarClass;
  /** 1-indexed position. `null` when the player abandoned. */
  position: number | null;
  /** False for AI drivers. */
  isHuman: boolean;
  /** False if the player abandoned (or didn't submit in time). */
  finishedRace: boolean;
}

export interface RaceCompletedEvent {
  schemaVersion: 1;
  sessionId: string;
  raceId: string;
  mode: MissionRaceMode;
  trackId: string;
  size: MissionRaceSize;
  /** Number of finishers (humans + bots). */
  finisherCount: number;
  /** Number of abandons (humans + bots). */
  abandonedCount: number;
  durationMs: number;
  confidence: MissionConfidence;
  results: RaceCompletedResult[];
  timestampMs: number;
  /**
   * Optional: per-user first-win-of-day flag. Populated by the
   * subscriber (Chunk 8) which owns the cross-call state.
   * Counter code only respects it when present.
   */
  firstWinOfDayFor?: Record<string, boolean>;
}

/**
 * Return only the human results. Bots are filtered out BEFORE any
 * kind is evaluated — a bot win never increments `wins_quick`,
 * `wins_ranked`, or any other kind. Bots are also excluded from
 * `finisherCount` / `abandonedCount` upstream (see the subscriber
 * contract in Chunk 8), but here we only filter the result list.
 */
export function extractHumanResults(
  event: RaceCompletedEvent,
): RaceCompletedResult[] {
  const out: RaceCompletedResult[] = [];
  for (const r of event.results) {
    if (r.isHuman) out.push(r);
  }
  return out;
}

/** Convenience: returns the entry for a given human userId, or null. */
export function findHumanResult(
  event: RaceCompletedEvent,
  userId: string,
): RaceCompletedResult | null {
  for (const r of event.results) {
    if (r.isHuman && r.userId === userId) return r;
  }
  return null;
}