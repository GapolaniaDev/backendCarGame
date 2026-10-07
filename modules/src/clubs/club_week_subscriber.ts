// Phase 7 Chunk 5 — RaceCompleted → club week points subscriber.
//
// Subscribes to the in-process `RaceCompleted` event. For every
// closed race:
//
//   1. Apply the confidence gate: only `server` or `quorum` close-
//      outcomes credit points. `client` (humans disagreed, flagged for
//      review) drops the entire event so nobody is credited.
//   2. For every human finisher (non-bot, non-abandoned):
//        - look up their clubId via a one-shot scan of `clubs_members`
//          (cached across all humans in the event so we don't scan once
//          per player);
//        - if they have a club:
//            * increment the `club_week` leaderboard by `points` for
//              ownerId=clubId;
//            * CAS-update their `clubs_members/{clubId}/{userId}.weeklyContribution`
//              (additive);
//            * CAS-update the club's `clubs_metadata.weeklyPoints`
//              (additive).
//
// The subscriber never throws. Every error is caught and logged at
// warn so a storage hiccup never breaks the rest of the bus.
//
// Wired from `main.ts` AFTER `subscribeRecentRivals` so the race
// fan-out order stays stable. `clubs_week_meta` and per-member
// `weeklyContribution` are read+written here but the week-boundary
// reset lives in `club_week_reset.ts` (lazy, on `club_get`).

import type { ILogger, INakama, IStorageObject } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import {
  CLUBS_MEMBERS_COLLECTION,
  MAX_CAS_RETRIES,
  readMember,
  writeMemberUpdate,
} from './members_repo';
import { readClubMetadata, writeClubMetadataUpdate } from './clubs_repo';
import { CLUB_WEEK_LEADERBOARD_ID } from './leaderboard_init';
import {
  pointsForRace,
  pointsForRaceResult,
} from './club_week';

export interface ClubWeekSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface ClubWeekOutcome {
  /** `false` when the event was skipped (confidence gate or no humans). */
  processed: boolean;
  /** Reason string for skip outcomes (helps debugging tests). */
  reason: string;
  /** Per-human side-effect summary (empty when not processed). */
  humans: Array<{
    userId: string;
    clubId: string;
    points: number;
    outcome: 'win' | 'podium' | 'finish';
    memberWritten: boolean;
    metadataWritten: boolean;
  }>;
}

const SKIP: ClubWeekOutcome = { processed: false, reason: 'unknown', humans: [] };

/**
 * Bus subscriber entry point. Wrapped in try/catch so a thrown error
 * in this handler doesn't kill the rest of the bus subscribers.
 */
