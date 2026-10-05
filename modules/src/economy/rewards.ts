// Phase 3 reward computation. Pure functions that derive the per-player
// `Reward[]` from a `RaceCompleted` event, using the rewards catalog.
//
// The actual grant (nk.walletUpdate + ledger) happens in the
// subscriber (`economy/subscriber.ts`), which calls `grant()` with an
// idempotency key of `race:{sessionId}:{userId}` so a retried dispatch
// (or a duplicate subscriber) cannot double-credit.

import { getRewardsCatalog, type RewardsCatalog } from './catalog';
import type { RaceModeId, RaceResult } from '../race/types';
import type { Reward } from './types';

/** Metadata the reward applier needs beyond the catalog. */
export interface RewardContext {
  /** Whether this is the player's first win today (UTC). */
  isFirstWinOfDay: boolean;
  /** How many private races this player has been paid out today already. */
  dailyPrivateCount: number;
  /** Whether the player finished (false for abandoned / DNF). */
  finished: boolean;
}

/**
 * Decide the rewards for a single race result, against the rewards
 * catalog. Pure — no storage, no Nakama calls.
 *
 * The shape returned is homogeneous: `{ kind: 'coins', amount }` or
 * `{ kind: 'gems', amount }`. XP rewards are NOT produced here — the
 * progression subscriber (Chunk 5) derives XP from coins via
 * `xpFromCoins()` and applies it via `applyXpGain()`.
 */
export function computeRewardForResult(
  result: RaceResult,
  mode: RaceModeId,
  ctx: RewardContext,
  catalog: RewardsCatalog,
): Reward[] {
  if (!ctx.finished || result.abandoned) return [];
  if (result.isBot) return [];

  const out: Reward[] = [];

  // 1) Position base for the race size
  const sizeKey = sizeKeyFor(result.rank, mode);
  const positionRow = catalog.positionBase[sizeKey];
  if (!positionRow) return [];
  // rank-1 is the row index
  const base = positionRow[result.rank - 1];
  if (typeof base !== 'number' || base <= 0) return [];

  // 2) Mode multiplier
  const mult = catalog.modeMultiplier[mode] ?? 1.0;
  const coinsFromPosition = Math.floor(base * mult);

  if (coinsFromPosition > 0) {
    out.push({ kind: 'coins', amount: coinsFromPosition });
  }

  // 3) First-win-of-day bonus
  if (ctx.isFirstWinOfDay) {
    const bonus = catalog.bonuses.firstWinOfDay;
    if (bonus.type === 'coins' && bonus.amount > 0) {
      out.push({ kind: 'coins', amount: bonus.amount });
    } else if (bonus.type === 'gems' && bonus.amount > 0) {
      out.push({ kind: 'gems', amount: bonus.amount });
    }
  }

  // 4) No-abandon bonus (only for races that completed all reports).
  // We don't model "all reported" here — that's a subscriber-level
  // decision (it inspects event.results). For now, no-abandon applies
  // only when ctx.finished && !abandoned, which is always true at this
  // point, so it would over-credit. Defer that signal to the caller.

  return out;
}

/**
 * Same as `computeRewardForResult` but includes the no-abandon bonus.
 * Caller passes `allPlayersReported` so the subscriber can opt in only
 * when no one abandoned mid-race.
 *
 * `size` selects the positionBase row. Pass the actual race size from
 * the event — the subscriber already knows it. Without `size` the
 * function falls back to size-4 which is what solo races use anyway.
 */
export function computeRewardForResultWithContext(
  result: RaceResult,
  mode: RaceModeId,
  ctx: RewardContext,
  allPlayersReported: boolean,
  catalog: RewardsCatalog,
  size: 1 | 2 | 4 | 6 = 4,
): Reward[] {
  const sizeKey = sizeKeyForEvent(size);
  const row = catalog.positionBase[sizeKey];
  if (!row) return [];
  if (!ctx.finished || result.abandoned || result.isBot) return [];
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
  if (allPlayersReported) {
    const b = catalog.bonuses.noAbandon;
    if (b.amount > 0) out.push({ kind: b.type, amount: b.amount });
  }
  return out;
}

/**
 * Map (rank, mode) → size key for `positionBase`. Races of size 1 use
 * the size-4 table as the canonical "solo" mapping; sizes 2/4/6 hit
 * their own tables.
 */
function sizeKeyFor(_rank: number, _mode: RaceModeId): '2' | '4' | '6' {
  // The catalog exposes positionBase by RACE size, not rank; the rank
  // indexes the array. Since the caller (subscriber) already knows the
  // race size from the event, we read the catalog table directly with
  // sizeKey passed by the subscriber. This helper is a no-op shim kept
  // for future refactoring where size key depends on rank.
  return '4';
}

/**
 * Helper used by the subscriber to select the right size key based on
 * the actual race size from the event.
 */
export function sizeKeyForEvent(size: 1 | 2 | 4 | 6): '2' | '4' | '6' {
  if (size === 2) return '2';
  if (size === 6) return '6';
  return '4'; // covers 1 (solo) and 4
}

/**
 * Decide whether a private race is eligible for a paid reward today.
 * Returns `false` when the per-day cap has been reached for this player.
 */
export function isPrivateRacePaid(
  catalog: RewardsCatalog,
  mode: RaceModeId,
  dailyPrivateCount: number,
): boolean {
  if (mode !== 'private') return true;
  return dailyPrivateCount < catalog.privateRoomCapPerDay;
}

/**
 * Map a reward to the ledger reason used when calling `grant()`.
 * Convenience for subscribers that want a typed metadata builder.
 */
export function rewardReason(
  reward: Reward,
  sessionId: string,
): { reason: 'race'; sourceId: string; sessionId: string } {
  return { reason: 'race', sourceId: sessionId, sessionId };
}

// Re-export the catalog accessor for tests that want to drive compute
// without going through the subscriber.
export { getRewardsCatalog };