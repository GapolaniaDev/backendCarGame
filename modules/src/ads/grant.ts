// Phase 9 Chunk 5 — Ad reward grant planner (pure).
//
// Decides whether a watch attempt is eligible based on the per-tier
// cooldown and the per-user daily cap. No I/O — the caller feeds in
// the persisted state and persists whatever the planner returns.
//
// `nextEligibleAtUtc` is the wall-clock instant the user can watch
// the same tier again. When the daily cap is the binding constraint
// (count >= cap), `nextEligibleAtUtc` is the next UTC midnight so
// the client can show a "come back tomorrow" message.
//
// Cap is per-user (D75), not per-tier. Cooldown is per-tier
// (different tiers have independent cooldowns so the user can
// always watch e.g. small if medium is on cooldown).

import type { AdRewardTier, AdTier } from './types';

export type PlanAdRewardResult =
  | { ok: true; nextEligibleAtUtc: number }
  | { ok: false; reason: 'COOLDOWN' | 'DAILY_CAP'; nextEligibleAtUtc: number };

export interface AdDailyKey {
  /** Cooldown until instant (ms). */
  cooldownUntilUtc: number;
  /** End-of-UTC-day instant (ms) — the cap resets at UTC midnight. */
  dailyCapUntilUtc: number;
}

export const MS_PER_DAY = 86_400_000;

export function utcDateKey(nowUtc: number): string {
  // YYYY-MM-DD slice of the UTC date.
  const d = new Date(nowUtc);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function endOfUtcDayUtc(nowUtc: number): number {
  const d = new Date(nowUtc);
  // Start of tomorrow 00:00 UTC.
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0,
  );
}

export function computeAdDailyKey(
  tier: AdRewardTier,
  nowUtc: number,
  lastWatchedAtUtc: number | null,
): AdDailyKey {
  const cooldownUntilUtc = lastWatchedAtUtc === null
    ? 0
    : lastWatchedAtUtc + tier.cooldownSeconds * 1000;
  const dailyCapUntilUtc = endOfUtcDayUtc(nowUtc);
  return { cooldownUntilUtc, dailyCapUntilUtc };
}

export function planAdReward(
  tier: AdRewardTier,
  nowUtc: number,
  lastWatchedAtUtc: number | null,
  dailyCount: number,
  dailyCap: number,
): PlanAdRewardResult {
  // Daily cap check first — if you've hit the cap for the day, the
  // tier doesn't matter. The cap resets at UTC midnight, so that's
  // the next eligible instant.
  if (dailyCount >= dailyCap) {
    return { ok: false, reason: 'DAILY_CAP', nextEligibleAtUtc: endOfUtcDayUtc(nowUtc) };
  }
  // Cooldown check.
  if (lastWatchedAtUtc !== null) {
    const cooldownUntilUtc = lastWatchedAtUtc + tier.cooldownSeconds * 1000;
    if (nowUtc < cooldownUntilUtc) {
      return { ok: false, reason: 'COOLDOWN', nextEligibleAtUtc: cooldownUntilUtc };
    }
  }
  return { ok: true, nextEligibleAtUtc: nowUtc };
}

/** Returns the cooldown end for a successful watch — used to write
 *  the new `ad_last_watched/{userId}/{tier}` row. */
export function nextCooldownEnd(tier: AdTier, cooldownSeconds: number, nowUtc: number): number {
  return nowUtc + cooldownSeconds * 1000;
}
