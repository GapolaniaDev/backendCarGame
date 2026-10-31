// Phase 7 Chunk 5 — Lazy week-boundary reset.
//
// The Nakama 3.27 JS runtime does NOT expose `registerLeaderboardReset`
// (verified — see `nkruntime.d.ts`). We can't auto-zero the
// `clubs_metadata.weeklyPoints` field or the per-member
// `clubs_members/{clubId}/{userId}.weeklyContribution` field when the
// ISO week rolls; they live in storage, not on the leaderboard.
//
// Strategy:
//
//   The RPCs that show a club (`club_get`, `club_search`,
//   `club_members_list`, `club_mine`) and the race-completed subscriber
//   (before it credits points) call `ensureWeekBoundary`, which checks the
//   club's `clubs_week_meta/{clubId}.currentWeek` vs the current
//   `utcWeek(now)`. If they differ:
//
//     a. Compute the boundary week (`oldWeek = meta.currentWeek`).
//     b. Look up the global `clubs_week_reset/{oldWeek}` marker.
//
//        - Absent → we may be the FIRST lazy reset this week: read the
//          top rows of the `club_week` leaderboard (desc) for the FINISHED
//          week (Nakama keeps past weeks under their expiry, the Monday
//          00:00 UTC after the week, so the read passes it as
//          `overrideExpiry`: the default read would only see the new,
//          still empty, week), read the winning club's members and pick
//          the top-3 contributors by `weeklyContribution`; then CLAIM the
//          global marker (create-only) and only the claimer sends each a
//          claimable reward to the single inbox (`sendReward`, id
//          `club_week:<week>:<userId>`, so a re-run never duplicates).
//
//        - Present → rewards already sent (or no winner). Nothing to
//          do for the reward step.
//
//     c. Zero this club's `clubs_metadata.weeklyPoints`.
//     d. Zero every member's `weeklyContribution` (CAS per row).
//     e. Update `clubs_week_meta/{clubId}.currentWeek = currentWeek`.
//
//   On the very first call for a brand-new club (no meta row), seed
//   the meta row at `currentWeek` and skip the reset.
//
// `ensureWeekBoundary` is the only entry point the RPCs call.

import type { ILogger, INakama } from '../nkruntime';
import { sendReward } from '../liveops/inbox';
import { serverNowMs, utcWeek, utcWeekStartMs, WEEK_MS } from '../core/time';
import { readClubMembers, writeMemberUpdate } from './members_repo';
import { readClubMetadata, writeClubMetadataUpdate } from './clubs_repo';
import { CLUB_WEEK_LEADERBOARD_ID } from './leaderboard_init';
import {
  pickTopContributors,
  WEEKLY_REWARD_COINS,
  WEEKLY_REWARD_MAX_RECIPIENTS,
  WEEKLY_REWARD_TTL_MS,
  type ContributionRow,
} from './club_week';
import {
  currentWeekUtc,
  readClubWeekMeta,
  readClubWeekResetMarker,
  writeClubWeekMetaCreate,
  writeClubWeekMetaUpdate,
  writeClubWeekResetMarker,
  type ClubWeekMeta,
  type ClubWeekResetMarker,
} from './week_repo';

export interface ResetOutcome {
  /** True when the boundary crossed and we actually reset. */
  reset: boolean;
  /** The week the meta was last on before this call (== currentWeek when no reset). */
  oldWeek: string;
  /** The week the meta is now on (== currentWeek). */
  newWeek: string;
  /** The winning club id (top of the OLD week's leaderboard), or null. */
  winnerClubId: string | null;
  /** Users that received the weekly reward inbox to (deduplicated). */
  rewardedUserIds: string[];
  /** Reason string for no-op outcomes. */
  reason:
    | 'ok'
    | 'first_seen'
    | 'same_week'
    | 'reward_already_sent'
    | 'no_winner'
    | 'write_failed'
    | 'inbox_failed';
}

/**
 * Lazy weekly-reset check. The RPCs (`club_get`, `club_search`) call
 * this on every invocation so the FIRST caller after a Monday boundary
 * owns the reset (and the weekly reward), and every other caller is a
 * cheap no-op.
 *
 * Always safe to call — does not throw. Errors are caught and folded
 * into the returned `ResetOutcome` so the caller can decide whether to
 * surface anything to the client.
 */
