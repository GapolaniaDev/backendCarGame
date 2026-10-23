# IAP — CarVideoGameBackend

In-app purchases (real money → coins/gems/cosmetics/cars/subscription).
Three product kinds, ten catalog packs. Receipts are verified against the
App Store / Google Play with the credentials of `runtime.env`; the mock
verifier only runs with `IAP_MOCK=true` (dev / CI). Plan T-24 (PC-04,
HT-75, HT-78) rewrote verification and delivery: see §2–§3.

**Phase**: 9 (Chunks 1-6 + 7 analytics), reworked in plan F7 (T-24)
**Source**: `modules/src/iap/`, `modules/src/analytics/{iap_events,ltv,funnel,top_buyers,rpcs}.ts`

---

## 1. Catalog

`iap_packs` collection (system-owned), `modules/src/catalogs/iap_packs.json`
(10 bundled packs). Schema:

```ts
{
  schemaVersion: 1,
  packs: [{
    id: 'coins_100',
    kind: 'consumable' | 'non_consumable' | 'subscription',
    displayName: '100 Coins',
    baseCoins: 100,           // consumable
    firstTimeBonus: 50,       // consumable (1-shot per userId×packId)
    cosmeticId: 'cosmetic_x', // non_consumable OR subscription
    monthlyCoins: 100,        // subscription
    monthlyCosmetic: 'cosmetic_monthly',
    appleProductId: 'com.cvg.coins100',  // cross-platform productId
    googleProductId: 'coins_100',        // (Google: lowercase only)
    sortOrder: 1,
  }]
}
```

### Pack kinds (10 total)

| Kind | Count | Examples | Effect |
|---|---|---|---|
| `consumable` | 5 | `coins_100`, `coins_500`, `gems_50`, `event_pack_1` | wallet grant (coins + firstTimeBonus) |
| `non_consumable` | 4 | `car_sport_legendary`, `skin_neon_starter` | garage unlock, idempotent (1-shot per packId) |
| `subscription` | 1 | `pass_monthly` | monthly grant + cosmetic on activation + renewal |

Cross-platform productId pattern: `appleProductId` for Apple App Store,
`googleProductId` for Google Play. The client passes the platform-specific
id in the `productId` field of the `iap_purchase` RPC.

---

## 2. Purchase flow

### `iap_purchase`

```http
POST /v2/rpc/iap_purchase          Authorization: Bearer <session>
{ "platform": "apple" | "google",
  "productId": "com.cvg.coins100",     // the store's product id
  "receiptData": "<Unity receipt>",    // Order.Info.Receipt (see §3.1)
  "transactionId": "1000000123456789"  // the store transaction (Apple transaction_id,
}                                      // Google orderId or purchaseToken)
```

Returns:

```ts
{
  purchaseId: 'tx-abc-123',
  packId: 'coins_100',
  idempotent: false,
  content: {
    coinsGranted: 100,            // base only (excludes firstTimeBonus)
    firstTimeBonus: 50,           // 1-shot per (userId, packId)
    cosmeticId?: 'cosmetic_x',    // non_consumable / subscription
    subscriptionExpiresAtUtc?: 1234567890  // subscription only
  },
  newBalance: { coins: 150, gems: 0 }
}
```

### Order of operations

1. **Auth** — `ctx.userId` required (`UNAUTHENTICATED` otherwise; a body
   `callerUserId` must match it, D-03).
2. **Input validation** — all 4 fields required + `platform` enum + `productId` non-empty.
3. **Catalog lookup** — `findIapPackByProductId(platform, productId)` → `NOT_FOUND` if missing.
4. **Cross-user check** — the transaction belongs to another account → `CONFLICT` (§5).
5. **Idempotency check** — this user's `iap_purchases` row for the transaction → its content with `idempotent: true`.
6. **Receipt verification** — `verifyReceipt(nk, …, {config: iapConfigFromEnv(ctx)})` (§3).
7. **Delivery in ONE transaction** (T-24, plan T-11) — one `moveWallet`
   under the per-user durable key `iap_purchase:{platform}:{transactionId}`
   commits together: the coins (base + first-time bonus, plus the monthly
   coins of a subscription) with their ledger rows, the garage cosmetic,
   the subscription record, the `iap_purchases` row, the
   `iap_first_purchase` marker (create-only) and the `iap_transactions`
   index (create-only). A lost CAS (garage, subscription, marker) re-plans
   from fresh reads (3 attempts); a concurrent call with the same key
   replays the stored response.
8. **Inbox** — `iap_purchase` notice (already delivered: it only informs).
9. **Analytics** — see §8.

