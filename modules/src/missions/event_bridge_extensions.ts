// Phase 6 Chunk 4 — first_win_of_day stamp + cross-call state.
//
// Some achievements / missions (`daily_first_win`, `weekly_first_win_daily`,
// `ach_first_win_of_day_3`, `ach_first_win_of_day_15`) require a
// `requireFirstWinOfDay` filter. The counter engine respects
// `event.firstWinOfDayFor[userId] === true` (per `counter.ts`). This
// module owns the cross-call state that the counter can't.
//
// Storage layout:
//   collection: 'first_win_today'
//   key:        `${userId}/${dateUtc}`   (UTC date string from core/time)
//   userId:     `${userId}`              (so the row is owned by the user)
//   permissions: Read=1, Write=1         (server-only writes; the row is
//                                        only read by the subscriber itself)
//   value:      { schemaVersion: 1, userId, dateUtc, firstWinAt }
//
// Stamp semantics:
//   - Read; if a row exists for today, return false (already stamped).
//   - Otherwise, CAS-write a fresh row; return true.
//   - CAS conflict means another race in flight wrote the row first →
//     return false. Retry MAX_CAS_RETRIES times.
//
// `stampFirstWinOfDayForAll` walks the human results of an event and
// stamps each player in sequence. Bots are excluded.

import type { IStorageObject, ILogger, INakama } from '../nkruntime';
import {
  SERVER_OWNED_READ,
  SERVER_OWNED_WRITE,
} from './counter_repo';
import type { RaceCompletedEvent, RaceCompletedResult } from './event';
import { extractHumanResults } from './event';

export const FIRST_WIN_TODAY_COLLECTION = 'first_win_today';
const MAX_CAS_RETRIES = 3;

interface FirstWinTodayRecord {
  schemaVersion: 1;
  userId: string;
  dateUtc: string;
  firstWinAt: number;
}

function firstWinTodayKey(userId: string, dateUtc: string): string {
  return `${userId}/${dateUtc}`;
}

/**
 * Stamp the first_win_of_day record for a single user.
 *
 *   - `true`  — the row was created (this IS the user's first win today).
 *   - `false` — the row already exists (or CAS lost the race).
 *
 * Returns `false` for non-winners (didn't finish OR didn't finish rank=1)
 * without writing anything.
 */
export function stampFirstWinOfDay(
  nk: INakama,
  logger: ILogger,
  event: RaceCompletedEvent,
  userId: string,
  dateUtc: string,
): boolean {
  const result = findHumanResult(event, userId);
  if (result === null) return false;
  if (!result.finishedRace || result.position !== 1) return false;

  const collection = FIRST_WIN_TODAY_COLLECTION;
  const key = firstWinTodayKey(userId, dateUtc);
  const composite = `${collection}/${key}/${userId}`;
  const existing = nk.storageRead([{ collection, key, userId }])[0];

  if (existing !== undefined && existing.value !== undefined) {
    // Already stamped today — confirm shape, then bail.
    return false;
  }

  const record: FirstWinTodayRecord = {
    schemaVersion: 1,
    userId,
    dateUtc,
    firstWinAt: event.timestampMs,
  };

  const obj: IStorageObject = {
    collection,
    key,
    userId,
    value: record as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
  };

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    try {
      nk.storageWrite([obj]);
      logger.info(
        'first_win_today stamped user=%s date=%s attempt=%d',
        userId, dateUtc, attempt + 1,
      );
      return true;
    } catch (e) {
      logger.warn(
        'first_win_today CAS conflict user=%s attempt=%d: %s',
        userId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
      // Re-read on conflict to check if someone else won the stamp.
      const recheck = nk.storageRead([{ collection, key, userId }])[0];
      if (recheck !== undefined && recheck.value !== undefined) return false;
    }
  }
  // Exhausted retries — give up. Don't throw; the subscriber must not crash.
  logger.error(
    'first_win_today CAS retries exhausted user=%s date=%s key=%s',
    userId, dateUtc, composite,
  );
  return false;
}

/**
 * Stamp every human finisher who finished rank=1. Bots are excluded.
 * Returns a `Map<userId, true>` containing ONLY the users who just
 * won their first race today. The map is meant to be assigned to
 * `event.firstWinOfDayFor` so the counter engine can gate
 * `requireFirstWinOfDay` filters.
 *
 * The output is intentionally sparse — absent keys mean "this user
 * already had their first win today, or didn't win at all". The
 * counter treats both cases the same way (`=== true` fails).
 */
export function stampFirstWinOfDayForAll(
  nk: INakama,
  logger: ILogger,
  event: RaceCompletedEvent,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of extractHumanResults(event)) {
    if (!r.finishedRace || r.position !== 1) continue;
    const userId = r.userId;
    const dateUtc = utcDateFromTimestamp(event.timestampMs);
    const stamped = stampFirstWinOfDay(nk, logger, event, userId, dateUtc);
    if (stamped) out[userId] = true;
  }
  return out;
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

/** Local UTC date helper — avoids an import cycle through core/time. */
function utcDateFromTimestamp(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}