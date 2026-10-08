# IAP — CarVideoGameBackend

In-app purchases (real money → coins/gems/cosmetics/cars/subscription).
Three product kinds, ten catalog packs, single mock verification provider
in dev (Apple sandbox + Google pre-signed bearer in production).

**Phase**: 9 (Chunks 1-6 + 7 analytics)
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
POST /v2/rpc/iap_purchase
{ "callerUserId": "<uuid>", "body": {
    "platform": "apple" | "google",
    "productId": "com.cvg.coins100",
    "receiptData": "<base64-receipt>",  // required, opaque to server
    "transactionId": "tx-abc-123"       // client-generated dedup key
} }
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

1. **Auth** — `ctx.userId` required (`UNAUTHENTICATED` otherwise).
2. **Input validation** — all 4 fields required + `platform` enum + `productId` non-empty.
3. **Catalog lookup** — `findIapPackByProductId(platform, productId)` → `NOT_FOUND` if missing.
4. **Cross-user fraud scan** — see §5.
5. **Idempotency check** — `iap_purchases/{transactionId}` already exists → return cached.
6. **Receipt verification** — `verifyReceipt({...}, {config: liveops.iapVerification, ...})`.
7. **Plan + grant** — `planGrant(pack, isFirstTime)` → `wallet.grant(..., 'iap')` with idempotencyKey `iap_purchase:{txId}`.
8. **Persist** — `iap_purchases/{txId}` + `iap_first_purchase/{userId}_{packId}` (if first time).
9. **Inbox** — `iap_purchase` reward for the wallet portion.
10. **Analytics** — see §9.

### Maintenance bypass (D63)

`iap_purchase` is registered as a home-only RPC and **bypasses the
maintenance gate** — money has already been charged, the server must
still deliver the product.

### Idempotency

The dedup key is `(userId, transactionId)`. The storage row at
`iap_purchases/{transactionId}` is `permissionRead=1, permissionWrite=0`
(server-only). A replay returns the same response with
`idempotent: true` (D67 — no audit on re-emit).

---

## 3. Receipt verification

`verifyReceipt` (Phase 9 Chunk 2) routes to the configured provider:

| Provider | Use case | Mechanism |
|---|---|---|
| `mock` | Dev, e2e tests | Validates input shape + UUID v4 + 60s future skew |
| `apple` | iOS production | Apple App Store Server API, sandbox auto-detect on 21007 |
| `google` | Android production | Google Play Developer API, pre-signed bearer (no in-runtime JWT) |

The `iapVerification` block is on the `LiveopsConfig` and is hot-swappable
(no restart). Operator sets it via the admin override path (see `docs/liveops.md` §5).

### Sandbox detection (Apple)

When Apple's `verifyReceipt` returns `status: 21007` (sandbox receipt sent
to production endpoint), the dispatcher auto-re-routes to
`https://sandbox.itunes.apple.com/verifyReceipt` (D63 follow-up). This
lets the same key work for both TestFlight and App Store builds.

### Idempotency in verify cache

`verifyReceipt` keeps a sha256(platform+txId) dedup cache for **24h** so
the same receipt within the window skips the upstream call. The cache
lives in module-scope memory (D61).

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

Before any verification, the server checks the 4 most recent `iap_purchases`
rows for the same `transactionId` with a different `userId`. If found:

1. The current request returns `CONFLICT: duplicate transaction id`.
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
| `INTERNAL` | Receipt verification failure (`VERIFICATION_FAILED`, `INVALID_RECEIPT`, `TRANSACTION_NOT_FOUND`, etc.) |
| `SERVICE_UNAVAILABLE` | IAP provider not configured (admin key path only) |

---

## 11. Gotchas

- **Cross-user fraud detection uses storageList with 1-arg shape** — D64.
  The recent-4 window is best-effort, NOT a hard guarantee. Operators
  audit the `iap_fraud_flags` collection weekly.
- **First-time bonus dedup row is per `(userId, packId)`** — D65. Two
  different packs each get their own bonus (the row is
  `iap_first_purchase/{userId}_{packId}`).
- **`iap_purchase` ignores the `server` context userId check** — D63. A
  client can be in any state (logged-in, anonymous, etc.) and the RPC
  will still credit if the wallet exists.
- **Apple sandbox auto-detect triggers ONE re-route** — if the retry
  also returns 21007 the dispatch fails as `INTERNAL`. The operator
  should swap the liveops config to the production endpoint.
- **The 24h verify cache is module-scope** — restart wipes it. Long
  outages may see more upstream calls than expected.
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
