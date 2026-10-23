// Reward senders → the player's inbox (plan T-17, audit 04 f3).
//
// Before T-17 these wrote to a separate `liveops_inbox` collection that
// no RPC read, so ranked season rewards could never be claimed and every
// other notice was lost. Both helpers now write the single `inbox`
// (`messages.ts`) that `inbox_list` / `inbox_claim` serve:
//   - `sendReward`: a CLAIMABLE reward the server has not paid (ranked
//     season rewards); `inbox_claim` pays it once;
//   - `sendNotice`: a reward the caller ALREADY delivered (tournament
//     prizes and refunds, event bonuses, IAP, ads, subscriptions);
//     claiming only acknowledges it, so nothing is paid twice.
// Message ids are the senders' deterministic reward ids, so re-running a
// sender is a no-op.

import type { INakama } from '../nkruntime';
import type { InboxRewardPayload as LegacyPayload, InboxRewardType } from '../ranked/types';
import { sendInbox, type InboxRewardPayload, type SendInboxResult } from './messages';

/** The pre-T-17 reward bucket, read only by the boot migration and the account purge. */
export const LEGACY_INBOX_COLLECTION = 'liveops_inbox';

const TITLES: Record<InboxRewardType, string> = {
  season_gold: 'Season reward: Gold',
  season_silver: 'Season reward: Silver',
  season_bronze: 'Season reward: Bronze',
  season_compensation: 'Season compensation',
  tournament_prize: 'Tournament prize',
  tournament_voided: 'Tournament cancelled',
  event_xp_applied: 'Event bonus',
  iap_purchase: 'Purchase delivered',
  iap_refund: 'Purchase refunded',
  subscription_expired: 'Subscription expired',
  subscription_expiring_soon: 'Subscription expiring soon',
  subscription_renewed: 'Subscription renewed',
  ad_reward: 'Ad reward',
  pass_season_end: 'Battle pass rewards',
};

export function inboxTitle(type: InboxRewardType): string {
  return TITLES[type] ?? 'Reward';
}

/** A sender payload: the legacy shape plus gems and one car. */
export type SenderPayload = LegacyPayload & { gems?: number; carId?: string };

/** A sender payload as an inbox reward (`cosmetics[]` → `cosmeticId` + `cosmeticIds`). */
export function toInboxReward(payload: SenderPayload): InboxRewardPayload | undefined {
  const out: InboxRewardPayload = {};
  if (typeof payload.coins === 'number' && payload.coins > 0) out.coins = payload.coins;
  if (typeof payload.gems === 'number' && payload.gems > 0) out.gems = payload.gems;
  if (typeof payload.carId === 'string' && payload.carId.length > 0) out.carId = payload.carId;
  const cosmetics = (payload.cosmetics ?? []).filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (cosmetics.length > 0) out.cosmeticId = cosmetics[0] as string;
  if (cosmetics.length > 1) out.cosmeticIds = cosmetics;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A claimable reward: `inbox_claim` pays it (once). */
export function sendReward(
  nk: INakama,
  userId: string,
  type: InboxRewardType,
  payload: SenderPayload,
  rewardId: string,
  nowMs: number,
  expiresAt: number | null = null,
): SendInboxResult {
  const reward = toInboxReward(payload);
  return sendInbox(nk, userId, {
    id: rewardId,
    kind: reward !== undefined ? 'reward' : 'system',
    title: inboxTitle(type),
    body: payload.note ?? '',
    ...(reward !== undefined ? { reward } : {}),
    source: type,
    ...(expiresAt !== null ? { expiresAt } : {}),
  }, nowMs);
}

/** A notice of a reward the caller already delivered: claiming pays nothing. */
export function sendNotice(
  nk: INakama,
  userId: string,
  type: InboxRewardType,
  payload: SenderPayload,
  noticeId: string,
  nowMs: number,
): SendInboxResult {
  const granted = toInboxReward(payload);
  return sendInbox(nk, userId, {
    id: noticeId,
    kind: 'system',
    title: inboxTitle(type),
    body: payload.note ?? '',
    ...(granted !== undefined ? { granted } : {}),
    source: type,
  }, nowMs);
}
