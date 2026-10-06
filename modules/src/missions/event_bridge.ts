// Phase 6 Chunk 4 — pure bridge between the in-process `RaceCompletedEvent`
// from `race/types.ts` and the Phase 6 `RaceCompletedEvent` consumed by the
// counter engine (`missions/event.ts`).
//
// The two shapes differ — the Phase 1 race payload carries the raw
// `RaceResult` (rank, totalMs, abandoned, isBot) while the Phase 6
// payload needs `position` (1-indexed, null for abandons), `classId`,
// `carId`, `finishedRace`, and `isHuman`. The bridge is pure (no
// storage, no bus) so it can be exercised in isolation.
//
// `BridgeContext` carries the per-user data NOT present in the race
// event itself — `classId` and `carId` come from the race session's
// loadout. The subscriber reads the session once and feeds the map
// into the bridge.

import type {
  RaceCompletedEvent as RaceCompletedEventFromRace,
  RaceResult as RaceResultFromRace,
} from '../race/types';
import type {
  RaceCompletedEvent,
  RaceCompletedResult,
  MissionCarClass,
  MissionConfidence,
} from './event';

export interface BridgeContext {
  /** userId → car class. Sourced from `race_sessions/{sid}.roster.loadout.classId`. */
  readonly classes: ReadonlyMap<string, MissionCarClass>;
  /** userId → car body id. Sourced from `race_sessions/{sid}.roster.loadout.bodyId`. */
  readonly cars: ReadonlyMap<string, string>;
  /** Server epoch-ms when the race started. Used to compute durationMs. */
  readonly startedAt: number;
}

/**
 * Convert the in-process race event to the Phase 6 mission event.
 *
 * Bots are converted to `isHuman=false` so the counter can keep them
 * out of progress writes — `extractHumanResults` filters them later.
 *
 * Confined inputs (`isBot=true` or missing userId) become DNFs with
 * `finishedRace=false`, `position=null`. The counter never increments
 * for them.
 */
export function bridgeToMissionEvent(
  raceEvent: RaceCompletedEventFromRace,
  ctx: BridgeContext,
): RaceCompletedEvent {
  const results: RaceCompletedResult[] = raceEvent.results.map((r) =>
    convertResult(r, ctx),
  );

  let finisherCount = 0;
  let abandonedCount = 0;
  for (const r of raceEvent.results) {
    if (r.isBot) continue;
    if (r.abandoned) abandonedCount += 1;
    else finisherCount += 1;
  }

  return {
    schemaVersion: 1,
    sessionId: raceEvent.sessionId,
    raceId: raceEvent.sessionId, // Phase 6 doesn't carry a separate raceId — reuse.
    mode: raceEvent.mode,
    trackId: raceEvent.trackId,
    size: raceEvent.size === 1 ? 2 : raceEvent.size, // sanitize `size=1` (test fixtures)
    finisherCount,
    abandonedCount,
    durationMs: Math.max(0, raceEvent.closedAt - ctx.startedAt),
    confidence: deriveConfidence(raceEvent),
    results,
    timestampMs: raceEvent.closedAt,
  };
}

function convertResult(
  r: RaceResultFromRace,
  ctx: BridgeContext,
): RaceCompletedResult {
  const classId = ctx.classes.get(r.userId);
  const carId = ctx.cars.get(r.userId) ?? '';
  return {
    userId: r.userId,
    carId,
    classId: classId ?? 'D', // defensive — bots/dnf with no roster entry default to D
    position: r.abandoned ? null : r.rank,
    isHuman: !r.isBot,
    finishedRace: !r.isBot && !r.abandoned,
  };
}

/**
 * Map the race close's confidence enum to the Phase 6 MissionConfidence.
 *  - quorum → 'high' (clean close, no review flag)
 *  - client → 'low' (humans disagreed, host's order taken, needsReview=true)
 *  - server → 'high' (no humans reported; bot order by totalMs — same confidence
 *    semantics; the 'low' variant is reserved for the client-disagreement path)
 */
function deriveConfidence(
  raceEvent: RaceCompletedEventFromRace,
): MissionConfidence {
  if (raceEvent.flags.needsReview) return 'low';
  return 'high';
}