Before T-24 every step wrote on its own, so a failure in the middle kept
the coins without the purchase row (or the reverse), and the idempotency
key was the transaction id alone.

### Maintenance bypass (D63)

`iap_purchase` is registered as a home-only RPC and **bypasses the
maintenance gate** — money has already been charged, the server must
still deliver the product.

### Idempotency

The dedup key is `(userId, platform, transactionId)`: the durable
`idem/{userId}/iap_purchase:{platform}:{transactionId}` record (written in
the delivery's transaction, `core/idempotency.ts`) plus the
`iap_purchases/{userId}/{transactionId}` row. A retry — also after a
Nakama restart, and also when the mock is off again — returns the stored
content with `idempotent: true` and delivers nothing. The client
(`BackendCarGamePurchaseFulfiller`) maps it to `AlreadyDelivered`.
Transaction ids longer than Nakama's 128-character storage keys (a Google
purchase token can be) are stored as `sha256:<hex>`; the id stays in the
row's `transactionId`.

---

## 3. Receipt verification

`verifyReceipt(nk, args, deps)` (`iap/verify.ts`) routes by the receipt's
platform with the settings of `runtime.env` (`iap/config.ts`), read on
every call:

| Setting (`.env` → `runtime.env`) | Effect |
|---|---|
| `IAP_MOCK=true` | both platforms use the mock verifier (§3.3). **Default `false`; dev / CI only** |
| `IAP_APPLE_SHARED_SECRET` | App Store app-specific shared secret; empty = Apple receipts rejected |
| `IAP_GOOGLE_CLIENT_EMAIL`, `IAP_GOOGLE_PRIVATE_KEY`, `IAP_GOOGLE_PACKAGE_NAME` | Google Play service account (Android Publisher API) and the app id; any empty = Google receipts rejected |

A store without credentials answers `SERVICE_UNAVAILABLE` with
`details.reason = NOT_CONFIGURED` and **sends nothing to the store**.
`docker-compose.yml` also writes the same credentials into Nakama's native
`iap:` block, which the client's `NakamaReceiptValidator` (native
`ValidatePurchase*` API) uses. Changing them = edit `.env` and recreate
Nakama (with the local override when running locally).

Before T-24 the provider came from LiveOps (`iapVerification`), whose
bundled default was `mock`: any JSON receipt bought coins. The LiveOps
block is still accepted by validation but ignored, and no longer bundled.

### 3.1 Receipt formats (what the client sends)

`receiptData` is Unity IAP's `Order.Info.Receipt`, the unified receipt
`{"Store":"AppleAppStore"|"GooglePlay","TransactionID":"…","Payload":"…"}`
(`iap/receipt.ts`). Accepted, wrapped or already unwrapped:

- **Apple** — `Payload` is the base64 App Store receipt. Anything that is
  not base64 (e.g. JSON) is `INVALID_RECEIPT` without calling Apple.
- **Google, `UnityPayload` mode** (default of the client installer) —
  `Payload` is `{"json":"<purchase JSON>","signature":"…",…}`.
- **Google, `PurchaseJson` mode** — the purchase JSON itself
  (`{"orderId","packageName","productId","purchaseTime","purchaseState","purchaseToken",…}`).
- A bare Google purchase token (older callers).

For Google the purchase token comes from the receipt, its `packageName`
must be `IAP_GOOGLE_PACKAGE_NAME` (`PROVIDER_MISMATCH`), its `productId`
the requested one (`PRODUCT_MISMATCH`), and the request `transactionId`
must be its `orderId` or `purchaseToken` (`INVALID_RECEIPT`).

### 3.2 Store calls

- **Apple** — `POST https://buy.itunes.apple.com/verifyReceipt` with
  `{receipt-data, password}` through `nk.httpRequest` (10 s timeout, 1
  retry on a network error); `21007` (a sandbox / TestFlight receipt) is
  retried on `https://sandbox.itunes.apple.com/verifyReceipt`. The entry
  whose `transaction_id` is the request's must exist and name the product;
  an entry with `cancellation_date_ms` is **`REFUNDED`**; an expired
  subscription is `EXPIRED`. (Before T-24 the default caller read an
  undefined `deps.nk`, read `content` instead of 3.27's `body` and wrapped
  the request twice: it never worked.)
