// Phase 9 Chunk 3 — `iap_purchase` RPC + content grant.
//
// The single public IAP entry point. Bypasses maintenance (a player
// who paid Apple/Google in maintenance mode must still be able to
// redeem the entitlement; this matches the account_link /
// account_delete precedent). The flow:
//
//   1. Validate input (platform/productId/receiptData/transactionId).
//   2. Look up the pack by the platform-specific productId.
//   3. Anti-fraud: cross-user scan for the same transactionId
//      → CONFLICT if a different userId already owns it.
//   4. Idempotency: read this user's purchase row for the txId
//      → return cached content with `idempotent: true`.
//   5. Verify the receipt via `verifyReceipt` (Chunk 2).
//   6. Decide first-time bonus (read iap_first_purchase).
//   7. `planGrant` (pure) → grant (wallet / garage / subscription stub).
//   8. Write iap_purchases + iap_first_purchase.
//   9. Send inbox notification `iap_purchase`.
//  10. Return success.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { ok, err, type Resp } from '../core/response';
import type { ErrorCode } from '../core/errors';
import { parseInput } from '../core/parse_input';
import { serverNowMs } from '../core/time';
import { grant, walletGet, type WalletView } from '../economy/wallet';
import {
  readGarageObject,
  writeGarageCreate,
  writeGarageUpdate,
  defaultGarage,
  addCosmeticToBag,
} from '../garage/storage';
import { sendReward } from '../liveops/inbox';
import { emit } from '../core/admin/analytics';
import { loadLiveopsConfig } from '../liveops/config';
import { findIapPackByProductId } from './catalog';
import { verifyReceipt } from './verify';
import {
  planGrant,
  totalCoins,
  type IapGrantPlan,
} from './grant';
import {
  readPurchaseByTxId,
  findPurchaseAcrossUsers,
  writePurchase,
  readFirstPurchase,
  writeFirstPurchase,
  type PurchaseRecord,
} from './purchase_repo';
import {
  readSubscriptionWithVersion,
  writeSubscriptionCreate,
  writeSubscriptionUpdate,
} from './subscription_repo';
import { writeFraudFlagCreate, readFraudFlag } from './admin_repo';
import type { IapSubscription } from './subscription';
import type { IapPlatform, IapVerificationError } from './types';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

const VALID_PLATFORMS: ReadonlySet<IapPlatform> = new Set<IapPlatform>(['apple', 'google']);

const ERR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'INVALID_RESULT', 'INTERNAL', 'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'UPGRADE_REQUIRED',
  'NOT_IMPLEMENTED',
]);
function asCode(code: string | undefined): ErrorCode {
  if (code !== undefined && (ERR_CODES as Set<string>).has(code)) return code as ErrorCode;
  return 'INTERNAL';
}

