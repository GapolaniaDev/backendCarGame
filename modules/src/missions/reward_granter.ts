// Phase 6 Chunk 5 — reward delivery for achievement (and future pass)
// claims. Decomposes `MissionReward`/`AchievementReward` into three
// sinks:
//
//   - coins / gems  → wallet.grant() (idempotent per sourceKey)
//   - cosmeticId    → garage.cosmeticsBag (CAS write; missing in
//                     catalog → log + skip, NEVER throws)
//   - xp            → ignored for now (no pass module yet — pass
//                     lands in Chunk 6+)
//
// XP wiring is intentionally out of scope: pass_claim (Chunk 7) will
// own pass XP. Today's missions and achievements only grant
// coins/gems/cosmetics.

import type { ILogger, INakama } from '../nkruntime';
import { grant } from '../economy/wallet';
import type { LedgerMetadata } from '../economy/types';
import type { MissionReward } from './types';
import {
  addCosmeticToBag,
  GARAGE_COLLECTION,
  readGarage,
  readGarageObject,
  writeGarageCreate,
  writeGarageUpdate,
} from '../garage/storage';
import type { Garage } from '../garage/types';
import { getCosmeticsCatalog } from '../garage/catalog';

export interface GrantAchievementRewardResult {
  /** Coins actually granted (0 if reward had no coins). */
  coins: number;
  /** Gems actually granted (0 if reward had no gems). */
  gems: number;
  /** Cosmetic ids successfully added to the garage bag. */
  cosmetics: string[];
  /** Cosmetic ids that were SKIPPED (e.g. not in catalog). */
  skippedCosmetics: string[];
}

/** Internal helper — returns the positive wallet portion of `reward`. */
function walletChangeset(reward: MissionReward): { coins?: number; gems?: number } {
  const out: { coins?: number; gems?: number } = {};
  if (typeof reward.coins === 'number' && reward.coins > 0) out.coins = reward.coins;
  if (typeof reward.gems === 'number' && reward.gems > 0) out.gems = reward.gems;
  return out;
}

/**
 * Grant the wallet portion of a reward. Idempotent on
 * `source:${userId}:${kind}:${refId}` — re-running for the same player
 * + same source does NOT double-pay. The grant helper itself logs and
 * skips on CAS conflict (returns the existing wallet view).
 */
function grantWallet(
  nk: INakama,
  userId: string,
  sourceKey: string,
  changeset: { coins?: number; gems?: number },
): void {
  if (Object.keys(changeset).length === 0) return;
  const meta: LedgerMetadata = {
    reason: 'achievement',
    sourceId: sourceKey,
  };
  grant(nk, userId, changeset, meta, sourceKey);
}

/**
 * Grant a cosmetic to the player's garage bag. Returns true on a fresh
 * append, false if the cosmetic was already in the bag (defensive
 * duplicate). Missing-from-catalog returns false and logs a warning.
 */
function grantCosmetic(
  nk: INakama,
  logger: ILogger,
  userId: string,
  cosmeticId: string,
): boolean {
  const catalog = getCosmeticsCatalog();
  const exists = catalog.items.some((c) => c.id === cosmeticId);
  if (!exists) {
    logger.warn(
      'reward_granter: cosmetic not in catalog id=%s user=%s — skipping',
      cosmeticId, userId,
    );
    return false;
  }

  const garageRead = readGarageObject(nk, userId);
  if (garageRead === null) {
    // Lazy-create the garage with the cosmetic already in the bag.
    // This should be rare (after-auth hook normally seeds it), but
    // we must not throw on a brand-new player whose garage row is
    // missing.
    const fresh: Garage = {
      schemaVersion: 1,
      userId,
      cars: [],
      cosmeticsBag: [cosmeticId],
      purchasedPacks: [],
      loadout: {
        activeCarId: '',
        equipped: {},
        stats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
      },
      lastDailyWin: 0,
      dailyPrivateCount: 0,
      dailyResetAt: Date.now(),
    };
    try {
      writeGarageCreate(nk, fresh);
      logger.info(
        'reward_granter: cosmetic granted via fresh-create id=%s user=%s',
        cosmeticId, userId,
      );
      return true;
    } catch (e) {
      logger.warn(
        'reward_granter: fresh garage create failed id=%s user=%s: %s',
        cosmeticId, userId,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  const garage = garageRead.value;
  if (garage.cosmeticsBag.includes(cosmeticId)) {
    // Already owned — no-op (idempotent).
    return false;
  }

  let next: Garage;
  try {
    next = addCosmeticToBag(garage, cosmeticId);
  } catch (e) {
    logger.warn(
      'reward_granter: addCosmeticToBag threw id=%s user=%s: %s',
      cosmeticId, userId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }

  try {
    writeGarageUpdate(nk, next, garageRead.version);
    return true;
  } catch (e) {
    logger.warn(
      'reward_granter: garage CAS failed id=%s user=%s: %s',
      cosmeticId, userId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Grant every applicable portion of a reward:
 *   - coins / gems via wallet.grant (idempotent)
 *   - cosmeticId (if present) via garage CAS
 *
 * `sourceKind` is `"achievement"` today; future callers (mission_claim
 * already uses inline grant — pass_claim will use this too) just pass
 * the appropriate kind so the idempotency keys namespace correctly.
 *
 * NEVER throws — cosmetic-not-in-catalog, garage CAS conflict, or
 * wallet idempotency replay are all logged + skipped. The caller
 * always gets a populated result object so analytics can decide what
 * actually landed.
 */
export function grantAchievementReward(
  nk: INakama,
  logger: ILogger,
  userId: string,
  reward: MissionReward,
  sourceKind: 'achievement' = 'achievement',
  refId: string,
): GrantAchievementRewardResult {
  const result: GrantAchievementRewardResult = {
    coins: 0,
    gems: 0,
    cosmetics: [],
    skippedCosmetics: [],
  };

  const changeset = walletChangeset(reward);
  if (Object.keys(changeset).length > 0) {
    const sourceKey = `${sourceKind}:${userId}:${refId}`;
    grantWallet(nk, userId, sourceKey, changeset);
    if (typeof changeset.coins === 'number') result.coins = changeset.coins;
    if (typeof changeset.gems === 'number') result.gems = changeset.gems;
  }

  if (typeof reward.cosmeticId === 'string' && reward.cosmeticId.length > 0) {
    const ok = grantCosmetic(nk, logger, userId, reward.cosmeticId);
    if (ok) result.cosmetics.push(reward.cosmeticId);
    else result.skippedCosmetics.push(reward.cosmeticId);
  }

  return result;
}

// Re-export so RPCs don't need to import garage storage directly.
export { GARAGE_COLLECTION };
// Helper exported for unit tests: read current garage (raw value) —
// mirrors `readGarage` re-export from garage/storage.
export { readGarage };