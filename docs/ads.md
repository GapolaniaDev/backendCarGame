# Ads — CarVideoGameBackend

Rewarded video ads. Four tiers, MOCK provider only in dev (real
AdMob / Unity Ads integration is a Phase 10+ gap, D76).

**Phase**: 9 (Chunk 5 + 7 analytics)
**Source**: `modules/src/ads/`, `modules/src/analytics/{iap_events,rpcs}.ts`

---

## 1. Catalog

`ad_rewards` collection (system-owned), `modules/src/catalogs/ad_rewards.json`
(4 bundled tiers). Schema:

```ts
{
  schemaVersion: 1,
  tiers: [{
    tier: 'small' | 'medium' | 'large' | 'xlarge',
    coins: 5,           // 5/15/30/60
    cooldownSeconds: 300  // 5/15/30/60 min
  }]
}
```

### Tiers (4 total)

| Tier | Coins | Cooldown |
|---|---|---|
| `small` | 5 | 5 min |
| `medium` | 15 | 15 min |
| `large` | 30 | 30 min |
| `xlarge` | 60 | 60 min |

Cooldowns are per-tier, per-user. Daily cap (D75) is per-user, across all
tiers.

---

## 2. `ad_watched`

```http
POST /v2/rpc/ad_watched
{ "callerUserId": "<uuid>", "body": {
    "tier": "small" | "medium" | "large" | "xlarge",
    "provider": "mock" | "admob" | "unityads",
    "adUnitId": "rewarded_coins_v1",
    "impressionId": "550e8400-e29b-41d4-a716-446655440000",  // client-generated UUID v4
    "watchedAtUtc": 1700000000000  // client clock
} }
```

Returns:

```ts
{
  rewardId: 'impression-id',
  tier: 'small',
  coinsGranted: 5,
  newBalance: 5,
  nextEligibleAtUtc: 1700000300000,  // now + 5min
  dailyCount: 1,
  dailyCap: 10,
  idempotent: false
}
```

### Order of operations

1. **Auth** — `ctx.userId` required.
2. **Input validation** — all 5 fields required; `tier` enum; `provider` enum; `impressionId` UUID v4; `watchedAtUtc` finite number.
3. **Tier lookup** — `findAdRewardTier(tier)` → `NOT_FOUND` if missing.
4. **Idempotency** — `ad_watch_log/{userId}/{impressionId}` already exists → return cached.
5. **Mock verify** — `verifyAdMock(provider, adUnitId, impressionId, watchedAtUtc, nowUtc)` — validates UUID v4 format + ≤60s future skew.
6. **Cooldown** — `ad_last_watched/{userId}/{tier}` → if `now < lastWatchedAtUtc + cooldown` → `CONFLICT`.
7. **Daily cap** — `ad_daily_count/{userId}/{utcDate}` → if `count >= 10` → `CONFLICT`.
8. **Grant** — `wallet.grant({coins: tier.coins}, 'ad_reward', idemKey='ad_watch:{impressionId}')`.
9. **Sidecars** — write `ad_last_watched` + bump `ad_daily_count` + `ad_watch_log`.
10. **Inbox** — `ad_reward` reward with `{coins, note: 'ad reward ({tier})'}`.
11. **Analytics** — `ad_watch_granted` event (plus `ad_watch_initiated` at step 3 and `ad_watch_blocked`/`ad_watch_failed` on the rejection paths).

### Maintenance bypass (D77)

`ad_watched` bypasses the maintenance gate (player already watched the
ad, the server must still credit the reward).

---

## 3. Provider: MOCK only (D76)

The `verifyAdMock` path validates input shape only — it does NOT contact
AdMob / Unity Ads. The production paths (`admob`, `unityads`) are
registered as enum values but the implementation is a stub that returns
`INVALID_PROVIDER`. The `liveops.config` carries no real `adProvider` block
yet.

When real ad SDK integration is added (post-Phase 9), the verify path
will be extended to call the server-to-server callback endpoint
(`/ads/callback`) with the network's signed receipt.

---

## 4. Cooldowns + daily cap

### Cooldown (per-tier, per-user)

`ad_last_watched/{userId}/{tier}` carries `{lastWatchedAtUtc, lastImpressionId}`.
A second ad of the same tier before the cooldown expires returns
`CONFLICT: cooldown not elapsed for tier {tier}` (D74).

The cooldown is tier-specific — a player who watched a `small` can
immediately watch a `medium` (different tier has its own `ad_last_watched`
row).

### Daily cap (D75)

`ad_daily_count/{userId}/{utcDate}` carries `{count, lastUpdatedUtc}`.
`utcDate` is `YYYY-MM-DD` in UTC. The cap is **10 per user per UTC day**
across all tiers. The 11th ad of the day returns
`CONFLICT: daily ad cap reached`.

