// Phase 9 Chunk 4 — Subscription scanner.
//
// Best-effort 5min tick that walks every iap_subscriptions row and:
//
//   1. Sends `subscription_expiring_soon` to active subs within 7d of
//      their term end. Idempotent via `warnedExpiring` flag.
//   2. Sends `subscription_expired` once a sub's expiresAtUtc is in
//      the past. Idempotent via `expiredNotified` flag.
//   3. Grants the monthly cosmetic + monthlyCoins if the sub is
//      active AND `monthlyCosmeticGranted === false`. Resets on
//      renewal (the RPC handles the reset).
//   4. Hard-deletes rows whose `cancelledAtUtc + 30d < nowUtc`
//      (so the storage list stays bounded).
//
// Best-effort: every loop iteration is wrapped in try/catch so a
// single bad row never halts the scanner. Limit is 1000 per tick —
// that's ~288k subs/day at 5min cadence.

import type { INakama, ILogger } from '../nkruntime';
import { sendReward } from '../liveops/inbox';
import { grant, type WalletView } from '../economy/wallet';
import { type Resp } from '../core/response';
import {
  readGarageObject,
  writeGarageCreate,
  writeGarageUpdate,
  defaultGarage,
  addCosmeticToBag,
} from '../garage/storage';
import {
  listAllSubscriptions,
  writeSubscriptionUpdate,
  deleteSubscription,
} from './subscription_repo';
import { findIapPack } from './catalog';
import {
  isActive,
  isExpired,
  shouldWarnExpiring,
  type IapSubscription,
} from './subscription';

const MS_PER_DAY = 86_400_000;
const HARD_DELETE_AFTER_CANCEL_DAYS = 30;
const WARNING_DAYS = 7;
const SCAN_LIMIT = 1000;

export interface SubscriptionScanStats {
  scanned: number;
  warned: number;
  expiredNotified: number;
  monthlyGrants: number;
  deleted: number;
  errors: number;
}

