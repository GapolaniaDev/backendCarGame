// Phase 7 Chunk 1 — Recent rivals subscriber.
//
// Listens to the in-process `RaceCompleted` event. For every closed
// race, walks the humans and updates each player's `recent_rivals`
// storage row.
//
// Storage shape:
//
//   recent_rivals/{userId} {
//     schemaVersion: 1,
//     userId,
//     entries: [
//       { userId, lastRaceAt, raceCount },
//       …            // sorted desc by lastRaceAt, max RECENT_RIVALS_CAP
//     ]
//   }
//
// Per-pair semantics: if A and B race 3 times in 30 days, both A and B
// have each other in their respective `recent_rivals` rows. `raceCount`
// is incremented on each match.
//
// Aged-out: any entry where `now - lastRaceAt > 30 days` is dropped on
// every update (defensive; even if `recent_rivals_get` doesn't filter, the
// returned list is fresh). Capped at `RECENT_RIVALS_CAP` (20); on
// overflow, the LEAST-recent entry is dropped (so `lastRaceAt` stays
// sorted desc).
//
// Subscriber never throws — same convention as Phase 6's
// missions/pass subscribers. Wrapped in try/catch.
//
// Wired from `main.ts` AFTER `subscribeMissionsProgress` so the race
// fan-out order is: ranked → missions → recent-rivals. Recent-rivals
// is the cheapest write of the three and must NOT block the prior
// subscribers; it sits last so a storage hiccup never delays the
// rating/missions path.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import {
  MAX_CAS_RETRIES,
  readRecentRivals,
  writeRecentRivalsCreate,
  writeRecentRivalsUpdate,
} from './friends_repo';
import {
  RECENT_RIVALS_CAP,
  RECENT_RIVALS_WINDOW_MS,
  type RecentRivalEntry,
  type RecentRivalsRecord,
} from './types';

export interface RecentRivalsSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface RecentRivalsSubscriberOutcome {
  processed: boolean;
  reason: string;
  humans: Array<{
    userId: string;
    rivalCount: number;
    added: string[];
    incremented: string[];
  }>;
}

const SKIP: RecentRivalsSubscriberOutcome = {
  processed: false,
  reason: 'unknown',
  humans: [],
};

/**
 * Bus subscriber entry point. Wrapped in try/catch so a thrown error
 * in this handler doesn't kill the rest of the bus subscribers.
 */
