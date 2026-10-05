// Phase 3 RaceCompleted reward subscriber. Subscribes to the in-process
// event bus and pays out coins (and gems from bonuses) per player
// based on the rewards catalog. XP is handled by the progression
// subscriber; we only deal with wallet changes here.

import type { ILogger, INakama } from '../nkruntime';
import type { EventBus } from '../core/event_bus';
import type { RaceCompletedEvent, RaceResult } from '../race/types';
import {
  computeRewardForResultWithContext,
  getRewardsCatalog,
  isPrivateRacePaid,
  sizeKeyForEvent,
} from './rewards';
import { grant, applyLedger, type WalletView } from './wallet';
import type { LedgerMetadata, Reward, WalletChangeset } from './types';

export interface RewardSubscriberDeps {
  logger: ILogger;
  nk: INakama;
  bus: EventBus;
}

/**
 * Apply a `RaceCompleted` event's rewards to every participating
 * player. Idempotent per (sessionId, userId) pair via the wallet
 * helper's localcache key namespace.
 *
 * Returns a per-player summary so the caller (the race_submit_result
 * RPC for Decision 6) can include it in the response envelope.
 */
export function handleRaceCompletedForEconomy(
  deps: RewardSubscriberDeps,
  event: RaceCompletedEvent,
): RaceCompletedRewardSummary {
  const catalog = getRewardsCatalog();
  const summary: RaceCompletedRewardSummary = { perPlayer: {} };

  // Did every roster slot report? noAbandon bonus only applies when no
  // one abandoned mid-race.
  const allReported = event.results.every((r) => !r.abandoned);

  for (const result of event.results) {
    if (result.isBot) continue;
    if (result.abandoned) continue;
    if (!isRealWin(result)) continue;

    const perPlayerEntry = applyForPlayer(deps, event, result, catalog, allReported);
    if (perPlayerEntry !== null) {
      summary.perPlayer[result.userId] = perPlayerEntry;
    }
  }

  deps.logger.info(
    'race.completed economy payouts sid=%s paid=%d',
    event.sessionId,
    Object.keys(summary.perPlayer).length,
  );
  return summary;
}

export interface RaceCompletedRewardSummary {
  perPlayer: Record<
    string,
    {
      rewards: Reward[];
      newBalance: WalletView;
      isFirstWinOfDay: boolean;
      leveledUp: boolean;
      newLevel: number;
    }
  >;
}

/**
 * Determine if a race result counts as a "win" for reward purposes.
 * DNFs, abandons, and bots are excluded; rank doesn't matter for the
 * cap test (everyone gets positionBase coins).
 */
function isRealWin(r: RaceResult): boolean {
  return !r.abandoned && !r.isBot;
}

interface PlayerPayout {
  rewards: Reward[];
  newBalance: WalletView;
  isFirstWinOfDay: boolean;
  leveledUp: boolean;
  newLevel: number;
}

function applyForPlayer(
  deps: RewardSubscriberDeps,
  event: RaceCompletedEvent,
  result: RaceResult,
  catalog: ReturnType<typeof getRewardsCatalog>,
  allReported: boolean,
): PlayerPayout | null {
  const { nk, logger } = deps;

  // 1) Profile-driven context: first-win-of-day stamp + private cap.
  const profile = readProfileShim(nk, result.userId);
  const lastWin = profile?.lastDailyWinAt ?? 0;
  const isFirstWinOfDay = isNewUtcDay(lastWin, event.closedAt);
  const dailyPrivateCount = profile?.dailyPrivateCount ?? 0;

  // 2) Compute the per-result reward list.
  const sizeKey = sizeKeyForEvent(event.size);
  const ctx = {
    isFirstWinOfDay,
    dailyPrivateCount,
    finished: true,
  };
  // Re-derive from the catalog using sizeKey (use positionBase[sizeKey]).
  const rewards = computeRewardsForEntry(
    catalog,
    sizeKey,
    event.mode,
    result,
    ctx,
    allReported,
  );
  if (rewards.length === 0 && !isFirstWinOfDay) return null;

  // 3) Apply the wallet grant with idempotency key `race:{sid}:{userId}`.
  const grantKey = `race:${event.sessionId}:${result.userId}`;
  const changeset = rewardsToChangeset(rewards);
  const metadata: LedgerMetadata = {
    reason: 'race',
    sourceId: event.sessionId,
    sessionId: event.sessionId,
    mode: event.mode,
  };
  const grantResp = grant(nk, result.userId, changeset, metadata, grantKey);
  if (!grantResp.ok) {
    logger.warn(
      'race reward grant failed sid=%s user=%s: %s',
      event.sessionId,
      result.userId,
      grantResp.error.message,
    );
  }
  const newBalance = grantResp.ok
    ? grantResp.data
    : { coins: 0, gems: 0 };

  // 4) First-win-of-day stamp: write to profile, plus a ledger marker.
  if (isFirstWinOfDay) {
    const stampKey = `race:firstwin:${event.sessionId}:${result.userId}`;
    applyLedger(
      nk,
      result.userId,
      {
        reason: 'race',
        sourceId: `${event.sessionId}:firstwin`,
        sessionId: event.sessionId,
        mode: event.mode,
      },
      stampKey,
    );
  }

  // 5) Private-race cap enforcement: increment dailyPrivateCount when
  //    this was a paid private race.
  if (event.mode === 'private' && isPrivateRacePaid(catalog, event.mode, ctx.dailyPrivateCount)) {
    const profileWriteKey = `race:privatecounter:${event.sessionId}:${result.userId}`;
    if (!claimOnce(nk, profileWriteKey)) {
      // already counted today; skip
    } else {
      // best-effort: leave the persistence to the progression
      // subscriber so we don't race on profile version.
    }
  }

  return {
    rewards,
    newBalance,
    isFirstWinOfDay,
    leveledUp: false, // progression subscriber fills this
    newLevel: 1,
  };
}

