// Phase 8 Chunk 8 — RaceCompleted subscriber for live events.
//
// On every race close, for each human finisher:
//   1. Recompute the base XP using the same `xpFromCoins(coinsForXp)`
//      rule the progression subscriber applies (so the bonus tracks
//      the same number the player just earned).
//   2. Resolve the current `xp_double` multiplier via the events
//      catalog (defaults to 1× when none active).
//   3. Grant the bonus = baseXp * (multiplier - 1) as a coin
//      `wallet.grant` with reason `event`. The xp-bonus is paid in
//      coins to avoid touching the XP ledger again (the progression
//      subscriber already applied the base XP to the profile).
//   4. Send an inbox `event_xp_applied` so the client can show a
//      notification.
//
// Idempotency: `event_xp:{raceId}:{userId}` (race-tied, so a second
// publish of the same race never double-pays). The subscriber fires
// AFTER tournaments so a hidden cheater's race is never rewarded.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import { resolveXpMultiplier } from './multiplier';
import {
  computeRewardForResultWithContext,
  sizeKeyForEvent,
} from '../economy/rewards';
import { getRewardsCatalog } from '../economy/catalog';
import { xpFromCoins } from '../progression/leveling';
import { grant } from '../economy/wallet';
import { sendReward } from '../liveops/inbox';

export interface EventsSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface EventBonusRow {
  /** Race's base XP, after the progression rule — i.e. what the player just earned. */
  baseXp: number;
  /** Multiplier applied (>= 1). */
  multiplier: number;
  /** Coin grant issued (= baseXp * (multiplier - 1)). */
  bonusCoins: number;
}

export interface EventsSubscriberSummary {
  perPlayer: Record<string, EventBonusRow>;
}

export function handleRaceCompletedForEvents(
  deps: EventsSubscriberDeps,
  event: RaceCompletedEvent,
): EventsSubscriberSummary {
  const summary: EventsSubscriberSummary = { perPlayer: {} };
  const nowUtc = event.closedAt;
  const multiplier = resolveXpMultiplier(nowUtc);
  if (multiplier <= 1) {
    return summary;
  }

  const rewards = getRewardsCatalog();
  const allReported = event.results.every((r) => !r.abandoned);

  for (const result of event.results) {
    if (result.isBot) continue;
    if (result.abandoned) continue;
    if (typeof result.userId !== 'string' || result.userId.length === 0) continue;
    const baseXp = computeBaseXpForResult(deps, event, result, rewards, allReported);
    if (baseXp <= 0) continue;
    const bonusCoins = Math.max(0, Math.floor(baseXp * (multiplier - 1)));
    if (bonusCoins <= 0) continue;

    const idempKey = `event_xp:${event.sessionId}:${result.userId}`;
    const grantResp = grant(
      deps.nk,
      result.userId,
      { coins: bonusCoins },
      { reason: 'event', sourceId: `event_xp_double:${event.sessionId}` },
      idempKey,
    );
    if (!grantResp.ok) {
      deps.logger.error(
        'event_xp grant failed sid=%s uid=%s: %s',
        event.sessionId,
        result.userId,
        grantResp.error.message,
      );
      continue;
    }

    // Inbox notification — best-effort, never-throws (the bus wraps the
    // call but we also try/catch so a single bad payload doesn't kill
    // the loop).
    try {
      sendReward(
        deps.nk,
        result.userId,
        'event_xp_applied',
        {
          coins: bonusCoins,
          note: `Event XP bonus x${multiplier.toFixed(1)}`,
        },
        `event_xp_applied:${event.sessionId}:${result.userId}`,
        nowUtc,
      );
    } catch (e) {
      deps.logger.error(
        'event_xp inbox send failed sid=%s uid=%s: %s',
        event.sessionId,
        result.userId,
        e instanceof Error ? e.message : String(e),
      );
    }

    summary.perPlayer[result.userId] = { baseXp, multiplier, bonusCoins };
  }

  deps.logger.info(
    'race.completed events payouts sid=%s multiplier=%d players=%d',
    event.sessionId,
    multiplier,
    Object.keys(summary.perPlayer).length,
  );
  return summary;
}

function computeBaseXpForResult(
  deps: EventsSubscriberDeps,
  event: RaceCompletedEvent,
  result: RaceResult,
  rewards: ReturnType<typeof getRewardsCatalog>,
  allReported: boolean,
): number {
  const profile = deps.nk.storageRead([
    { collection: 'profiles', key: result.userId, userId: result.userId },
  ])[0];
  if (!profile) return 0;
  const profileObj = profile.value as Record<string, unknown>;
  const progression = (profileObj['progression'] ?? { xp: 0, level: 1, lastDailyWinAt: 0 }) as {
    lastDailyWinAt: number;
  };

  // We re-derive the reward list with the same helper the progression
  // subscriber uses so the bonus tracks the XP the player just
  // earned. The progression subscriber may have ALREADY advanced
  // `lastDailyWinAt`; in that case the first-win bonus is consumed and
  // `isFirstWinOfDay` re-evaluates to false here. The accepted
  // drift is the 50-coin first-win-of-day bonus — the events bonus
  // is the (multiplier-1) × XP delta, which dwarfs it.
  const ctx = {
    isFirstWinOfDay: isNewUtcDay(progression.lastDailyWinAt, event.closedAt),
    dailyPrivateCount:
      typeof profileObj['dailyPrivateCount'] === 'number'
        ? (profileObj['dailyPrivateCount'] as number)
        : 0,
    finished: true,
  };
  const rewardList = computeRewardForResultWithContext(
    result,
    event.mode,
    ctx,
    allReported,
    rewards,
    event.size,
  );
  let coinsForXp = 0;
  for (const r of rewardList) if (r.kind === 'coins') coinsForXp += r.amount ?? 0;
  return xpFromCoins(coinsForXp, rewards.xpDivisor, rewards.xpFloor);
}

function isNewUtcDay(lastMs: number, nowMs: number): boolean {
  if (lastMs <= 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor(nowMs / dayMs) > Math.floor(lastMs / dayMs);
}

export function subscribeEvents(deps: EventsSubscriberDeps): void {
  deps.bus.subscribe('RaceCompleted', (payload) => {
    const event = payload as RaceCompletedEvent;
    try {
      handleRaceCompletedForEvents(deps, event);
    } catch (e) {
      deps.logger.error(
        'events subscriber failed sid=%s: %s',
        event.sessionId,
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}
