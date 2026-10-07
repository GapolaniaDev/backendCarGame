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
//   On every `club_get` (and `club_search`) call, the RPC checks the
//   club's `clubs_week_meta/{clubId}.currentWeek` vs the current
//   `utcWeek(now)`. If they differ:
//
//     a. Compute the boundary week (`oldWeek = meta.currentWeek`).
//     b. Look up the global `clubs_week_reset/{oldWeek}` marker.
//
//        - Absent → we are the FIRST lazy reset this week. We own the
//          weekly payment: read the top row of the `club_week`
//          leaderboard (desc), read the winning club's members, pick
//          the top-3 contributors by `weeklyContribution`, and send
//          each an inbox reward via `sendInbox`. Then we write the
//          global marker so no further club can double-send.
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
import { sendInbox } from '../liveops/messages';
import { serverNowMs } from '../core/time';
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
      const reward = awardWeeklyReward(nk, logger, oldWeek, now);
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

interface WeeklyRewardResult {
  winnerClubId: string | null;
  rewardedUserIds: string[];
}

/**
 * Pick the winner club (top row on `club_week`) and send an inbox
 * reward to its top-3 contributors. Writes the global reset marker so
 * subsequent lazy resets don't double-send.
 */
function awardWeeklyReward(
  nk: INakama,
  logger: ILogger,
  oldWeek: string,
  nowMs: number,
): WeeklyRewardResult {
  // 1. Read the leaderboard top-N. Use limit = 1 to identify the
  //    winner; we'll re-read members below.
  const top = nk.leaderboardRecordsList(
    CLUB_WEEK_LEADERBOARD_ID,
    /* ownerIds */ [],
    /* limit */ WEEKLY_REWARD_MAX_RECIPIENTS,
    /* cursor */ '',
    /* sortOrder */ 'desc',
  );
  const top1 = top.records[0];
  if (top1 === undefined) {
    // No records at all — no clubs scored this week. Write the marker
    // so future resets don't redo the lookup.
    writeClubWeekResetMarker(nk, {
      schemaVersion: 1,
      weekUtc: oldWeek,
      resetAt: nowMs,
      winnerClubId: null,
      rewardedUserIds: [],
    });
    return { winnerClubId: null, rewardedUserIds: [] };
  }
  const winnerClubId = top1.ownerId;

  // 2. Read the winner club's members.
  const members = readClubMembers(nk, winnerClubId);
  const contributionRows: ContributionRow[] = members.map((m) => ({
    userId: m.record.userId,
    weeklyContribution: m.record.weeklyContribution,
    joinedAt: m.record.joinedAt,
  }));
  const top3 = pickTopContributors(contributionRows);

  // 3. Send inbox to each top-3 member.
  const rewardedUserIds: string[] = [];
  for (const m of top3) {
    try {
      sendInbox(
        nk,
        m.userId,
        {
          id: nk.uuidv4(),
          kind: 'reward',
          title: 'Club week reward',
          body: 'Your club won the week — top contributor reward inside.',
          reward: { coins: WEEKLY_REWARD_COINS },
          expiresAt: nowMs + WEEKLY_REWARD_TTL_MS,
        },
        nowMs,
      );
      rewardedUserIds.push(m.userId);
    } catch (e) {
      logger.warn(
        'club_week_reset inbox failed user=%s: %s',
        m.userId, e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 4. Write the global reset marker.
  const marker: ClubWeekResetMarker = {
    schemaVersion: 1,
    weekUtc: oldWeek,
    resetAt: nowMs,
    winnerClubId,
    rewardedUserIds,
  };
  try {
    writeClubWeekResetMarker(nk, marker);
  } catch (e) {
    logger.warn(
      'club_week_reset marker write failed week=%s: %s',
      oldWeek, e instanceof Error ? e.message : String(e),
    );
  }

  return { winnerClubId, rewardedUserIds };
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