- **Google** — an OAuth2 access token is minted in the runtime from the
  service account (RS256 JWT with `nk.jwtGenerate`, exchanged at
  `https://oauth2.googleapis.com/token`, scope `androidpublisher`, cached
  per VM until a minute before it expires), then
  `GET …/androidpublisher/v3/applications/{package}/purchases/products/{productId}/tokens/{token}`.
  `purchaseState` 1 (canceled: refunded or revoked) is **`REFUNDED`**, 2 is
  `PENDING`, `consumptionState` 1 is `ALREADY_CONSUMED`; 404/400/410 are
  `INVALID_RECEIPT`, 401/403 `VERIFICATION_FAILED`. (Before T-24 the
  verifier had no caller and expected a pre-computed bearer token.)
  Google **subscriptions** are not verified yet (the products endpoint
  answers 404 for them; `purchases.subscriptionsv2` is a follow-up).

### 3.3 Mock verifier (`IAP_MOCK=true` only)

The payload (wrapped in the unified receipt or not) is
`{"productId","transactionId","originalTransactionId","purchaseDateUtc","expiresAtUtc"?,"expire"?}`.
Its `transactionId` must be the request's; `refunded: true`, `refundTime`
or `RefundTime` → `REFUNDED`; `expire: true` → `EXPIRED`.

### 3.4 Rejections

Every rejection carries `details.reason` = the verifier code:

