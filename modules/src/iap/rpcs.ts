// Phase 9 Chunk 3 — `iap_purchase` RPC + content grant.
//
// The single public IAP entry point. Bypasses maintenance (a player
// who paid Apple/Google in maintenance mode must still be able to
// redeem the entitlement; this matches the account_link /
// account_delete precedent). The flow:
//
//   1. Validate input (platform/productId/receiptData/transactionId).
//   2. Look up the pack by the platform-specific productId.
//   3. Anti-fraud: the store transaction already belongs to another
//      account → CONFLICT (+ fraud flag).
//   4. Idempotency: this user's purchase row for the transaction
//      → return its content with `idempotent: true`.
//   5. Verify the receipt (`verifyReceipt`, settings from `runtime.env`).
//   6. Decide first-time bonus (read iap_first_purchase).
//   7. Deliver in ONE wallet movement (T-24, plan T-11): coins, the
//      garage cosmetic, the subscription record, the purchase row, the
//      first-purchase marker and the transaction index commit together,
//      under the durable key `iap_purchase:{platform}:{transactionId}` of
//      this user. A retry — also after a restart — replays the stored
//      response instead of delivering again; a lost CAS re-reads and
//      retries; two accounts with one receipt cannot both commit.
//   8. Inbox notice `iap_purchase` (the delivery is already done).
//   9. Return success.
//
// Before T-24 every step wrote on its own (a failure in the middle kept
// the coins without the purchase row, or the reverse) and the
// idempotency key was the transaction id alone.

import type { IContext, ILogger, INakama, IStorageObject } from '../nkruntime';
import { ok, err } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { moveWallet, walletGet, type WalletMove, type WalletView } from '../economy/wallet';
import { addCosmeticToBag, defaultGarage, garageWrite, readGarageObject } from '../garage/storage';
import { sendNotice } from '../liveops/inbox';
import { emit } from '../core/admin/analytics';
import { findIapPackByProductId } from './catalog';
import { verifyReceipt } from './verify';
import { iapConfigFromEnv } from './config';
import {
  planGrant,
  totalCoins,
  type IapGrantPlan,
} from './grant';
import {
  readPurchaseByTxId,
  findPurchaseAcrossUsers,
  purchaseWrite,
  readFirstPurchase,
  firstPurchaseWrite,
  readTransactionOwner,
  transactionOwnerWrite,
  type PurchaseRecord,
} from './purchase_repo';
import { readSubscriptionWithVersion, subscriptionWrite } from './subscription_repo';
import { writeFraudFlagCreate, readFraudFlag } from './admin_repo';
import type { IapSubscription } from './subscription';
import type { IapPack, IapPlatform, IapVerificationError } from './types';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

/** Attempts of the delivery transaction when a CAS (garage, subscription) is lost. */
const DELIVERY_ATTEMPTS = 3;

function fail(code: ErrorCode, message: string, details?: unknown): string {
  return JSON.stringify(err(code, message, details));
}

export interface IapPurchaseInput {
  platform: IapPlatform;
  productId: string;
  receiptData: string;
  transactionId: string;
  /** Subscriptions only — defaults to `transactionId` when missing. */
  originalTransactionId?: string;
}

export interface IapPurchaseContent {
  coinsGranted: number;
  firstTimeBonus: number;
  cosmeticId?: string;
  subscriptionExpiresAtUtc?: number;
}

export interface IapPurchaseOutput {
  purchaseId: string;
  packId: string;
  content: IapPurchaseContent;
  /** `{coins, gems}` like every money RPC (T-12; was the coins number). */
  newBalance?: WalletView;
  newSubscriptionExpiresAtUtc?: number;
  idempotent: boolean;
}

function asInput(raw: Record<string, unknown>): IapPurchaseInput | { error: string } {
  const platform = raw['platform'];
  const productId = raw['productId'];
  const receiptData = raw['receiptData'];
  const transactionId = raw['transactionId'];
  const originalTransactionId = raw['originalTransactionId'];
  if (typeof platform !== 'string' || (platform !== 'apple' && platform !== 'google')) {
    return { error: 'platform must be apple|google' };
  }
  if (typeof productId !== 'string' || productId.length === 0) {
    return { error: 'productId is required' };
  }
  if (typeof receiptData !== 'string' || receiptData.length === 0) {
    return { error: 'receiptData is required' };
  }
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    return { error: 'transactionId is required' };
  }
  const out: IapPurchaseInput = {
    platform,
    productId,
    receiptData,
    transactionId,
  };
  if (typeof originalTransactionId === 'string' && originalTransactionId.length > 0) {
    out.originalTransactionId = originalTransactionId;
  }
  return out;
}

