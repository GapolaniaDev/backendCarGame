// pass_claim and pass_buy_premium as single transactions (plan T-19;
// HT Prog-3, Prog-6; audit 06 6.4.5, 6.4.6).
//
// Before T-19 both read the record once and retried their CAS with that
// stale record and a fresh version, so a retry could overwrite a
// concurrent claim or XP grant; `pass_claim` wrote the claim before
// paying (a failed grant lost the reward) and `pass_buy_premium` charged
// before the flag. Now each attempt re-reads the record, re-validates
// it and commits the record CAS, the wallet movement and the garage
// delivery in ONE `moveWallet` (`nk.multiUpdate`): a lost CAS, a short
// balance or a failed delivery changes nothing, and the durable key
// makes a retry replay instead of paying twice.

import type { ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { moveWallet, walletGet, type WalletMove } from '../economy/wallet';
import { planGarageDelivery } from '../garage/delivery';
import { findLevel, getPassCatalog } from './catalog';
import { ensurePassRecord, passWrite, readPassRecord } from './pass_repo';
import { readSeasonCloseMarker } from './season';
import type { PassLevelReward, PassRecord } from './types';

const ATTEMPTS = 3;

/** What a claim delivered (the `granted` shape of pass_claim; `undelivered` is additive). */
export interface PassGrantResult {
  coins: number;
  gems: number;
  cosmetics: string[];
  /** Cosmetics not delivered: already owned, or missing from the catalog (also in `undelivered`). */
  skippedCosmetics: string[];
  cars: string[];
  skippedCars: string[];
}

export interface PassClaimOk {
  record: PassRecord;
  reward: PassLevelReward;
  granted: PassGrantResult;
  /** Reward items missing from the catalogs (`car:<id>` / `cosmetic:<id>`), logged as errors. */
  undelivered: string[];
  newBalance: { coins: number; gems: number };
}

/** Durable wallet key of a level claim (same shape as before T-19, so old claims replay). */
export function passClaimKey(userId: string, seasonId: string, level: number, track: 'free' | 'premium'): string {
  return `pass:${userId}:${seasonId}:lvl${level}-${track}`;
}

/** Durable wallet key of the premium purchase of a season. */
export function passPremiumKey(userId: string, seasonId: string): string {
  return `pass:premium:${userId}:${seasonId}`;
}

/**
 * Claim the `track` reward of `level`, once. Errors: NOT_FOUND (level),
 * CONFLICT (season closed, already claimed, CAS retries exhausted),
 * INVALID_RESULT (not enough XP), FORBIDDEN (premium not bought), or the
 * wallet's error with nothing written.
 */
export function claimPassLevel(
  nk: INakama,
  logger: ILogger,
  userId: string,
  level: number,
  track: 'free' | 'premium',
  nowMs: number,
): Resp<PassClaimOk> {
  const catalog = getPassCatalog();
  const levelDef = findLevel(catalog, level);
  if (levelDef === null) return err('NOT_FOUND', `pass level not in catalog: ${level}`);
  const reward: PassLevelReward = track === 'free' ? levelDef.freeReward : levelDef.premiumReward;
  if (readSeasonCloseMarker(nk, catalog.seasonId) !== null) return err('CONFLICT', 'pass season is closed');

  // Lazy-create so a brand-new user who jumps straight to pass_claim
  // gets the row (and the resulting "no XP yet" INVALID_RESULT).
  ensurePassRecord(nk, logger, userId);
  const key = passClaimKey(userId, catalog.seasonId, level, track);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    if (existing === null) return err('NOT_FOUND', 'pass record missing after lazy-create');
    const rec = existing.record;
    if (rec.seasonClosed) return err('CONFLICT', 'pass season is closed');
    if (rec.xp < levelDef.xpRequired) {
      return err('INVALID_RESULT', `not enough XP for level ${level} (${rec.xp}/${levelDef.xpRequired})`);
    }
    if (track === 'premium' && !rec.premiumPurchased) return err('FORBIDDEN', 'premium track not purchased');
    const claimedList = track === 'free' ? rec.claimedFree : rec.claimedPremium;
    if (claimedList.includes(level)) return err('CONFLICT', `level ${level} ${track} already claimed`);

    const next: PassRecord = track === 'free'
      ? { ...rec, claimedFree: [...rec.claimedFree, level] }
      : { ...rec, claimedPremium: [...rec.claimedPremium, level] };
    const delivery = planGarageDelivery(nk, userId, {
      carIds: reward.carId !== undefined ? [reward.carId] : [],
      cosmeticIds: reward.cosmeticId !== undefined ? [reward.cosmeticId] : [],
    }, nowMs);
    const changeset: Record<string, number> = {};
    if ((reward.coins ?? 0) > 0) changeset['coins'] = reward.coins as number;
    if ((reward.gems ?? 0) > 0) changeset['gems'] = reward.gems as number;
    const moves: WalletMove[] = Object.keys(changeset).length > 0
      ? [{ changeset, metadata: { reason: 'pass', sourceId: `${catalog.seasonId}:lvl${level}-${track}` } }]
      : [];
    const writes = [passWrite(next, existing.version)];
    if (delivery.garageWrite !== null) writes.push(delivery.garageWrite);

    const moved = moveWallet(nk, userId, key, moves, { extraWrites: writes });
    if (moved.ok) {
      if (moved.data.replayed) return err('CONFLICT', `level ${level} ${track} already claimed`);
      for (const missing of delivery.undelivered) {
        logger.error('pass_claim user=%s level=%d track=%s: reward item not in catalog: %s', userId, level, track, missing);
      }
      const missingCosmetics = delivery.undelivered.filter((x) => x.startsWith('cosmetic:')).map((x) => x.slice('cosmetic:'.length));
      const missingCars = delivery.undelivered.filter((x) => x.startsWith('car:')).map((x) => x.slice('car:'.length));
      return ok({
        record: next,
        reward,
        granted: {
          coins: changeset['coins'] ?? 0,
          gems: changeset['gems'] ?? 0,
          cosmetics: delivery.cosmetics,
          skippedCosmetics: [...delivery.ownedCosmetics, ...missingCosmetics],
          cars: delivery.cars,
          skippedCars: [...delivery.ownedCars, ...missingCars],
        },
        undelivered: delivery.undelivered,
        newBalance: moved.data.balance,
      });
    }
    if (moved.error.code !== 'CONFLICT') return moved;
    logger.warn('pass_claim CAS lost user=%s level=%d track=%s attempt=%d', userId, level, track, attempt);
  }
  return err('CONFLICT', `pass_claim CAS retries exhausted for level ${level}; nothing was paid, please retry`);
}

