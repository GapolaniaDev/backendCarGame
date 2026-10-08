// Phase 9 Chunk 1 — IAP types + receipt / subscription wire types.
//
// The catalog (`catalogs/iap_packs.json`) is the source of truth for what
// the store sells. The runtime types here are the typed mirror that
// flows through the rest of the module (validation, RPC I/O, analytics).
//
// Three pack kinds:
//   - `consumable`     — coins (baseCoins + firstTimeBonus on first buy)
//   - `non_consumable` — cosmetic (cosmeticId, no quantifier)
//   - `subscription`   — monthly pass (durationDays + monthlyCoins +
//                        monthlyCosmeticId on each renewal)
//
// Every pack has BOTH `appleProductId` and `googleProductId` because the
// catalog is cross-platform — the store IAP RPCs route by platform and
// look up the pack by the platform-specific product id (D-iap-1).

export type IapKind = 'consumable' | 'non_consumable' | 'subscription';
export type IapPlatform = 'apple' | 'google';

export interface IapPackBase {
  id: string;
  kind: IapKind;
  displayName: string;
  appleProductId: string;
  googleProductId: string;
  sortOrder: number;
}

export interface IapConsumablePack extends IapPackBase {
  kind: 'consumable';
  baseCoins: number;
  /** Bonus coins granted ONLY on the user's first purchase of this pack. */
  firstTimeBonus: number;
}

export interface IapNonConsumablePack extends IapPackBase {
  kind: 'non_consumable';
  cosmeticId: string;
}

export interface IapSubscriptionPack extends IapPackBase {
  kind: 'subscription';
  durationDays: number;
  monthlyCoins: number;
  monthlyCosmeticId: string;
}

export type IapPack = IapConsumablePack | IapNonConsumablePack | IapSubscriptionPack;

/** Receipt as posted by the client to `iap_purchase`. */
export interface IapReceipt {
  userId: string;
  packId: string;
  platform: IapPlatform;
  /** base64 receipt from the store. */
  receiptData: string;
  /** Platform-side transaction id (Apple `transaction_id`, Google `orderId`). */
  transactionId: string;
  /** Client-reported purchase UTC ms. */
  purchasedAtUtc: number;
}

/** Server-side subscription state. */
export interface IapSubscription {
  userId: string;
  packId: string;
  platform: IapPlatform;
  /** First-ever transaction id (renewals keep the same value). */
  originalTransactionId: string;
  /** Server-computed expiry UTC ms (purchasedAtUtc + durationDays * 86400_000). */
  expiresAtUtc: number;
  autoRenewing: boolean;
  cancelledAtUtc?: number;
}

// ─── Catalog validation (used at boot) ───────────────────────────────────────

/** Allowed `IapKind` set — used to surface malformed catalogs early. */
const IAP_KINDS: ReadonlySet<IapKind> = new Set<IapKind>([
  'consumable', 'non_consumable', 'subscription',
]);

/** Per-kind minimum required fields. Used to fail-fast on missing data. */
const REQUIRED_BY_KIND: Readonly<Record<IapKind, ReadonlyArray<string>>> = {
  consumable:     ['id', 'kind', 'displayName', 'baseCoins', 'firstTimeBonus',
                   'appleProductId', 'googleProductId', 'sortOrder'],
  non_consumable: ['id', 'kind', 'displayName', 'cosmeticId',
                   'appleProductId', 'googleProductId', 'sortOrder'],
  subscription:   ['id', 'kind', 'displayName', 'durationDays', 'monthlyCoins',
                   'monthlyCosmeticId', 'appleProductId', 'googleProductId',
                   'sortOrder'],
};

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validate the raw `iap_packs.json` payload. Returns a typed array of
 * `IapPack` on success or a human-readable reason on failure. The
 * caller (boot loader) MUST throw on failure — a missing or malformed
 * catalog at boot is a fail-fast condition (D-iap-1).
 */