/** Durable idempotency key of a purchase: per user (the `idem` row) and store transaction. */
export function purchaseIdempotencyKey(platform: IapPlatform, transactionId: string): string {
  return `iap_purchase:${platform}:${transactionId}`;
}

/** Ledger source ids must fit 200 bytes with the reason: long tokens are hashed. */
function shortTxId(nk: INakama, transactionId: string): string {
  return transactionId.length <= 64 ? transactionId : nk.sha256Hash(transactionId).slice(0, 32);
}

/** The other account that already consumed this transaction, if any. */
function otherOwner(nk: INakama, userId: string, input: IapPurchaseInput): { userId: string; packId: string } | null {
  const owner = readTransactionOwner(nk, input.platform, input.transactionId);
  if (owner !== null) {
    if (owner.userId === userId) return null;
    const theirs = readPurchaseByTxId(nk, owner.userId, input.transactionId);
    return { userId: owner.userId, packId: theirs?.packId ?? '' };
  }
  // Purchases delivered before the T-24 index only have their row.
  const legacy = findPurchaseAcrossUsers(nk, input.transactionId);
  if (legacy && legacy.userId !== userId) return { userId: legacy.userId, packId: legacy.record.packId };
  return null;
}

function replayOutput(nk: INakama, userId: string, transactionId: string, existing: PurchaseRecord): IapPurchaseOutput {
  return {
    purchaseId: transactionId,
    packId: existing.packId,
    content: packContent(existing.content),
    newBalance: walletGet(nk, userId),
    ...(existing.content.expiresAtUtc !== undefined
      ? { newSubscriptionExpiresAtUtc: existing.content.expiresAtUtc }
      : {}),
    idempotent: true,
  };
}

interface DeliveryPlan {
  plan: IapGrantPlan;
  isFirstTime: boolean;
  moves: WalletMove[];
  writes: IStorageObject[];
  subscription?: { sub: IapSubscription; isRenewal: boolean };
}

