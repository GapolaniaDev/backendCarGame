// Phase 9 Chunk 2 — Mock receipt verifier.
//
// Used in development and CI when no real Apple/Google keys are
// available. The mock parses a JSON payload from the receiptData
// field and returns a fully-populated IapVerificationResult. The
// format mirrors the minimum the live verifiers need:
//
//   {
//     "productId":   "com.cvg.coins100",
//     "transactionId": "1000000123456789",
//     "originalTransactionId": "1000000123456789",
//     "purchaseDateUtc": 1700000000000,
//     "expiresAtUtc":   1702592000000,    // optional, for subs
//     "expire":         true|false          // force EXPIRED result
//   }
//
// Receipts that fail to parse return INVALID_RECEIPT. Receipts that
// declare expire=true return EXPIRED (used to exercise the EXPIRED
// branch in tests). Anything else is treated as valid.

import type { IapVerificationResult, IapPlatform, IapVerificationError } from './types';

export interface MockReceipt {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  purchaseDateUtc: number;
  expiresAtUtc?: number;
  expire?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMockReceipt(v: unknown): v is MockReceipt {
  if (!isPlainObject(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['productId'] === 'string' && (r['productId'] as string).length > 0
    && typeof r['transactionId'] === 'string' && (r['transactionId'] as string).length > 0
    && typeof r['originalTransactionId'] === 'string' && (r['originalTransactionId'] as string).length > 0
    && typeof r['purchaseDateUtc'] === 'number' && Number.isFinite(r['purchaseDateUtc'] as number)
  );
}

export function verifyMock(
  platform: IapPlatform,
  receiptData: string,
  expectedProductId: string,
  nowUtc: number,
): IapVerificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptData);
  } catch {
    return failResult(platform, expectedProductId, 'INVALID_RECEIPT');
  }
  if (!isMockReceipt(parsed)) {
    return failResult(platform, expectedProductId, 'INVALID_RECEIPT');
  }
  if (parsed.productId !== expectedProductId) {
    return {
      valid: false,
      platform,
      productId: expectedProductId,
      transactionId: parsed.transactionId,
      originalTransactionId: parsed.originalTransactionId,
      purchaseDateUtc: parsed.purchaseDateUtc,
      isSubscriptionRenewal: false,
      error: 'PRODUCT_MISMATCH',
    };
  }
  if (parsed.expire === true) {
    return {
      valid: false,
      platform,
      productId: expectedProductId,
      transactionId: parsed.transactionId,
      originalTransactionId: parsed.originalTransactionId,
      purchaseDateUtc: parsed.purchaseDateUtc,
      isSubscriptionRenewal: false,
      error: 'EXPIRED',
    };
  }
  const isSub = parsed.expiresAtUtc !== undefined;
  const isRenewal = isSub && parsed.originalTransactionId !== parsed.transactionId;
  const out: IapVerificationResult = {
    valid: true,
    platform,
    productId: parsed.productId,
    transactionId: parsed.transactionId,
    originalTransactionId: parsed.originalTransactionId,
    purchaseDateUtc: parsed.purchaseDateUtc,
    isSubscriptionRenewal: isRenewal,
  };
  if (isSub) {
    const exp = parsed.expiresAtUtc as number;
    if (exp < nowUtc) {
      return {
        valid: false,
        platform,
        productId: parsed.productId,
        transactionId: parsed.transactionId,
        originalTransactionId: parsed.originalTransactionId,
        purchaseDateUtc: parsed.purchaseDateUtc,
        expiresAtUtc: exp,
        isSubscriptionRenewal: isRenewal,
        error: 'EXPIRED',
      };
    }
    out.expiresAtUtc = exp;
  }
  return out;
}

function failResult(platform: IapPlatform, productId: string, error: IapVerificationError): IapVerificationResult {
  return {
    valid: false,
    platform,
    productId,
    transactionId: '',
    originalTransactionId: '',
    purchaseDateUtc: 0,
    isSubscriptionRenewal: false,
    error,
  };
}