export function scanOnce(nk: INakama, logger: ILogger, nowUtc: number): SubscriptionScanStats {
  const stats: SubscriptionScanStats = {
    scanned: 0, warned: 0, expiredNotified: 0, monthlyGrants: 0, deleted: 0, errors: 0,
  };
  let rows: Array<{ userId: string; version: string; value: IapSubscription }> = [];
  try {
    rows = listAllSubscriptions(nk, SCAN_LIMIT);
  } catch (e) {
    logger.warn('subscription_scanner: list failed: %s', e instanceof Error ? e.message : String(e));
    stats.errors += 1;
    return stats;
  }
  for (const row of rows) {
    stats.scanned += 1;
    try {
      const sub = row.value;

      // 1. Expiring-soon warning.
      if (shouldWarnExpiring(sub, nowUtc, WARNING_DAYS)) {
        const remainingDays = Math.max(0, Math.ceil((sub.expiresAtUtc - nowUtc) / MS_PER_DAY));
        const rewardId = `sub_expiring:${row.userId}:${sub.expiresAtUtc}`;
        try {
          sendReward(
            nk,
            row.userId,
            'subscription_expiring_soon',
            {
              note: `Subscription "${sub.packId}" expires in ${remainingDays} day(s)`,
              coins: 0,
            },
            rewardId,
            nowUtc,
          );
          const updated: IapSubscription = { ...sub, warnedExpiring: true };
          writeSubscriptionUpdate(nk, updated, row.version);
          stats.warned += 1;
        } catch (e) {
          logger.warn('subscription_scanner: warn failed for %s: %s', row.userId, e instanceof Error ? e.message : String(e));
          stats.errors += 1;
          continue; // Don't process monthly/expired for this row if the warn write raced.
        }
        // Re-read after the warn-write so the rest of this iteration
        // uses the updated version. Cheap because storageRead hits the
        // local cache.
        const refreshed = listAllSubscriptions(nk, SCAN_LIMIT).find((r) => r.userId === row.userId);
        if (!refreshed) continue;
        Object.assign(sub, refreshed.value);
      }

      // 2. Expired notification.
      if (isExpired(sub, nowUtc) && sub.expiredNotified !== true) {
        const rewardId = `sub_expired:${row.userId}:${sub.expiresAtUtc}`;
        try {
          sendReward(
            nk,
            row.userId,
            'subscription_expired',
            {
              note: `Subscription "${sub.packId}" expired`,
              coins: 0,
            },
            rewardId,
            nowUtc,
          );
          const refreshed = listAllSubscriptions(nk, SCAN_LIMIT).find((r) => r.userId === row.userId);
          const currentVersion = refreshed?.version ?? row.version;
          writeSubscriptionUpdate(nk, { ...sub, expiredNotified: true }, currentVersion);
          stats.expiredNotified += 1;
        } catch (e) {
          logger.warn('subscription_scanner: expired failed for %s: %s', row.userId, e instanceof Error ? e.message : String(e));
          stats.errors += 1;
        }
        continue;
      }

      // 3. Monthly grant if active + not yet applied.
      if (isActive(sub, nowUtc) && !sub.monthlyCosmeticGranted) {
        const pack = findIapPack(sub.packId);
        if (pack && pack.kind === 'subscription') {
          let touched = false;
          if (pack.monthlyCosmeticId !== undefined) {
            const obj = readGarageObject(nk, row.userId);
            if (obj === null) {
              const g = defaultGarage(row.userId, nowUtc);
              writeGarageCreate(nk, addCosmeticToBag(g, pack.monthlyCosmeticId));
            } else if (!obj.value.cosmeticsBag.includes(pack.monthlyCosmeticId)) {
              writeGarageUpdate(nk, addCosmeticToBag(obj.value, pack.monthlyCosmeticId), obj.version);
            }
            touched = true;
          }
          if (pack.monthlyCoins > 0) {
            const monthlyKey = `iap_subscription_monthly_scanner:${row.userId}:${sub.expiresAtUtc}`;
            const r2: Resp<WalletView> = grant(
              nk,
              row.userId,
              { coins: pack.monthlyCoins },
              { reason: 'iap', sourceId: `sub_monthly_scanner:${pack.id}:${sub.expiresAtUtc}` },
              monthlyKey,
            );
            if (r2.ok) touched = true;
          }
          if (touched) {
            // Re-read to get the current version, then update.
            const refreshed = listAllSubscriptions(nk, SCAN_LIMIT).find((r) => r.userId === row.userId);
            const v = refreshed?.version ?? row.version;
            writeSubscriptionUpdate(nk, { ...sub, monthlyCosmeticGranted: true }, v);
            stats.monthlyGrants += 1;
          }
        }
      }

      // 4. Hard-delete cancelled + expired for >30d.
      if (sub.cancelledAtUtc !== undefined
          && isExpired(sub, nowUtc)
          && nowUtc - sub.expiresAtUtc > HARD_DELETE_AFTER_CANCEL_DAYS * MS_PER_DAY) {
        try {
          deleteSubscription(nk, row.userId, row.version);
          stats.deleted += 1;
        } catch (e) {
          logger.warn('subscription_scanner: delete failed for %s: %s', row.userId, e instanceof Error ? e.message : String(e));
          stats.errors += 1;
        }
      }
    } catch (e) {
      logger.warn('subscription_scanner: row %s failed: %s', row.userId, e instanceof Error ? e.message : String(e));
      stats.errors += 1;
    }
  }
  return stats;
}

let SCAN_HANDLE: ReturnType<typeof setInterval> | null = null;

export function startSubscriptionScanner(
  nk: INakama,
  logger: ILogger,
  intervalMs: number = 5 * 60_000,
): void {
  if (SCAN_HANDLE !== null) return; // idempotent
  // See tournaments/scanner.ts for the 3.27 setInterval gap note.
  if (typeof setInterval !== 'function') {
    logger.warn(
      'subscription_scanner: setInterval not available in this runtime (Nakama 3.27 JS gap); running once at boot only.',
    );
    try {
      const nowUtc = Date.now();
      const stats = scanOnce(nk, logger, nowUtc);
      logger.info(
        'subscription_scanner initial tick: scanned=%d warned=%d expired=%d grants=%d deleted=%d errors=%d',
        stats.scanned, stats.warned, stats.expiredNotified, stats.monthlyGrants, stats.deleted, stats.errors,
      );
    } catch (e) {
      logger.warn('subscription_scanner: initial tick failed: %s', e instanceof Error ? e.message : String(e));
    }
    return;
  }
  SCAN_HANDLE = setInterval(() => {
    try {
      const nowUtc = Date.now();
      const stats = scanOnce(nk, logger, nowUtc);
      if (stats.scanned > 0) {
        logger.info(
          'subscription_scanner: scanned=%d warned=%d expired=%d grants=%d deleted=%d errors=%d',
          stats.scanned, stats.warned, stats.expiredNotified, stats.monthlyGrants, stats.deleted, stats.errors,
        );
      }
    } catch (e) {
      logger.warn('subscription_scanner: tick failed: %s', e instanceof Error ? e.message : String(e));
    }
  }, intervalMs);
}

export function stopSubscriptionScanner(): void {
  if (SCAN_HANDLE !== null) {
    clearInterval(SCAN_HANDLE);
    SCAN_HANDLE = null;
  }
}