/** Everything one purchase delivers, from fresh reads (re-planned after a lost CAS). */
function planDelivery(
  nk: INakama,
  userId: string,
  pack: IapPack,
  input: IapPurchaseInput,
  nowUtc: number,
): DeliveryPlan {
  const isFirstTime = readFirstPurchase(nk, userId, pack.id) === null;
  const plan = planGrant(pack, isFirstTime, nowUtc);
  const tx = shortTxId(nk, input.transactionId);
  const moves: WalletMove[] = [];
  const writes: IStorageObject[] = [];
  if (totalCoins(plan) > 0) {
    moves.push({ changeset: { coins: totalCoins(plan) }, metadata: { reason: 'iap', sourceId: `iap:${pack.id}:${tx}` } });
  }

  const cosmetics: string[] = [];
  if (plan.cosmeticId !== undefined) cosmetics.push(plan.cosmeticId);

  let subscription: DeliveryPlan['subscription'];
  if (pack.kind === 'subscription' && plan.expiresAtUtc !== undefined) {
    const originalTxId = input.originalTransactionId ?? input.transactionId;
    const existing = readSubscriptionWithVersion(nk, userId);
    let sub: IapSubscription;
    let isRenewal = false;
    if (existing === null || existing.value.originalTransactionId !== originalTxId) {
      // First activation OR a new sub replacing the old one. The old sub
      // (if any) expires on its own expiresAtUtc — no explicit cancel.
      sub = {
        userId,
        packId: pack.id,
        platform: input.platform,
        originalTransactionId: originalTxId,
        latestTransactionId: input.transactionId,
        activatedAtUtc: nowUtc,
        expiresAtUtc: plan.expiresAtUtc,
        autoRenewing: true,
        renewalHistory: [],
        monthlyCosmeticGranted: false,
      };
    } else {
      // Renewal: same originalTransactionId, bump expiresAtUtc.
      isRenewal = true;
      const nextExpiry = existing.value.expiresAtUtc + pack.durationDays * 86_400_000;
      sub = {
        ...existing.value,
        latestTransactionId: input.transactionId,
        expiresAtUtc: nextExpiry,
        autoRenewing: true,
        monthlyCosmeticGranted: false,
        renewalHistory: [
          ...existing.value.renewalHistory,
          {
            transactionId: input.transactionId,
            renewedAtUtc: nowUtc,
            expiresAtUtc: nextExpiry,
            monthlyCoinsGranted: plan.monthlyCoins ?? 0,
          },
        ],
      };
    }
    // The cycle's monthly grant (cosmetic + coins) goes with the purchase,
    // so the subscription scanner sees it granted.
    if (plan.monthlyCosmeticId !== undefined) cosmetics.push(plan.monthlyCosmeticId);
    if ((plan.monthlyCoins ?? 0) > 0) {
      moves.push({
        changeset: { coins: plan.monthlyCoins ?? 0 },
        metadata: { reason: 'iap', sourceId: `sub_monthly:${pack.id}:${sub.expiresAtUtc}` },
      });
    }
    sub.monthlyCosmeticGranted = true;
    writes.push(subscriptionWrite(sub, existing?.version ?? '*'));
    subscription = { sub, isRenewal };
  }

  // The cosmetic ids of iap_packs.json go to the bag as they are, like
  // before T-24: none of them is in cosmetics.json today (a content
  // decision), and a paid purchase must not drop what it sold.
  if (cosmetics.length > 0) {
    const read = readGarageObject(nk, userId);
    let garage = read?.value ?? defaultGarage(userId, nowUtc);
    const before = garage;
    for (const id of cosmetics) {
      if (!garage.cosmeticsBag.includes(id)) garage = addCosmeticToBag(garage, id);
    }
    if (garage !== before) writes.push(garageWrite(garage, read?.version ?? '*'));
  }

  const record: PurchaseRecord = {
    userId,
    packId: pack.id,
    platform: input.platform,
    productId: input.productId,
    transactionId: input.transactionId,
    content: plan,
    grantedAtUtc: nowUtc,
    idempotencyKey: purchaseIdempotencyKey(input.platform, input.transactionId),
    isFirstTime,
  };
  writes.push(purchaseWrite(nk, input.transactionId, record));
  writes.push(transactionOwnerWrite(nk, {
    userId, platform: input.platform, transactionId: input.transactionId, consumedAtUtc: nowUtc,
  }));
  if (isFirstTime) writes.push(firstPurchaseWrite(userId, pack.id, nowUtc));

  const out: DeliveryPlan = { plan, isFirstTime, moves, writes };
  if (subscription !== undefined) out.subscription = subscription;
  return out;
}