The cap resets at UTC midnight (NOT at the player's local midnight). This
keeps the analytics consistent across the player base.

### Cap-first check

The cooldown + cap check happens **before** the wallet grant. So a
rejected ad does NOT consume the cooldown — a player who hits the cap
on the 10th `small` ad can still try a `medium` 1 second later (different
tier, different cooldown), but if they're also at the daily cap the
`medium` is blocked too.

---

## 5. Idempotency

`ad_watch_log/{userId}/{impressionId}` is the source of truth. The
`impressionId` is a client-generated UUID v4; the same id within the
lifetime of the row returns the cached response with `idempotent: true`
(D73).

The 24h window is implicit — the row lives forever until an operator
clears it (no auto-cleanup in Chunk 5; the daily scanner could prune
old rows in a future chunk if the collection grows).

---

## 6. Storage

| Collection | Owner | Schema |
|---|---|---|
| `ad_rewards` | system | catalog (4 tiers, frozen at boot) |
| `ad_last_watched` | per-user | `{lastWatchedAtUtc, lastImpressionId}` (R=1, W=0) |
| `ad_daily_count` | per-user | `{count, lastUpdatedUtc}` (R=1, W=0) |
| `ad_watch_log` | per-user | `{tier, adUnitId, provider, watchedAtUtc, grantedAtUtc, coinsGranted, newBalance, idempotencyKey}` (R=1, W=0) |
| `analytics_events` | system | (see `docs/liveops.md`) |

All four ad collections are server-only. Clients see results only via
the RPC response.

---

## 7. Analytics (Phase 9 Chunk 7)

4 new `AnalyticsEventName` variants fire from the ad pipeline:

| Event | Fired from | Payload |
|---|---|---|
| `ad_watch_initiated` | `ad_watched` (input parse ok) | `{tier, provider, adUnitId, transactionId=impressionId}` |
| `ad_watch_granted` | `ad_watched` (grant ok) | `{transactionId, tier, adUnitId, amountCoins}` |
| `ad_watch_blocked` | `ad_watched` (cooldown OR daily cap) | `{tier, failureReason: 'cooldown'\|'daily_cap'}` |
| `ad_watch_failed` | `ad_watched` (input / mock verify / unknown tier) | `{errorCode, failureReason}` |

The `ad_watched` RPC also fires the legacy `ad_watched` event (Phase 5
Chunk 6 — different name) for backwards compat. The new 4 events
(Chunk 7) provide the more granular conversion signal.

### Admin analytics: adWatchCount + adCoinsGranted

`admin_iap_analytics_get` aggregates `ad_watch_granted` events into
`adWatchCount` and `adCoinsGranted` (per the date range). Combined with
the IAP counts in the same response, operators get a single
"revenue + ad revenue" view of a day.

---

## 8. Error codes

| Code | Cause |
|---|---|
| `UNAUTHENTICATED` | `ctx.userId` missing |
| `BAD_REQUEST` | Missing/invalid field (tier, provider, adUnitId, impressionId, watchedAtUtc) |
| `NOT_FOUND` | Tier not in catalog |
| `CONFLICT` | Cooldown not elapsed; daily cap reached; idempotency collision (rare path) |
| `INTERNAL` | Mock verify failure (UUID v4 format, future watchedAtUtc) |

The ad pipeline is INTENTIONALLY simple — there's no `INSUFFICIENT_FUNDS`
path (ads are free) and no `RATE_LIMITED` (the cap/cooldown ARE the rate
limiters).

---

## 9. Gotchas

- **adUnitId is NOT validated** — D76. The field is passed through to
  the analytics event but not matched against a catalog. When real
  AdMob is wired up, this becomes the `AdMob-adunit-code`.
- **UUID v4 + 60s skew tolerance** — `verifyAdMock` accepts UUIDs that
  match the RFC 4122 v4 layout and `watchedAtUtc` within ±60s of the
  server clock. A clock-skewed client will get `INTERNAL` until it
  resyncs.
- **Daily cap is UTC, not local** — D75. A player in Tokyo at 23:50
  local time (14:50 UTC) who hits the cap sees the cap lifted at 00:00
  UTC, NOT at 00:00 JST.
- **Tier order matters for `findAdRewardTier`** — the catalog loader
  is sorted by `coins` ascending. Lookup is by tier name, NOT by coins
  amount, so a tier rename is a breaking change.
- **The legacy `ad_watched` event** (from Phase 5 Chunk 6) is STILL
  emitted alongside the new `ad_watch_granted`. Both end up in
  `analytics_events`; dashboards that count "ads watched" should use
  `ad_watch_granted` (the new clean name).
- **Cooldown rows are per-(user, tier)** — not per-impression. A
  rejected ad does NOT reset the cooldown.
- **Inbox message is idempotent** — the inbox `sendReward` call uses
  the same idempotency key as the wallet grant (`ad_watch:{impressionId}`).
  The same impression never produces two inbox messages.
- **`ad_watched` is a home-only RPC** — D77. The maintenance gate
  doesn't apply.