export interface PassPremiumOk {
  record: PassRecord;
  /** False when the season was already bought (nothing charged). */
  charged: boolean;
  newBalance: { coins: number; gems: number };
}

/**
 * Buy the premium track: the gem charge and `premiumPurchased` commit
 * together or not at all. Already bought → `charged: false`, no charge.
 * INSUFFICIENT_FUNDS (or any failure) leaves the record unchanged.
 */
export function buyPassPremium(nk: INakama, logger: ILogger, userId: string): Resp<PassPremiumOk> {
  const catalog = getPassCatalog();
  if (readSeasonCloseMarker(nk, catalog.seasonId) !== null) return err('CONFLICT', 'pass season is closed');
  ensurePassRecord(nk, logger, userId);
  const key = passPremiumKey(userId, catalog.seasonId);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const existing = readPassRecord(nk, userId, catalog.seasonId);
    if (existing === null) return err('NOT_FOUND', 'pass record missing after lazy-create');
    const rec = existing.record;
    if (rec.seasonClosed) return err('CONFLICT', 'pass season is closed');
    if (rec.premiumPurchased) return ok({ record: rec, charged: false, newBalance: walletGet(nk, userId) });

    const next: PassRecord = { ...rec, premiumPurchased: true };
    const moved = moveWallet(nk, userId, key, [{
      changeset: { gems: -catalog.premiumPriceGems },
      metadata: { reason: 'store', sourceId: `pass_premium_${catalog.seasonId}` },
    }], { extraWrites: [passWrite(next, existing.version)] });
    if (moved.ok) {
      if (moved.data.replayed) {
        const now = readPassRecord(nk, userId, catalog.seasonId);
        return ok({ record: now?.record ?? next, charged: false, newBalance: moved.data.balance });
      }
      return ok({ record: next, charged: true, newBalance: moved.data.balance });
    }
    if (moved.error.code !== 'CONFLICT') return moved;
    logger.warn('pass_buy_premium CAS lost user=%s attempt=%d', userId, attempt);
  }
  return err('CONFLICT', 'pass_buy_premium CAS retries exhausted; nothing was charged, please retry');
}