export const iap_purchase_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
  // Session identity only (D-03); a body callerUserId must match it.
  const caller = requireCallerId(ctx, parsed.raw);
  if (!caller.ok) return caller.error;
  const userId: string = caller.id;
  const inputOrErr = asInput(parsed.raw);
  if ('error' in inputOrErr) {
    // Phase 9 Chunk 7: input validation failure → iap_purchase_failed.
    emit(nk, logger, 'iap_purchase_failed', {
      userId, failureReason: inputOrErr.error,
    });
    return fail('BAD_REQUEST', inputOrErr.error);
  }
  const input = inputOrErr;
  // Phase 9 Chunk 7: iap_purchase_initiated (first thing after input parse).
  emit(nk, logger, 'iap_purchase_initiated', {
    userId,
    platform: input.platform,
    productId: input.productId,
    transactionId: input.transactionId,
  });

  // 2. Pack lookup.
  const pack = findIapPackByProductId(input.platform, input.productId);
  if (!pack) {
    emit(nk, logger, 'iap_purchase_failed', {
      userId, transactionId: input.transactionId, failureReason: 'NOT_FOUND: unknown productId',
    });
    return fail('NOT_FOUND', `unknown productId: ${input.productId}`);
  }

  // 3. Cross-user fraud.
  const crossUser = (): string | null => {
    const other = otherOwner(nk, userId, input);
    if (other === null) return null;
    logger.warn(
      'iap_fraud_cross_user txId=%s claimed_by=%s original=%s',
      input.transactionId, userId, other.userId,
    );
    // Phase 9 Chunk 6: a fraud flag for the operator dashboard (first
    // collision of the transaction only).
    try {
      if (!readFraudFlag(nk, input.transactionId)) {
        writeFraudFlagCreate(nk, input.transactionId, {
          transactionId: input.transactionId,
          claimedByUserId: other.userId,
          conflictByUserId: userId,
          packId: other.packId || pack.id,
          platform: input.platform,
          detectedAtUtc: serverNowMs(),
          status: 'pending',
        });
      }
    } catch (e) {
      // Best-effort: the collision is real even if the flag write failed.
      logger.warn('iap_fraud_flag write failed: %s', e instanceof Error ? e.message : String(e));
    }
    emit(nk, logger, 'iap_purchase_failed', {
      userId, transactionId: input.transactionId, failureReason: 'CONFLICT: cross-user receipt',
    });
    return fail('CONFLICT', 'Receipt already used by another account', { reason: 'RECEIPT_USED' });
  };
  const fraud = crossUser();
  if (fraud !== null) return fraud;

  // 4. Idempotency (this user).
  const existing = readPurchaseByTxId(nk, userId, input.transactionId);
  if (existing) return JSON.stringify(ok(replayOutput(nk, userId, input.transactionId, existing)));

  // 5. Verify receipt.
  const verifyResult = verifyReceipt(
    nk,
    {
      platform: input.platform,
      expectedProductId: input.productId,
      transactionId: input.transactionId,
      receiptData: input.receiptData,
    },
    {
      config: iapConfigFromEnv(ctx),
      logger,
      nowUtc: serverNowMs(),
    },
  );
  if (!verifyResult.valid) {
    const code = verifyErrorToCode(verifyResult.error);
    const reason = verifyResult.error ?? 'INTERNAL_ERROR';
    emit(nk, logger, 'iap_purchase_failed', {
      userId, transactionId: input.transactionId, packId: pack.id,
      platform: input.platform, failureReason: `verification_failed: ${reason}`,
    });
    return fail(code, `receipt rejected: ${reason}`, { reason });
  }
  // Phase 9 Chunk 7: iap_purchase_validated.
  emit(nk, logger, 'iap_purchase_validated', {
    userId, transactionId: input.transactionId, packId: pack.id, platform: input.platform,
  });

  // 6–7. Deliver in one movement.
  const key = purchaseIdempotencyKey(input.platform, input.transactionId);
  let delivered: { d: DeliveryPlan; nowUtc: number; balance: WalletView } | null = null;
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS && delivered === null; attempt += 1) {
    const nowUtc = serverNowMs();
    const d = planDelivery(nk, userId, pack, input, nowUtc);
    const out: IapPurchaseOutput = {
      purchaseId: input.transactionId,
      packId: pack.id,
      content: packContent(d.plan),
      ...(d.plan.expiresAtUtc !== undefined ? { newSubscriptionExpiresAtUtc: d.subscription?.sub.expiresAtUtc ?? d.plan.expiresAtUtc } : {}),
      idempotent: false,
    };
    const moved = moveWallet(nk, userId, key, d.moves, { extraWrites: d.writes, result: out });
    if (moved.ok) {
      if (moved.data.replayed) {
        const stored = moved.data.record.result as IapPurchaseOutput | undefined;
        const replay: IapPurchaseOutput = stored !== undefined
          ? { ...stored, newBalance: moved.data.balance, idempotent: true }
          : { ...out, newBalance: moved.data.balance, idempotent: true };
        return JSON.stringify(ok(replay));
      }
      delivered = { d, nowUtc, balance: moved.data.balance };
      break;
    }
    const reason = (moved.error.details as { reason?: string } | undefined)?.reason;
    if (moved.error.code !== 'CONFLICT' || reason !== 'VERSION_CONFLICT') {
      emit(nk, logger, 'iap_purchase_failed', {
        userId, transactionId: input.transactionId, packId: pack.id,
        platform: input.platform, failureReason: `grant_failed: ${moved.error.message}`,
      });
      return JSON.stringify(moved);
    }
    // A create-only row already exists or a CAS was lost: another
    // account took the transaction, a concurrent call of this user
    // delivered it, or the garage / subscription changed meanwhile.
    const raced = crossUser();
    if (raced !== null) return raced;
    const now = readPurchaseByTxId(nk, userId, input.transactionId);
    if (now) return JSON.stringify(ok(replayOutput(nk, userId, input.transactionId, now)));
  }
  if (delivered === null) {
    return fail('CONFLICT', 'concurrent update; nothing was delivered, please retry', { reason: 'VERSION_CONFLICT' });
  }
  const { d, nowUtc, balance } = delivered;
  if (d.subscription !== undefined) {
    emit(nk, logger, d.subscription.isRenewal ? 'iap_subscription_renewed' : 'iap_subscription_activated', {
      userId,
      packId: pack.id,
      expiresAtUtc: d.subscription.sub.expiresAtUtc,
      isRenewal: d.subscription.isRenewal,
    });
  }

  // 8. Inbox notice (already delivered: it only informs).
  sendNotice(
    nk,
    userId,
    'iap_purchase',
    {
      coins: totalCoins(d.plan),
      ...(d.plan.cosmeticId !== undefined ? { cosmetics: [d.plan.cosmeticId] } : {}),
      note: `iap purchase: ${pack.displayName}`,
    },
    `iap_purchase:${shortTxId(nk, input.transactionId)}`,
    nowUtc,
  );

  // Analytics: emit for the IAP flow (legacy + Chunk 7 delivered).
  emit(nk, logger, 'iap_purchase', {
    userId,
    packId: pack.id,
    platform: input.platform,
    productId: input.productId,
    coinsGranted: totalCoins(d.plan),
    isFirstTime: d.isFirstTime,
  });
  // Phase 9 Chunk 7: iap_purchase_delivered.
  emit(nk, logger, 'iap_purchase_delivered', {
    userId,
    transactionId: input.transactionId,
    packId: pack.id,
    platform: input.platform,
    amountCoins: totalCoins(d.plan),
    isFirstTime: d.isFirstTime,
    cohortDate: new Date(nowUtc).toISOString().slice(0, 10),
  });

  const out: IapPurchaseOutput = {
    purchaseId: input.transactionId,
    packId: pack.id,
    content: packContent(d.plan),
    newBalance: balance,
    ...(d.plan.expiresAtUtc !== undefined ? { newSubscriptionExpiresAtUtc: d.subscription?.sub.expiresAtUtc ?? d.plan.expiresAtUtc } : {}),
    idempotent: false,
  };
  return JSON.stringify(ok(out));
};