export function ensureWeekBoundary(
  nk: INakama,
  logger: ILogger,
  clubId: string,
): ResetOutcome {
  const now = serverNowMs();
  const week = currentWeekUtc(now);
  const existing = readClubWeekMeta(nk, clubId);

  if (existing === null) {
    // First time we see this club — seed meta and skip the reset.
    const seed: ClubWeekMeta = {
      schemaVersion: 1,
      clubId,
      currentWeek: week,
      lastResetAt: now,
    };
    try {
      writeClubWeekMetaCreate(nk, seed);
      return { reset: false, oldWeek: week, newWeek: week, winnerClubId: null, rewardedUserIds: [], reason: 'first_seen' };
    } catch (e) {
      logger.warn(
        'club_week_reset seed failed clubId=%s: %s',
        clubId, e instanceof Error ? e.message : String(e),
      );
      return { reset: false, oldWeek: week, newWeek: week, winnerClubId: null, rewardedUserIds: [], reason: 'write_failed' };
    }
  }

  if (existing.record.currentWeek === week) {
    return {
      reset: false,
      oldWeek: existing.record.currentWeek,
      newWeek: week,
      winnerClubId: null,
      rewardedUserIds: [],
      reason: 'same_week',
    };
  }

  const oldWeek = existing.record.currentWeek;
  let winnerClubId: string | null = null;
  let rewardedUserIds: string[] = [];

  // Look up the global reset marker for the OLD week. If absent, we
  // own the reward step.
  const marker = readClubWeekResetMarker(nk, oldWeek);
  if (marker === null) {
    try {
      const reward = awardWeeklyReward(
        nk, logger, oldWeek, utcWeekStartMs(existing.record.lastResetAt), now,
      );
      winnerClubId = reward.winnerClubId;
      rewardedUserIds = reward.rewardedUserIds;
    } catch (e) {
      logger.warn(
        'club_week_reset reward failed week=%s: %s',
        oldWeek, e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    winnerClubId = marker.record.winnerClubId;
    rewardedUserIds = marker.record.rewardedUserIds;
  }

  // Zero this club's per-club state (metadata + members).
  try {
    zeroClubForNewWeek(nk, logger, clubId);
  } catch (e) {
    logger.warn(
      'club_week_reset zero failed clubId=%s: %s',
      clubId, e instanceof Error ? e.message : String(e),
    );
    return {
      reset: false,
      oldWeek,
      newWeek: oldWeek,
      winnerClubId,
      rewardedUserIds,
      reason: 'write_failed',
    };
  }

  // Bump the meta row.
  const nextMeta: ClubWeekMeta = {
    schemaVersion: 1,
    clubId,
    currentWeek: week,
    lastResetAt: now,
  };
  try {
    writeClubWeekMetaUpdate(nk, nextMeta, existing.version);
  } catch (e) {
    logger.warn(
      'club_week_reset meta update failed clubId=%s: %s',
      clubId, e instanceof Error ? e.message : String(e),
    );
    return {
      reset: false,
      oldWeek,
      newWeek: oldWeek,
      winnerClubId,
      rewardedUserIds,
      reason: 'write_failed',
    };
  }

  return {
    reset: true,
    oldWeek,
    newWeek: week,
    winnerClubId,
    rewardedUserIds,
    reason: 'ok',
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export interface WeeklyRewardResult {
  winnerClubId: string | null;
  rewardedUserIds: string[];
}

/**
 * Pick the winner of `week` (the top `club_week` record of THAT week: Nakama keeps past
 * weeks under their expiry, Monday 00:00 UTC after the week, in seconds) and reward its
 * top-3 contributors once (create-only marker). Exported for the service ticker (T-07).
 *
 * @param week ISO week being closed (`utcWeek` format); names the marker and the inbox ids.
 * @param weekStartMs Monday 00:00 UTC of that week (`utcWeekStartMs`).
 * @param nowMs Current server time, stamped on the marker and the rewards.
 */
export function awardWeeklyReward(
  nk: INakama,
  logger: ILogger,
  week: string,
  weekStartMs: number,
  nowMs: number,
): WeeklyRewardResult {
  // 1. Read the leaderboard top-N of the FINISHED week (the table is `desc`,
  //    so the first record is the winner); we'll re-read members below. 3.27
  //    takes `overrideExpiry` as the 5th argument, not a sort order, and a
  //    non-zero value must equal the records' `expiry_time` exactly: the
  //    Monday 00:00 UTC that closes the week, in seconds. Without it the
  //    call reads the current (new) week, which is empty at the boundary.
  const top = nk.leaderboardRecordsList(
    CLUB_WEEK_LEADERBOARD_ID,
    /* ownerIds */ [],
    /* limit */ WEEKLY_REWARD_MAX_RECIPIENTS,
    /* cursor */ '',
    /* overrideExpiry */ Math.floor((weekStartMs + WEEK_MS) / 1000),
  );
  const top1 = top.records[0];
  const winnerClubId = top1 !== undefined ? top1.ownerId : null;

  // 2. The winner club's top-3 contributors.
  const top3 = winnerClubId === null
    ? []
    : pickTopContributors(readClubMembers(nk, winnerClubId).map((m): ContributionRow => ({
      userId: m.record.userId,
      weeklyContribution: m.record.weeklyContribution,
      joinedAt: m.record.joinedAt,
    })));

  // 3. Claim the week. A concurrent reset that claimed it first owns
  //    the reward; we report what it recorded.
  const marker: ClubWeekResetMarker = {
    schemaVersion: 1,
    weekUtc: week,
    resetAt: nowMs,
    winnerClubId,
    rewardedUserIds: top3.map((m) => m.userId),
  };
  try {
    writeClubWeekResetMarker(nk, marker);
  } catch (e) {
    const theirs = readClubWeekResetMarker(nk, week);
    if (theirs !== null) {
      return { winnerClubId: theirs.record.winnerClubId, rewardedUserIds: theirs.record.rewardedUserIds };
    }
    logger.warn(
      'club_week_reset marker write failed week=%s: %s',
      week, e instanceof Error ? e.message : String(e),
    );
    return { winnerClubId, rewardedUserIds: [] };
  }

  // 4. Claimable rewards to the single inbox.
  const rewardedUserIds: string[] = [];
  for (const m of top3) {
    try {
      sendReward(
        nk,
        m.userId,
        'club_week_reward',
        { coins: WEEKLY_REWARD_COINS, note: 'Your club won the week — top contributor reward inside.' },
        `club_week:${week}:${m.userId}`,
        nowMs,
        nowMs + WEEKLY_REWARD_TTL_MS,
      );
      rewardedUserIds.push(m.userId);
    } catch (e) {
      logger.warn(
        'club_week_reset inbox failed user=%s: %s',
        m.userId, e instanceof Error ? e.message : String(e),
      );
    }
  }

  return { winnerClubId, rewardedUserIds };
}

/**
 * Service-ticker job (plan B2, D-07): reward last week's winning club once, even when no
 * club is opened. Returns a short summary for the tick log line.
 *
 * @returns `'already'` when the marker of last week exists, else `winner=<clubId|none>/rewarded=<n>`.
 */
export function runClubWeekTick(nk: INakama, logger: ILogger, nowMs: number): string {
  const weekStartMs = utcWeekStartMs(nowMs) - WEEK_MS;
  const week = utcWeek(weekStartMs);
  if (readClubWeekResetMarker(nk, week) !== null) return 'already';
  const r = awardWeeklyReward(nk, logger, week, weekStartMs, nowMs);
  return `winner=${r.winnerClubId ?? 'none'}/rewarded=${r.rewardedUserIds.length}`;
}

/**
 * Zero `weeklyPoints` on the metadata + `weeklyContribution` on every
 * member row. Best-effort per-member CAS — failures are logged and
 * dropped so the metadata always lands even when a member is gone.
 */
function zeroClubForNewWeek(
  nk: INakama,
  logger: ILogger,
  clubId: string,
): void {
  const meta = readClubMetadata(nk, clubId);
  if (meta !== null && meta.record.weeklyPoints !== 0) {
    const next = { ...meta.record, weeklyPoints: 0 };
    try {
      writeClubMetadataUpdate(nk, next, meta.version);
    } catch (e) {
      logger.warn(
        'club_week_reset metadata CAS failed clubId=%s: %s',
        clubId, e instanceof Error ? e.message : String(e),
      );
    }
  }

  const members = readClubMembers(nk, clubId);
  for (const m of members) {
    if (m.record.weeklyContribution === 0) continue;
    const next = { ...m.record, weeklyContribution: 0 };
    try {
      writeMemberUpdate(nk, next, m.version);
    } catch (e) {
      logger.warn(
        'club_week_reset member CAS failed clubId=%s userId=%s: %s',
        clubId, m.record.userId, e instanceof Error ? e.message : String(e),
      );
    }
  }
}