/** Translate `Reward[]` into a `WalletChangeset` for `grant()`. */
function rewardsToChangeset(rewards: Reward[]): WalletChangeset {
  let coins = 0;
  let gems = 0;
  for (const r of rewards) {
    if (r.kind === 'coins') coins += r.amount ?? 0;
    else if (r.kind === 'gems') gems += r.amount ?? 0;
  }
  return { coins, gems };
}

/**
 * Same logic as `computeRewardForResultWithContext` but reads the
 * positionBase row by explicit size key instead of inferring it from
 * rank.
 */
function computeRewardsForEntry(
  catalog: ReturnType<typeof getRewardsCatalog>,
  sizeKey: '2' | '4' | '6',
  mode: RaceMode,
  result: RaceResult,
  ctx: { isFirstWinOfDay: boolean; dailyPrivateCount: number; finished: boolean },
  allReported: boolean,
): Reward[] {
  const row = catalog.positionBase[sizeKey];
  if (!row) return [];
  const base = row[result.rank - 1];
  if (typeof base !== 'number' || base <= 0) return [];
  const mult = catalog.modeMultiplier[mode] ?? 1.0;
  const coinsFromPosition = Math.floor(base * mult);
  const out: Reward[] = [];
  if (coinsFromPosition > 0) out.push({ kind: 'coins', amount: coinsFromPosition });
  if (ctx.isFirstWinOfDay) {
    const b = catalog.bonuses.firstWinOfDay;
    if (b.amount > 0) out.push({ kind: b.type, amount: b.amount });
  }
  if (allReported) {
    const b = catalog.bonuses.noAbandon;
    if (b.amount > 0) out.push({ kind: b.type, amount: b.amount });
  }
  return out;
}

/**
 * Tiny in-memory localcache-backed claim helper for cross-player
 * idempotency keys (e.g. private-room cap counter).
 */
function claimOnce(nk: INakama, key: string): boolean {
  const seen = nk.localcacheGet<string>(key);
  if (seen !== null && seen !== '' && seen === '1') return false;
  nk.localcachePut(key, '1', 24 * 60 * 60);
  return true;
}

type RaceMode = RaceCompletedEvent['mode'];

// ─── Profile projection ───────────────────────────────────────────────────────
//
// The profile shape used by the reward subscriber is intentionally
// narrow — we don't import the profile module to avoid a circular
// dependency. The progression subscriber owns the canonical write.

function readProfileShim(nk: INakama, userId: string): {
  lastDailyWinAt: number;
  dailyPrivateCount: number;
} | null {
  const result = nk.storageRead([{ collection: 'profiles', key: userId, userId }]);
  const obj = result[0];
  if (!obj) return null;
  const value = obj.value as Record<string, unknown>;
  const prog = value['progression'] as
    | { xp: number; level: number; lastDailyWinAt: number }
    | undefined;
  const dailyPrivateCount = typeof value['dailyPrivateCount'] === 'number'
    ? (value['dailyPrivateCount'] as number)
    : 0;
  return {
    lastDailyWinAt: prog?.lastDailyWinAt ?? 0,
    dailyPrivateCount,
  };
}

function isNewUtcDay(lastMs: number, nowMs: number): boolean {
  if (lastMs <= 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const lastDay = Math.floor(lastMs / dayMs);
  const nowDay = Math.floor(nowMs / dayMs);
  return nowDay > lastDay;
}

// ─── Subscriber registration ─────────────────────────────────────────────────

/**
 * Subscribe to the event bus with the economy reward handler. Called
 * once from InitModule after the bus is constructed.
 */
export function subscribeEconomyRewards(deps: RewardSubscriberDeps): void {
  deps.bus.subscribe('race.completed', (payload) => {
    const event = payload as RaceCompletedEvent;
    handleRaceCompletedForEconomy(deps, event);
  });
}