function packContent(plan: IapGrantPlan): IapPurchaseContent {
  const c: IapPurchaseContent = {
    coinsGranted: plan.coins,
    firstTimeBonus: plan.firstTimeBonus,
  };
  if (plan.cosmeticId !== undefined) c.cosmeticId = plan.cosmeticId;
  if (plan.expiresAtUtc !== undefined) c.subscriptionExpiresAtUtc = plan.expiresAtUtc;
  return c;
}

/**
 * Envelope code of a rejected receipt; `details.reason` carries the
 * verifier's code. A receipt the store refused (or that is not one) is
 * BAD_REQUEST, so the client's validator treats it as invalid; a
 * verification that could not run (no credentials, store down, our
 * credentials refused) is SERVICE_UNAVAILABLE, so it can be retried.
 */
function verifyErrorToCode(e: IapVerificationError | undefined): ErrorCode {
  switch (e) {
    case 'PRODUCT_MISMATCH':    return 'BAD_REQUEST';
    case 'EXPIRED':             return 'BAD_REQUEST';
    case 'INVALID_RECEIPT':     return 'BAD_REQUEST';
    case 'PROVIDER_MISMATCH':   return 'BAD_REQUEST';
    case 'REFUNDED':            return 'BAD_REQUEST';
    case 'PENDING':             return 'BAD_REQUEST';
    case 'ALREADY_CONSUMED':    return 'CONFLICT';
    case 'NOT_CONFIGURED':      return 'SERVICE_UNAVAILABLE';
    case 'NETWORK_ERROR':       return 'SERVICE_UNAVAILABLE';
    case 'VERIFICATION_FAILED': return 'SERVICE_UNAVAILABLE';
    case 'INTERNAL_ERROR':      return 'INTERNAL';
    default:                    return 'INTERNAL';
  }
}

export const iap_purchase: RpcHandler = withRuntime(iap_purchase_impl);