export function subscribeClubWeek(deps: ClubWeekSubscriberDeps): void {
  deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    try {
      const event = payload as RaceCompletedEvent;
      handleRaceCompletedForClubWeek(deps, event);
    } catch (e) {
      deps.logger.error(
        'club_week subscriber failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}

/**
 * Apply a closed race to club-week points. Public so unit tests can
 * drive it with synthetic events.
 */
export function handleRaceCompletedForClubWeek(
  deps: ClubWeekSubscriberDeps,
  event: RaceCompletedEvent,
): ClubWeekOutcome {
  const { logger, nk } = deps;
  if (event === null || typeof event !== 'object' || typeof event.sessionId !== 'string') {
    return { ...SKIP, reason: 'event_missing' };
  }

  // 1. Confidence gate.
  const gate = pointsForRace(event);
  if (gate.aborted) {
    logger.debug(
      'club_week: drop sid=%s reason=%s',
      event.sessionId, gate.reason,
    );
    return { ...SKIP, reason: gate.reason };
  }

  // 2. Walk the human finishers (bots + abandoned never credit).
  const humans = event.results.filter(
    (r) => !r.isBot && !r.abandoned,
  );
  if (humans.length === 0) {
    return { ...SKIP, reason: 'no_humans' };
  }

  // 3. Build a one-shot userId → clubId map. We scan the entire
  //    `clubs_members` collection (small at our scale — 30 per club ×
  //    few-hundred clubs) and key by userId so a player only appears
  //    once even if multiple humans in the race share a club.
  const clubByUser = scanUserToClubMap(nk);
  if (clubByUser.size === 0) {
    return { ...SKIP, reason: 'no_clubs' };
  }

  // 4. Per-human write loop.
  const outcomes: ClubWeekOutcome['humans'] = [];

  for (const r of humans) {
    const userId = r.userId;
    const clubId = clubByUser.get(userId);
    if (clubId === undefined) {
      // Player is not in any club — no-op for club_week.
      continue;
    }
    const points = pointsForRaceResult(r);
    if (points === 0) continue;

    const outcomeLabel: 'win' | 'podium' | 'finish' =
      r.rank === 1 ? 'win' :
      r.rank === 2 || r.rank === 3 ? 'podium' :
      'finish';

    // Read the member row (for CAS). Re-read each iteration because
    // the prior write's CAS bumped the version; caching would leave us
    // with a stale `fresh.version` for the next human.
    const member = readMember(nk, clubId, userId);
    if (member === null) {
      // Player row vanished between scan + write (kicked during the
      // race). Skip silently — we don't crash the subscriber.
      logger.warn(
        'club_week: member row vanished mid-flight clubId=%s userId=%s',
        clubId, userId,
      );
      continue;
    }

    const meta = readClubMetadata(nk, clubId);
    if (meta === null) {
      logger.warn(
        'club_week: metadata vanished mid-flight clubId=%s',
        clubId,
      );
      continue;
    }

    // CAS-write the leaderboard record. The Nakama runtime applies the
    // `incr` operator with our score, so the row's new value is
    // `prev + points`. Errors are logged and dropped (subscriber must
    // never throw).
    let lbWritten = true;
    try {
      nk.leaderboardRecordWrite(
        CLUB_WEEK_LEADERBOARD_ID,
        clubId,
        /* username */ '',
        points,
        /* subscore */ Date.now(),
        { source: 'race_completed', sessionId: event.sessionId },
        /* operatorOverride */ 'incr',
      );
    } catch (e) {
      lbWritten = false;
      logger.warn(
        'club_week lb write failed clubId=%s userId=%s: %s',
        clubId, userId, e instanceof Error ? e.message : String(e),
      );
    }
    void lbWritten;

    // CAS-update the member row (additive weeklyContribution).
    const memberWritten = casAddWeeklyContribution(
      nk, logger, member, points,
    );

    // CAS-update the metadata.weeklyPoints (additive).
    const metadataWritten = casAddWeeklyPoints(
      nk, logger, meta, points,
    );

    outcomes.push({
      userId,
      clubId,
      points,
      outcome: outcomeLabel,
      memberWritten,
      metadataWritten,
    });
  }

  if (outcomes.length === 0) {
    return { ...SKIP, reason: 'all_unclubbed' };
  }

  logger.info(
    'club_week applied sid=%s humans=%d win=%d podium=%d finish=%d',
    event.sessionId,
    outcomes.length,
    outcomes.filter((o) => o.outcome === 'win').length,
    outcomes.filter((o) => o.outcome === 'podium').length,
    outcomes.filter((o) => o.outcome === 'finish').length,
  );

  return { processed: true, reason: 'ok', humans: outcomes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Scan every `clubs_members` row and build a `userId → clubId` map.
 * Used to attribute race results to clubs without per-user storage
 * reads. Pure-ish: no leaderboard writes.
 */
function scanUserToClubMap(nk: INakama): Map<string, string> {
  const list = nk.storageList({
    collection: CLUBS_MEMBERS_COLLECTION,
    limit: 5000,
  });
  const out = new Map<string, string>();
  for (const o of list.objects) {
    const v = o.value as Partial<{ userId: string; clubId: string }>;
    if (
      v && typeof v === 'object' &&
      typeof v.userId === 'string' && v.userId.length > 0 &&
      typeof v.clubId === 'string' && v.clubId.length > 0
    ) {
      // First-write wins (a user can only be in one club at a time in
      // the data model; a duplicate is a bug we silently de-dupe).
      if (!out.has(v.userId)) out.set(v.userId, v.clubId);
    }
  }
  return out;
}

/**
 * CAS-add `delta` to a member's `weeklyContribution`. Retries up to
 * `MAX_CAS_RETRIES` on conflict (re-reads + recomputes). Returns
 * `true` on success, `false` when retries are exhausted.
 */
function casAddWeeklyContribution(
  nk: INakama,
  logger: ILogger,
  initial: { record: import('./types').MemberRecord; version: string },
  delta: number,
): boolean {
  let fresh = initial;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const next: import('./types').MemberRecord = {
      ...fresh.record,
      weeklyContribution: fresh.record.weeklyContribution + delta,
    };
    try {
      writeMemberUpdate(nk, next, fresh.version);
      return true;
    } catch (e) {
      const reread = readMember(nk, fresh.record.clubId, fresh.record.userId);
      if (reread === null) {
        logger.warn(
          'club_week CAS: member row vanished clubId=%s userId=%s',
          fresh.record.clubId, fresh.record.userId,
        );
        return false;
      }
      fresh = reread;
    }
  }
  logger.warn(
    'club_week CAS: member retries exhausted clubId=%s userId=%s',
    fresh.record.clubId, fresh.record.userId,
  );
  return false;
}

/**
 * CAS-add `delta` to a club's metadata.weeklyPoints. Retries up to
 * `MAX_CAS_RETRIES` on conflict. Returns `true` on success.
 */
function casAddWeeklyPoints(
  nk: INakama,
  logger: ILogger,
  initial: { record: import('./types').ClubMetadata; version: string },
  delta: number,
): boolean {
  let fresh = initial;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const next: import('./types').ClubMetadata = {
      ...fresh.record,
      weeklyPoints: fresh.record.weeklyPoints + delta,
    };
    try {
      writeClubMetadataUpdate(nk, next, fresh.version);
      return true;
    } catch (e) {
      const reread = readClubMetadata(nk, fresh.record.clubId);
      if (reread === null) {
        logger.warn(
          'club_week CAS: metadata vanished clubId=%s',
          fresh.record.clubId,
        );
        return false;
      }
      fresh = reread;
    }
  }
  logger.warn(
    'club_week CAS: metadata retries exhausted clubId=%s',
    fresh.record.clubId,
  );
  return false;
}

// ─── Light re-exports ──────────────────────────────────────────────────────

/** Pull just the humans that earn club-week points. */
export function humanFinishers(rs: RaceResult[]): RaceResult[] {
  return rs.filter((r) => !r.isBot && !r.abandoned);
}

// Suppress unused-import lint warning for IStorageObject (kept for
// future expansion — e.g. multi-update batch).
void (null as unknown as IStorageObject);