export function validateIapPacksFile(raw: unknown): ValidateResult<IapPack[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'expected an array of packs' };
  }
  if (raw.length < 1) {
    return { ok: false, reason: 'iap_packs.json must contain at least 1 pack' };
  }
  const seen = new Set<string>();
  const out: IapPack[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const ctx = `pack[${i}]`;
    if (!isPlainObject(r)) {
      return { ok: false, reason: `${ctx} must be an object` };
    }
    const kind = r['kind'];
    if (typeof kind !== 'string' || !IAP_KINDS.has(kind as IapKind)) {
      return { ok: false, reason: `${ctx}.kind must be one of consumable|non_consumable|subscription` };
    }
    const k = kind as IapKind;
    for (const f of REQUIRED_BY_KIND[k]) {
      if (!(f in r)) {
        return { ok: false, reason: `${ctx} missing required field "${f}"` };
      }
    }
    if (typeof r['id'] !== 'string' || r['id'].length === 0) {
      return { ok: false, reason: `${ctx}.id must be a non-empty string` };
    }
    if (seen.has(r['id'] as string)) {
      return { ok: false, reason: `${ctx}.id duplicate: ${r['id']}` };
    }
    seen.add(r['id'] as string);
    if (k === 'consumable') {
      const base = r['baseCoins'];
      const bonus = r['firstTimeBonus'];
      if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0) {
        return { ok: false, reason: `${ctx}.baseCoins must be a positive integer` };
      }
      if (typeof bonus !== 'number' || !Number.isInteger(bonus) || bonus < 0) {
        return { ok: false, reason: `${ctx}.firstTimeBonus must be a non-negative integer` };
      }
      if (bonus > base) {
        return { ok: false, reason: `${ctx}.firstTimeBonus (${bonus}) cannot exceed baseCoins (${base})` };
      }
    }
    if (k === 'non_consumable') {
      if (typeof r['cosmeticId'] !== 'string' || (r['cosmeticId'] as string).length === 0) {
        return { ok: false, reason: `${ctx}.cosmeticId must be a non-empty string` };
      }
    }
    if (k === 'subscription') {
      const dur = r['durationDays'];
      if (typeof dur !== 'number' || !Number.isInteger(dur) || dur <= 0) {
        return { ok: false, reason: `${ctx}.durationDays must be a positive integer` };
      }
      const monthly = r['monthlyCoins'];
      if (typeof monthly !== 'number' || !Number.isInteger(monthly) || monthly < 0) {
        return { ok: false, reason: `${ctx}.monthlyCoins must be a non-negative integer` };
      }
      if (typeof r['monthlyCosmeticId'] !== 'string'
          || (r['monthlyCosmeticId'] as string).length === 0) {
        return { ok: false, reason: `${ctx}.monthlyCosmeticId must be a non-empty string` };
      }
    }
    out.push(r as unknown as IapPack);
  }
  return { ok: true, value: out };
}

// ─── Phase 9 Chunk 2 — Receipt verification result ──────────────────────────

/**
 * Verification failure codes. Maps to the gateway-level `ErrorCode` but
 * scoped to the IAP flow so callers can branch on intent (e.g. retry
 * network errors, drop already-consumed). D61.
 */
export type IapVerificationError =
  | 'VERIFICATION_FAILED'   // store returned non-zero status
  | 'PRODUCT_MISMATCH'      // productId does not match the catalog pack
  | 'EXPIRED'               // subscription past expiresAtUtc
  | 'NETWORK_ERROR'         // timeout, DNS, connection refused
  | 'INVALID_RECEIPT'       // malformed receipt / token
  | 'ALREADY_CONSUMED'      // consumable already consumed (Google)
  | 'PROVIDER_MISMATCH'     // cross-platform receipt (e.g. apple token to google)
  | 'INTERNAL_ERROR';       // catch-all

export type IapVerificationProvider = 'mock' | 'apple' | 'google';

export interface IapVerificationResult {
  valid: boolean;
  platform: IapPlatform;
  /** The productId the receipt verified for. */
  productId: string;
  /** The transactionId the store assigned (Apple: transaction_id, Google: orderId). */
  transactionId: string;
  /** Apple original_transaction_id, Google orderId of the FIRST purchase. */
  originalTransactionId: string;
  /** Server-side purchase UTC ms. */
  purchaseDateUtc: number;
  /** Server-side expiry UTC ms. Subscriptions only. */
  expiresAtUtc?: number;
  /** true when transactionId != originalTransactionId (renewal). */
  isSubscriptionRenewal: boolean;
  /** Populated when `valid === false`. */
  error?: IapVerificationError;
}

export interface IapVerificationConfig {
  provider: IapVerificationProvider;
  /** Required when provider='apple'. */
  appleSharedSecret?: string;
  /** Required when provider='google'. base64 of the service account JSON. */
  googleServiceAccount?: string;
  /** Android package name (e.g. com.cvg.game). */
  packageName: string;
  environment: 'sandbox' | 'production';
  /** Per-request timeout. Default 10000ms (D61). */
  timeoutMs: number;
}

