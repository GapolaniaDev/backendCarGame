// Phase 3 RaceCompleted progression subscriber. Awards XP for the race
// (derived from the coins the economy subscriber granted), updates the
// player's profile XP/level, and pays out level-up coin rewards via
// the wallet helper.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import {
  applyXpGain,
  buildLevelInfoFor,
  xpFromCoins,
} from './leveling';
import { getLevelsCatalog } from './catalog';
import { getRewardsCatalog } from '../economy/catalog';
import { grant, applyLedger } from '../economy/wallet';
import type { LedgerMetadata, Reward } from '../economy/types';
import {
  computeRewardForResultWithContext,
  sizeKeyForEvent,
} from '../economy/rewards';

export interface ProgressionSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

export interface RaceCompletedProgressionSummary {
  perPlayer: Record<
    string,
    {
      xpAwarded: number;
      newXp: number;
      newLevel: number;
      xpToNextLevel: number;
      leveledUp: boolean;
      levelUpRewards: Reward[];
      isFirstWinOfDay: boolean;
    }
  >;
}

export function handleRaceCompletedForProgression(
  deps: ProgressionSubscriberDeps,
  event: RaceCompletedEvent,
): RaceCompletedProgressionSummary {
  const levels = getLevelsCatalog();
  const rewards = getRewardsCatalog();
  const summary: RaceCompletedProgressionSummary = { perPlayer: {} };

  const allReported = event.results.every((r) => !r.abandoned);

  for (const result of event.results) {
    if (result.isBot) continue;
    if (result.abandoned) continue;
    if (!isRealWin(result)) continue;
    const entry = applyForPlayer(deps, event, result, levels, rewards, allReported);
    if (entry !== null) summary.perPlayer[result.userId] = entry;
  }

  deps.logger.info(
    'race.completed progression payouts sid=%s players=%d',
    event.sessionId,
    Object.keys(summary.perPlayer).length,
  );
  return summary;
}

function isRealWin(r: RaceResult): boolean {
  return !r.abandoned && !r.isBot;
}

function applyForPlayer(
  deps: ProgressionSubscriberDeps,
  event: RaceCompletedEvent,
  result: RaceResult,
  levels: ReturnType<typeof getLevelsCatalog>,
  rewards: ReturnType<typeof getRewardsCatalog>,
  allReported: boolean,
): RaceCompletedProgressionSummary['perPlayer'][string] | null {
  const { nk, logger } = deps;
  // 1) Read profile.
  const profileResp = nk.storageRead([{ collection: 'profiles', key: result.userId, userId: result.userId }]);
  const profileObj = profileResp[0];
  if (!profileObj) return null;
  const profile = profileObj.value as Record<string, unknown>;
  const progression = (profile['progression'] ?? { xp: 0, level: 1, lastDailyWinAt: 0 }) as {
    xp: number;
    level: number;
    lastDailyWinAt: number;
  };

  // 2) Compute XP from the coins the race would grant. Use the same
  //    formula the economy subscriber does so the XP delta matches the
  //    wallet movement.
  const sizeKey = sizeKeyForEvent(event.size);
  const ctx = {
    isFirstWinOfDay: isNewUtcDay(progression.lastDailyWinAt, event.closedAt),
    dailyPrivateCount: typeof profile['dailyPrivateCount'] === 'number'
      ? (profile['dailyPrivateCount'] as number)
      : 0,
    finished: true,
  };
  // We re-derive the rewards list via the same helper so XP matches
  // coins exactly.
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
  const xpGain = xpFromCoins(coinsForXp, rewards.xpDivisor, rewards.xpFloor);
  if (xpGain <= 0) return null;

  // 3) Apply the XP and persist.
  const gainResult = applyXpGain(levels, progression.xp, xpGain);
  const isFirstWinOfDay = ctx.isFirstWinOfDay;
  const nextProgression = {
    xp: gainResult.newXp,
    level: gainResult.newLevel,
    lastDailyWinAt: isFirstWinOfDay ? event.closedAt : progression.lastDailyWinAt,
  };
  const updated = {
    ...profile,
    progression: nextProgression,
    dailyPrivateCount: event.mode === 'private' && coinsForXp > 0
      ? (typeof profile['dailyPrivateCount'] === 'number' ? (profile['dailyPrivateCount'] as number) + 1 : 1)
      : (typeof profile['dailyPrivateCount'] === 'number' ? (profile['dailyPrivateCount'] as number) : 0),
    updatedAt: event.closedAt,
  };
  try {
    nk.storageWrite([
      {
        collection: 'profiles',
        key: result.userId,
        userId: result.userId,
        value: updated as Record<string, unknown>,
        permissionRead: 0,
        permissionWrite: 0,
        version: profileObj.version ?? '',
      },
    ]);
  } catch (e) {
    logger.warn(
      'profile XP update conflict sid=%s user=%s: %s',
      event.sessionId,
      result.userId,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }

  // 4) Apply level-up rewards via grant() with race-tied idempotency.
  const levelUpRewards: Reward[] = [];
  for (const lvlEntry of gainResult.levelUps) {
    if (lvlEntry.rewards.coins && lvlEntry.rewards.coins > 0) {
      levelUpRewards.push({ kind: 'coins', amount: lvlEntry.rewards.coins });
    }
    if (lvlEntry.rewards.gems && lvlEntry.rewards.gems > 0) {
      levelUpRewards.push({ kind: 'gems', amount: lvlEntry.rewards.gems });
    }
  }
  if (levelUpRewards.length > 0) {
    const levelGrantKey = `levelup:${event.sessionId}:${result.userId}`;
    const changeset = levelUpRewards.reduce<{ coins?: number; gems?: number }>(
      (acc, r) => {
        if (r.kind === 'coins') acc.coins = (acc.coins ?? 0) + (r.amount ?? 0);
        if (r.kind === 'gems') acc.gems = (acc.gems ?? 0) + (r.amount ?? 0);
        return acc;
      },
      {},
    );
    const metadata: LedgerMetadata = {
      reason: 'level',
      sourceId: `${event.sessionId}:${result.userId}`,
      sessionId: event.sessionId,
      mode: event.mode,
    };
    grant(nk, result.userId, changeset, metadata, levelGrantKey);
  }

  // 5) First-win-of-day ledger marker if applicable.
  if (isFirstWinOfDay) {
    applyLedger(
      nk,
      result.userId,
      {
        reason: 'race',
        sourceId: `${event.sessionId}:firstwin`,
        sessionId: event.sessionId,
        mode: event.mode,
      },
      `race:firstwin:${event.sessionId}:${result.userId}`,
    );
  }

  // 6) Build the response snapshot from the updated profile.
  const info = buildLevelInfoFor(gainResult.newXp);
  return {
    xpAwarded: xpGain,
    newXp: gainResult.newXp,
    newLevel: gainResult.newLevel,
    xpToNextLevel: info.xpToNextLevel,
    leveledUp: gainResult.leveledUp,
    levelUpRewards,
    isFirstWinOfDay,
  };
}

function isNewUtcDay(lastMs: number, nowMs: number): boolean {
  if (lastMs <= 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor(nowMs / dayMs) > Math.floor(lastMs / dayMs);
}

export function subscribeProgressionRewards(deps: ProgressionSubscriberDeps): void {
  deps.bus.subscribe('race.completed', (payload) => {
    const event = payload as RaceCompletedEvent;
    handleRaceCompletedForProgression(deps, event);
  });
}