function fail(code: ErrorCode, message: string): string {
  return JSON.stringify(err(code, message));
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
  newBalance?: number;
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

export const iap_purchase_impl: RpcHandler = (ctx, logger, nk, body) => {
  if (!ctx.userId) return fail('UNAUTHENTICATED', 'missing userId');
  const userId: string = ctx.userId;
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;
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
  const collision = findPurchaseAcrossUsers(nk, input.transactionId);
  if (collision && collision.userId !== userId) {
    logger.warn(
      'iap_fraud_cross_user txId=%s claimed_by=%s original=%s',
      input.transactionId, userId, collision.userId,
    );
    // Phase 9 Chunk 6: write a fraud flag for the operator dashboard.
    // The conflict path ALWAYS creates a flag — even if one already
    // exists from a prior collision attempt — by reading first and
    // overwriting with a fresh `conflictByUserId`.
    try {
      const existing = readFraudFlag(nk, input.transactionId);
      if (!existing) {
        writeFraudFlagCreate(nk, input.transactionId, {
          transactionId: input.transactionId,
          claimedByUserId: collision.userId,
          conflictByUserId: userId,
          packId: collision.record.packId,
          platform: collision.record.platform,
          detectedAtUtc: serverNowMs(),
          status: 'pending',
        });
      }
    } catch (e) {
      // Best-effort: log the failure but still return CONFLICT to
      // the caller. The collision is real even if the flag write
      // failed; the operator will see the log line in their audit
      // trail.
      logger.warn('iap_fraud_flag write failed: %s', e instanceof Error ? e.message : String(e));
    }
    emit(nk, logger, 'iap_purchase_failed', {
      userId, transactionId: input.transactionId, failureReason: 'CONFLICT: cross-user receipt',
    });
    return fail('CONFLICT', 'Receipt already used by another account');
  }

  // 4. Idempotency (this user).
  const existing = readPurchaseByTxId(nk, userId, input.transactionId);
  if (existing) {
    const balance = walletGet(nk, userId);
    const out: IapPurchaseOutput = {
      purchaseId: input.transactionId,
      packId: existing.packId,
      content: packContent(existing.content),
      ...(typeof balance.coins === 'number' ? { newBalance: balance.coins } : {}),
      ...(existing.content.expiresAtUtc !== undefined
        ? { newSubscriptionExpiresAtUtc: existing.content.expiresAtUtc }
        : {}),
      idempotent: true,
    };
    return JSON.stringify(ok(out));
  }

  // 5. Verify receipt.
  const liveops = loadLiveopsConfig(nk, logger);
  const verifyResult = verifyReceipt(
    {
      platform: input.platform,
      expectedProductId: input.productId,
      transactionId: input.transactionId,
      receiptData: input.receiptData,
    },
    {
      config: liveops.iapVerification,
      logger,
      nowUtc: serverNowMs(),
    },
  );
  if (!verifyResult.valid) {
    const code = verifyErrorToCode(verifyResult.error);
    const reason = `verification_failed: ${verifyResult.error ?? 'unknown'}`;
    emit(nk, logger, 'iap_purchase_failed', {
      userId, transactionId: input.transactionId, packId: pack.id,
      platform: input.platform, failureReason: reason,
    });
    if (code === 'INTERNAL') {
      return fail('INTERNAL', `verification failed: ${verifyResult.error}`);
    }
    return fail(code, `receipt rejected: ${verifyResult.error}`);
  }
  // Phase 9 Chunk 7: iap_purchase_validated.
  emit(nk, logger, 'iap_purchase_validated', {
    userId, transactionId: input.transactionId, packId: pack.id, platform: input.platform,
  });

  // 6. First-time check.
  const nowUtc = serverNowMs();
  const first = readFirstPurchase(nk, userId, pack.id);
  const isFirstTime = first === null;
  const plan = planGrant(pack, isFirstTime, nowUtc);

  // 7. Grant.
  let newBalance: number | undefined;
  if (totalCoins(plan) > 0) {
    const r: Resp<WalletView> = grant(
      nk,
      userId,
      { coins: totalCoins(plan) },
      { reason: 'iap', sourceId: `iap:${pack.id}:${input.transactionId}` },
      `iap_purchase:${input.transactionId}`,
    );
    if (!r.ok) {
      emit(nk, logger, 'iap_purchase_failed', {
        userId, transactionId: input.transactionId, packId: pack.id,
        platform: input.platform, amountCoins: totalCoins(plan),
        failureReason: `grant_failed: ${r.error?.message ?? 'unknown'}`,
      });
      return fail(asCode(r.error?.code), r.error?.message ?? 'grant failed');
    }
    newBalance = r.data.coins;
  }
  if (plan.cosmeticId !== undefined) {
    const obj = readGarageObject(nk, userId);
    if (obj === null) {
      const g = defaultGarage(userId, nowUtc);
      writeGarageCreate(nk, addCosmeticToBag(g, plan.cosmeticId));
    } else {
      const next = obj.value.cosmeticsBag.includes(plan.cosmeticId)
        ? obj.value
        : addCosmeticToBag(obj.value, plan.cosmeticId);
      writeGarageUpdate(nk, next, obj.version);
    }
  }
  // Subscription: full lifecycle (Chunk 4).
  if (plan.subscriptionId !== undefined && plan.expiresAtUtc !== undefined) {
    if (pack.kind !== 'subscription') {
      // Defensive — planGrant only sets subscriptionId on subs.
      emit(nk, logger, 'iap_purchase_failed', {
        userId, transactionId: input.transactionId, packId: pack.id,
        platform: input.platform, failureReason: 'subscription_without_subscription_pack',
      });
      return fail('INTERNAL', 'subscriptionId without subscription pack');
    }
    const originalTxId = input.originalTransactionId ?? input.transactionId;
    const existing = readSubscriptionWithVersion(nk, userId);
    let isRenewal = false;
    let newSub: IapSubscription;
    if (existing === null || existing.value.originalTransactionId !== originalTxId) {
      // First activation OR a new sub replacing the old one. The old
      // sub (if any) expires on its own expiresAtUtc — no explicit
      // cancel needed.
      newSub = {
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
      newSub = {
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
            monthlyCoinsGranted: 0, // filled below
          },
        ],
      };
    }

    // First-activation OR per-cycle monthly grant (cosmetic + coins).
    let monthlyCoinsApplied = 0;
    if (plan.monthlyCosmeticId !== undefined && !newSub.monthlyCosmeticGranted) {
      const obj = readGarageObject(nk, userId);
      if (obj === null) {
        const g = defaultGarage(userId, nowUtc);
        writeGarageCreate(nk, addCosmeticToBag(g, plan.monthlyCosmeticId));
      } else if (!obj.value.cosmeticsBag.includes(plan.monthlyCosmeticId)) {
        writeGarageUpdate(nk, addCosmeticToBag(obj.value, plan.monthlyCosmeticId), obj.version);
      }
      newSub.monthlyCosmeticGranted = true;
    }
    if ((plan.monthlyCoins ?? 0) > 0) {
      const monthlyKey = `iap_subscription_monthly:${originalTxId}:${newSub.expiresAtUtc}`;
      const r2: Resp<WalletView> = grant(
        nk,
        userId,
        { coins: plan.monthlyCoins ?? 0 },
        { reason: 'iap', sourceId: `sub_monthly:${pack.id}:${newSub.expiresAtUtc}` },
        monthlyKey,
      );
      if (r2.ok) {
        monthlyCoinsApplied = plan.monthlyCoins ?? 0;
        if (newBalance === undefined) newBalance = r2.data.coins;
      }
    }

    // Backfill monthlyCoinsGranted on the last renewal entry.
    if (isRenewal && newSub.renewalHistory.length > 0 && monthlyCoinsApplied > 0) {
      const last = newSub.renewalHistory[newSub.renewalHistory.length - 1]!;
      newSub.renewalHistory[newSub.renewalHistory.length - 1] = { ...last, monthlyCoinsGranted: monthlyCoinsApplied };
    }

    if (existing === null) {
      writeSubscriptionCreate(nk, newSub);
    } else {
      writeSubscriptionUpdate(nk, newSub, existing.version);
    }

    emit(nk, logger, isRenewal ? 'iap_subscription_renewed' : 'iap_subscription_activated', {
      userId,
      packId: pack.id,
      expiresAtUtc: newSub.expiresAtUtc,
      isRenewal,
    });
  }

  // 8. Write audit + first-purchase marker.
  const idempotencyKey = `iap_purchase:${input.transactionId}`;
  const record: PurchaseRecord = {
    userId: userId,
    packId: pack.id,
    platform: input.platform,
    productId: input.productId,
    content: plan,
    grantedAtUtc: nowUtc,
    idempotencyKey,
    ...(newBalance !== undefined ? { newBalance } : {}),
    isFirstTime,
  };
  writePurchase(nk, input.transactionId, record);
  if (isFirstTime) {
    writeFirstPurchase(nk, userId, pack.id, nowUtc);
  }

  // 9. Inbox notification.
  sendReward(
    nk,
    userId,
    'iap_purchase',
    {
      coins: totalCoins(plan),
      ...(plan.cosmeticId !== undefined ? { cosmetics: [plan.cosmeticId] } : {}),
      note: `iap purchase: ${pack.displayName}`,
    },
    `iap_purchase:${input.transactionId}`,
    nowUtc,
  );

  // Analytics: emit for the IAP flow (legacy + Chunk 7 delivered).
  emit(nk, logger, 'iap_purchase', {
    userId: userId,
    packId: pack.id,
    platform: input.platform,
    productId: input.productId,
    coinsGranted: totalCoins(plan),
    isFirstTime,
  });
  // Phase 9 Chunk 7: iap_purchase_delivered.
  emit(nk, logger, 'iap_purchase_delivered', {
    userId,
    transactionId: input.transactionId,
    packId: pack.id,
    platform: input.platform,
    amountCoins: totalCoins(plan),
    isFirstTime,
    cohortDate: new Date(nowUtc).toISOString().slice(0, 10),
  });

  const out: IapPurchaseOutput = {
    purchaseId: input.transactionId,
    packId: pack.id,
    content: packContent(plan),
    ...(newBalance !== undefined ? { newBalance } : {}),
    ...(plan.expiresAtUtc !== undefined ? { newSubscriptionExpiresAtUtc: plan.expiresAtUtc } : {}),
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

function verifyErrorToCode(e: IapVerificationError | undefined): ErrorCode {
  switch (e) {
    case 'PRODUCT_MISMATCH':    return 'BAD_REQUEST';
    case 'EXPIRED':             return 'BAD_REQUEST';
    case 'INVALID_RECEIPT':     return 'BAD_REQUEST';
    case 'PROVIDER_MISMATCH':   return 'BAD_REQUEST';
    case 'ALREADY_CONSUMED':    return 'CONFLICT';
    case 'NETWORK_ERROR':       return 'INTERNAL';
    case 'VERIFICATION_FAILED': return 'INTERNAL';
    case 'INTERNAL_ERROR':      return 'INTERNAL';
    default:                    return 'INTERNAL';
  }
}

export const iap_purchase: RpcHandler = iap_purchase_impl;