| Verifier code | Envelope code |
|---|---|
| `INVALID_RECEIPT`, `PRODUCT_MISMATCH`, `PROVIDER_MISMATCH`, `EXPIRED`, `REFUNDED`, `PENDING` | `BAD_REQUEST` (the client's validator treats it as an invalid receipt) |
| `ALREADY_CONSUMED` | `CONFLICT` |
| `NOT_CONFIGURED`, `NETWORK_ERROR`, `VERIFICATION_FAILED` | `SERVICE_UNAVAILABLE` (retryable; was `INTERNAL`) |
| `INTERNAL_ERROR` | `INTERNAL` |

There is no verification cache any more (the old per-VM 24 h cache also
replayed failures): a retry of a delivered purchase is answered from its
durable record before verifying.

---

## 4. First-time bonus

Consumable packs may carry a `firstTimeBonus` (coins, integer). The bonus
fires exactly once per `(userId, packId)`. The dedup row is
`iap_first_purchase/{userId}_{packId}` (server-only).

Second purchase of the same pack: `firstTimeBonus: 0` in the response,
the wallet grant excludes the bonus.

This is an engagement mechanic — players who log in after a long absence
get a one-time windfall to lower the cold-start gap (D65).

---

## 5. Cross-user fraud detection

A store transaction is consumed by one account. The
`iap_transactions/{system}/{platform}:{transactionId}` index (T-24) is
created with version `*` in the delivery's transaction, so two accounts
racing with one receipt cannot both commit; rows delivered before the
index existed are found with a scan of `iap_purchases` (legacy fallback).
Before verification, and again after a lost race:

1. The current request returns `CONFLICT` (`details.reason = RECEIPT_USED`).
2. An `iap_fraud_flags` row is created with both `claimedByUserId` and
   `conflictByUserId`, `status: 'pending'`.
3. The first user (who bought legitimately) is unaffected.

The admin can resolve the flag via `admin_iap_fraud_flag_action` (ban the
impostor, dismiss, or confirm). 30-day `anti_cheat` sanction is the
default for `ban` (D85).

---

## 6. Refund flow

### `admin_iap_refund`

```http
POST /v2/rpc/admin_iap_refund
{ "adminKey": "<key>", "userId": "<uuid>", "transactionId": "tx-abc-123", "reason": "duplicate" }
```

1. **Lookup** — `iap_purchases/{txId}/{userId}` must exist (`NOT_FOUND` otherwise).
2. **Already refunded** — `refunded === true` → `CONFLICT` (D90).
3. **Window** — `now - grantedAtUtc > 90d` → `CONFLICT: refund window expired` (D86).
4. **Empty reason** — `BAD_REQUEST`.
5. **Wallet reversal** — `wallet.spend({coins: amount}, ..., 'admin_refund')`.
6. **Persist** — CAS update `iap_purchases/{txId}` with `refunded=true`,
   `refundedAtUtc`, `refundedReason`, `refundedByAdminId`.
7. **Inbox** — `iap_refund` reward with `{coins, note: 'Refund: {reason}'}`.
8. **Cache invalidate** — `invalidateRevenueStatsCache()` (D83).
9. **Audit** — `emit('iap_refund_completed', {...})` (NOT `emitAdminAction`).
10. **Audit action** — `emitAdminAction('admin_iap_refund', {...})`.

Returns `{ refundedAtUtc, amountRefunded, newBalance, adminUserId }`.

The 90-day cap matches Apple's standard refund policy; operators can still
grant ad-hoc compensations via `admin_wallet_grant` (chunk 9).

---

## 7. Subscription

### Activation

`iap_purchase` with a `kind: 'subscription'` pack:

- `pass_monthly` → 30 days, autoRenewing=true, monthly grant (100 coins
  + 1 cosmetic on every renewal).
- `iap_subscriptions/{userId}` (R=1, W=0) holds the full state:
  `originalTransactionId` (renewal key), `latestTransactionId` (cancel
  auth), `activatedAtUtc`, `expiresAtUtc`, `autoRenewing`,
  `cancelledAtUtc?`, `monthlyCosmeticGranted: boolean`,
  `renewalHistory: [...]`.

### `iap_subscription_status`

Returns the current sub state OR `{ hasSubscription: false }`. No storage
mutation.

### `iap_subscription_cancel`

**One-way cancel** (D70): the user provides a `transactionId` matching
either `latestTransactionId` or `originalTransactionId`. Sets
`cancelledAtUtc = now`, `autoRenewing = false`. The sub remains
**active until `expiresAtUtc`**.

Re-cancel returns `CONFLICT`. No refund (subscriptions are managed by
Apple/Google — the player must request via the App Store / Play Store).

### Renewal

The 5-min scanner (D69) walks `iap_subscriptions` rows for renewal
signals. Renewal = same `originalTransactionId` + new `latestTransactionId` →
`expiresAtUtc += days`, `monthlyCosmeticGranted` reset, monthly grant
fired again. The scanner writes an `iap_subscription_renewed` event.

### Expiry + cleanup

- 7 days before `expiresAtUtc` → `iap_subscription_warn_expiring` event (best-effort).
- At `expiresAtUtc` → `iap_subscription_expired` event + scanner marks the row as expired.
- 30 days after expiry → hard delete the row (D71).

### Maintenance bypass (D72)

Both `iap_subscription_status` and `iap_subscription_cancel` bypass the
maintenance gate.

---

## 8. Analytics (Phase 9 Chunk 7)

11 new `AnalyticsEventName` variants fire from the IAP pipeline:

| Event | Fired from | Payload |
|---|---|---|
| `iap_purchase_initiated` | `iap_purchase` (input parse ok) | `{transactionId, packId, platform, productId}` |
| `iap_purchase_validated` | `iap_purchase` (verify ok) | `{transactionId, packId, platform, productId}` |
| `iap_purchase_delivered` | `iap_purchase` (grant ok) | `{transactionId, packId, platform, amountCoins, isFirstTime, cohortDate}` |
| `iap_purchase_failed` | `iap_purchase` (input/not_found/fraud/verify/grant) | `{failureReason, errorCode?}` |
| `iap_refund_completed` | `admin_iap_refund` (grant + persist ok) | `{userId, transactionId, amountCoins, reason, adminUserId}` |
| `iap_subscription_activated` | `iap_purchase` (sub path) | `{userId, productId, expiresAtUtc}` |
| `iap_subscription_renewed` | scanner | `{userId, originalTransactionId, expiresAtUtc}` |
| `iap_subscription_cancelled` | `iap_subscription_cancel` | `{userId, packId, cancelledAtUtc, expiresAtUtc}` |

### 4 admin analytics RPCs (D91 maintenance bypass + 60s cache)

| RPC | Input | Output |
|---|---|---|
| `admin_iap_analytics_get` | `{fromDate, toDate}` | `{totalInitiated, totalValidated, totalDelivered, totalFailed, validationRate, deliveryRate, totalRefunded, netRevenue, purchaseCount, uniqueBuyers, ...}` |
| `admin_iap_ltv_get` | `{cohortWeekStart, windows: ['7d'\|'30d'\|'90d']}` | `{cohortSize, ltv: {7d, 30d, 90d}, perPack[]}` |
| `admin_iap_funnel_get` | `{packId?, platform?, fromDate?, toDate?}` | `{stages: [3], byPack, byPlatform}` |
| `admin_iap_top_buyers_get` | `{fromDate, toDate, limit?}` | `{buyers: [{userId, username, totalSpent, ...}]}` — admin-only privacy (D92) |

The LTV cohort math (D93): `cohortWeekStart` is an ISO date (YYYY-MM-DD);
the cohort is users with their FIRST `iap_purchase_delivered` event in
`[cohortStart, cohortStart+7d)`. The 7d/30d/90d LTV windows are measured
from `cohortStart` (NOT from each user's first purchase).

`admin_iap_top_buyers_get` resolves usernames via `nk.accountGetId`
(try/catch — null/missing yields empty string). Operators match by
`userId` in the rare case the lookup fails.

---

## 9. Storage

| Collection | Owner | Schema |
|---|---|---|
| `iap_packs` | system | catalog (10 packs, frozen at boot) |
| `iap_purchases` | per-user | `{userId, packId, platform, productId, content, grantedAtUtc, idempotencyKey, isFirstTime, refunded?, refundedAtUtc?, refundedReason?, refundedByAdminId?}` (R=1, W=0) |
| `iap_first_purchase` | per-user | boolean marker (R=1, W=0) |
| `iap_transactions` | system, key `{platform}:{transactionId}` | `{userId, platform, transactionId, consumedAtUtc}` (R=0, W=0; T-24). Kept when the account is deleted: a store transaction is consumed once |
| `idem` | per-user | the durable key `iap_purchase:{platform}:{transactionId}` with the stored response |
| `iap_fraud_flags` | system | `{transactionId, claimedByUserId, conflictByUserId, packId, platform, detectedAtUtc, status, actionedAtUtc?, ...}` (R=1, W=0) |
| `iap_subscriptions` | per-user | `{userId, packId, productId, platform, originalTransactionId, latestTransactionId, activatedAtUtc, expiresAtUtc, autoRenewing, cancelledAtUtc?, monthlyCosmeticGranted, renewalHistory}` (R=1, W=0) |
| `analytics_events` | system | (see `docs/liveops.md`) |

The `iap_purchases.refunded` boolean is the only state field. The base
record is immutable post-grant (CAS updates use the row's `version`).

---

## 10. Error codes

| Code | Cause |
|---|---|
| `UNAUTHENTICATED` | `ctx.userId` missing |
| `BAD_REQUEST` | Missing/invalid field (platform, productId, receiptData, transactionId) |
| `NOT_FOUND` | Pack not in catalog for `(platform, productId)` |
| `CONFLICT` | Cross-user fraud collision; already refunded; refund window expired; `iap_subscription_cancel` on already-cancelled |
| `BAD_REQUEST` | Receipt rejected (`details.reason`: `INVALID_RECEIPT`, `PRODUCT_MISMATCH`, `PROVIDER_MISMATCH`, `EXPIRED`, `REFUNDED`, `PENDING`) |
| `SERVICE_UNAVAILABLE` | Verification could not run (`details.reason`: `NOT_CONFIGURED`, `NETWORK_ERROR`, `VERIFICATION_FAILED`) |
| `INTERNAL` | Unexpected verifier or wallet failure |

---

## 11. Gotchas

- **Cross-user detection is the `iap_transactions` index** (T-24): a hard
  guarantee for purchases delivered since T-24; older rows rely on a
  bounded scan (10 000 rows).
- **IAP cosmetics are not in `cosmetics.json`** — the five `cosmeticId` /
  `monthlyCosmeticId` values of `iap_packs.json` (`gem_pack_500`,
  `starter_bundle`, `paint_neon`, `trail_legendary`, `pass_exclusive_01`)
  are added to the bag as they are (as before T-24); deciding their
  catalog entries is a content decision.
- **First-time bonus dedup row is per `(userId, packId)`** — D65. Two
  different packs each get their own bonus (the row is
  `iap_first_purchase/{userId}_{packId}`).
- **`iap_purchase` needs a session** (D-03): the buyer is `ctx.userId`;
  it bypasses maintenance only (D63).
- **Apple sandbox auto-detect triggers ONE re-route** — sandbox receipts
  (TestFlight, review) are accepted by the production server, as Apple
  recommends.
- **Never ship `IAP_MOCK=true`** — with it any client can forge a JSON
  receipt. `npm run smoke:live` turns it on for one boot only and
  recreates Nakama on the `.env` values afterwards.
- **Inbox storage key format** is `${userId}/${rewardId}` — D89 follow-up.
  When iterating, the key for an IAP refund is `user-A/iap_refund:tx-X`.
- **top_buyers admin-only** — D92. The RPC returns `username` resolved
  via `nk.accountGetId` (try/catch). Operators should not surface the
  list to end users.
- **Maintenance bypass is opt-in per RPC** — `iap_purchase`,
  `iap_subscription_*`, `iap_ad_*`, and all 16 admin RPCs opt in (D63,
  D72, D77, D79, D91). End-user economy RPCs (car_buy, store_buy, etc.)
  honor the gate.
- **LTV cohort is weekly (7d fixed)** — D93. The 7d/30d/90d LTV windows
  measure from the cohort start, not from each individual user's
  purchase date.