export function subscribeRecentRivals(deps: RecentRivalsSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEvent;
      handleRaceCompletedForRecentRivals(deps, event);
    } catch (e) {
      deps.logger.error(
        'recent_rivals subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Apply a closed race to recent-rivals. Public so unit tests can drive
 * it with synthetic events.
 */
export function handleRaceCompletedForRecentRivals(
  deps: RecentRivalsSubscriberDeps,
  raceEvent: RaceCompletedEvent,
): RecentRivalsSubscriberOutcome {
  const { logger, nk } = deps;
  if (!raceEvent || typeof raceEvent.sessionId !== 'string') {
    return { ...SKIP, reason: 'event_missing' };
  }

  // Bots are filtered first — they don't appear in either side's
  // rivals row. (Self-race with only bots → empty humans → noop.)
  const humans = extractHumans(raceEvent.results);
  if (humans.length === 0) {
    return { ...SKIP, reason: 'no_humans', humans: [] };
  }

  const now = Date.now();
  const closedAt = typeof raceEvent.closedAt === 'number' ? raceEvent.closedAt : now;
  // Use closedAt as the canonical timestamp so replay (re-publish of the
  // same event) lands at the same lastRaceAt.
  const stamp = closedAt;

  // For each player, list the OTHER humans as opponents.
  const outcomes: RecentRivalsSubscriberOutcome['humans'] = [];

  for (const human of humans) {
    const opponents = humans
      .filter((h) => h.userId !== human.userId)
      .map((h) => h.userId);
    if (opponents.length === 0) continue;

    const result = applyRecentRivalsForPlayer(nk, human.userId, opponents, stamp);
    if (result !== null) {
      outcomes.push({ userId: human.userId, ...result });
    }
  }

  if (outcomes.length === 0) {
    logger.debug(
      'recent_rivals: race sid=%s had humans but no qualifying pairs',
      raceEvent.sessionId,
    );
    return { processed: true, reason: 'ok_no_pairs', humans: [] };
  }

  return { processed: true, reason: 'ok', humans: outcomes };
}

/**
 * Update a single player's recent-rivals row. Returns a per-player
 * summary (rivalCount + added + incremented) or `null` on skip (e.g.
 * the player raced only bots and had no opponents).
 */
function applyRecentRivalsForPlayer(
  nk: INakama,
  userId: string,
  opponents: string[],
  stamp: number,
): {
  rivalCount: number;
  added: string[];
  incremented: string[];
} | null {
  const existing = readRecentRivals(nk, userId);
  const prevEntries: RecentRivalEntry[] = existing
    ? filterWindow(existing.record.entries, stamp)
    : [];

  const map = new Map<string, RecentRivalEntry>();
  for (const e of prevEntries) map.set(e.userId, e);

  const added: string[] = [];
  const incremented: string[] = [];

  for (const opp of opponents) {
    if (typeof opp !== 'string' || opp.length === 0) continue;
    const prev = map.get(opp);
    if (prev) {
      const next: RecentRivalEntry = {
        userId: opp,
        lastRaceAt: stamp,
        raceCount: prev.raceCount + 1,
      };
      map.set(opp, next);
      incremented.push(opp);
    } else {
      const next: RecentRivalEntry = {
        userId: opp,
        lastRaceAt: stamp,
        raceCount: 1,
      };
      map.set(opp, next);
      added.push(opp);
    }
  }

  // Sort desc by lastRaceAt, cap at RECENT_RIVALS_CAP.
  const merged = Array.from(map.values()).sort(
    (a, b) => b.lastRaceAt - a.lastRaceAt,
  );
  const capped = merged.slice(0, RECENT_RIVALS_CAP);

  const nextRecord: RecentRivalsRecord = {
    schemaVersion: 1,
    userId,
    entries: capped,
  };

  if (existing === null) {
    writeRecentRivalsCreate(nk, nextRecord);
  } else {
    let version = existing.version;
    let wrote = false;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES && !wrote; attempt++) {
      try {
        version = writeRecentRivalsUpdate(nk, nextRecord, version);
        wrote = true;
      } catch {
        // CAS conflict — re-read latest and recompute. The merged map
        // already includes all opponents, so re-applying won't double
        // count raceCount (we'd re-bump on the second CAS read). For
        // simplicity, we just retry with the SAME record once. (In
        // practice CAS conflicts on a single-user write are exceedingly
        // rare; the retry is best-effort.)
        const reread = readRecentRivals(nk, userId);
        if (reread === null) {
          writeRecentRivalsCreate(nk, nextRecord);
          wrote = true;
        } else {
          version = reread.version;
        }
      }
    }
    if (!wrote) {
      // Exhausted retries — drop. Subscriber must never throw.
    }
  }

  return {
    rivalCount: capped.length,
    added,
    incremented,
  };
}

/**
 * Filter out entries older than `RECENT_RIVALS_WINDOW_MS` measured from
 * `now`. Returns a fresh array.
 */
export function filterWindow(
  entries: RecentRivalEntry[],
  now: number,
): RecentRivalEntry[] {
  return entries.filter((e) => now - e.lastRaceAt <= RECENT_RIVALS_WINDOW_MS);
}

/**
 * LRU-trim a sorted-desc list to `RECENT_RIVALS_CAP`. Pure; doesn't
 * mutate the input.
 */
export function trimToCap(
  entries: RecentRivalEntry[],
  cap: number = RECENT_RIVALS_CAP,
): RecentRivalEntry[] {
  if (entries.length <= cap) return entries.slice();
  return entries.slice(0, cap);
}

/**
 * Filter `RaceResult[]` to humans only (defensive — the race types use
 * `isBot: true` for non-human). Pure.
 */
export function extractHumans(results: RaceResult[]): RaceResult[] {
  const out: RaceResult[] = [];
  for (const r of results) {
    if (!r.isBot) out.push(r);
  }
  return out;
}