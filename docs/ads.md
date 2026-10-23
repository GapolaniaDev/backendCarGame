# Ads — CarVideoGameBackend

Rewarded video ads, paid **only** by the ad network's signed
server-to-server (S2S) callback: LevelPlay (Unity's ironSource mediation),
plan T-25 / P-04, audit PC-05. Before T-25 `ad_watched` paid on the
client's own call (a "mock" check of the input shape), so any client could
mint coins.

**Phase**: 9 (Chunk 5 + 7 analytics), reworked in plan F7 (T-25)
**Source**: `modules/src/ads/` (`s2s_rpcs.ts`, `levelplay.ts`, `rpcs.ts`, `repo.ts`),
`modules/src/analytics/{iap_events,rpcs}.ts`

The Unity client does not call any ad RPC yet, so this contract is new;
the client OpenAPI (`docs/openapi/`) documents it.

---

## 1. Flow

```
client                         LevelPlay                         server (Nakama)
  │ show rewarded ad (SDK, userId = Nakama user id)                    │
  │──────────────────────────────▶│                                    │
  │ onAdRewarded (client side,    │ GET <callback URL>?userId=…&       │
  │   never trusted for money)    │   eventId=…&rewards=…&timestamp=…& │
  │                               │   signature=…  ───────────────────▶│ ads_levelplay_callback
  │                               │                                    │  verify signature, pay once
  │                               │◀──────────── 200 "…<eventId>:OK…"  │
  │ ad_reward_status (poll a few seconds after the ad closes) ────────▶│
  │◀───────────────────────────── rewards[], dailyCount, newBalance ───│
```

1. The client initialises the LevelPlay SDK with the **Nakama user id** as
   the LevelPlay user id (`[USER_ID]`).
2. After a completed rewarded ad, LevelPlay calls the S2S callback URL.
3. The server verifies the signature and pays the reward once per
   LevelPlay event id.
4. The client polls `ad_reward_status` (e.g. 2–3 times, 2 s apart) and
   shows the reward when the event appears; `ad_watched` is optional and
   never pays.

---

## 2. Catalog

`modules/src/catalogs/ad_rewards.json` (4 tiers):

| Tier | Coins | Cooldown (`ad_watched` era, unused by the callback) |
|---|---|---|
| `small` | 5 | 5 min |
| `medium` | 15 | 15 min |
| `large` | 30 | 30 min |
| `xlarge` | 60 | 60 min |

The callback's `rewards` amount must equal one of the tier coin amounts:
configure each LevelPlay placement's reward (dashboard) as 5, 15, 30 or 60.
Any other amount is acknowledged and **not** paid (`rejected_amount`), so
the economy stays server-controlled.

Daily cap (D75): **10 paid ad rewards per user per UTC day**, across tiers.
The 11th event of the day is acknowledged and not paid (`capped`).

---

## 3. `ads_levelplay_callback` (server-to-server)

Registered as an RPC and authenticated with Nakama's `http_key` (there is no
session: a call with a player session is `FORBIDDEN`). Configure in the
LevelPlay dashboard (Apps → *Set S2S callback*):

```
https://<api host>/v2/rpc/ads_levelplay_callback?http_key=<NAKAMA_RUNTIME_HTTP_KEY>&unwrap
    &userId=[USER_ID]&rewards=[REWARDS]&eventId=[EVENT_ID]
```

plus the timestamp and signature parameters LevelPlay adds (`timestamp`,
`signature`), and optionally `[PLACEMENT_NAME]`, `[AD_NETWORK]`,
`[ITEM_NAME]` (informational, not signed). Set the callback's **Private
Key** to the value of `LEVELPLAY_S2S_PRIVATE_KEY` in the server's `.env`.
`unwrap` makes Nakama return the RPC string as the raw HTTP body.

Nakama 3.27 accepts GET on `/v2/rpc/{id}` with `http_key` in the query
string and hands the remaining query parameters to the module as
`ctx.queryParams` (verified in `server/api_rpc.go`). A POST with the same
fields as a JSON object body is accepted too (manual replays, tests).

### Parameters

| Parameter | Signed | Notes |
|---|---|---|
| `userId` (or `applicationUserId`, `appUserId`) | yes | Nakama user id, URL-decoded before signing |
| `eventId` | yes | unique per completed ad (alphanumeric, ≤ 100) |
| `rewards` | yes | integer; must be a tier amount |
| `timestamp` | yes | `YYYYMMDDHHMM`, as sent (not checked for age: LevelPlay retries the same event for 8 days) |
| `signature` | — | `md5(timestamp + eventId + userId + rewards + privateKey)`, lower-case hex |
| `placementName`, `adNetwork`, `itemName` | no | stored with the event |

The signature formula and the response rule come from LevelPlay's public
documentation ("Server-to-server callback event handlers" and
"Server-to-server callback settings", docs.unity.com/grow/levelplay).

### Processing

1. A player session (`ctx.userId`) → `FORBIDDEN`.
2. `LEVELPLAY_S2S_PRIVATE_KEY` empty → `SERVICE_UNAVAILABLE`
   (`details.reason = NOT_CONFIGURED`): **every callback is rejected while
   the secret is empty**, including one signed with an empty key.
3. Missing / malformed parameters → `BAD_REQUEST`.
4. Signature mismatch → `FORBIDDEN` (`details.reason = BAD_SIGNATURE`),
   analytics `ad_watch_failed`. Comparison does not stop at the first
   differing character.
5. Unknown user (not a Nakama account) → acknowledged, not paid
   (`unknown_user`).
6. Event already recorded → acknowledged again, `idempotent: true`, not
   paid again.
7. Amount not a tier → recorded `rejected_amount`, acknowledged, not paid.
8. Daily cap reached → recorded `capped`, acknowledged, not paid.
9. Otherwise **one `moveWallet`** (plan T-11) under the durable key
   `ad_reward:levelplay:{eventId}`: the coins with their ledger row
   (`ad_reward`), the event row (`ad_s2s_rewards`, create-only) and the
   daily count (CAS). A concurrent duplicate loses the create and is
   answered as a repeat; a lost CAS is retried. Then an inbox notice
   (`ad_reward`, the reward is already paid) and analytics
   `ad_watch_granted`.

### Response

The body is the usual envelope. Success (also for repeats, capped,
rejected amounts and unknown users):

```json
{ "ok": true, "data": {
  "ack": "<eventId>:OK", "eventId": "…", "userId": "…",
  "status": "granted" | "capped" | "rejected_amount" | "unknown_user",
  "coinsGranted": 15, "idempotent": false } }
```

LevelPlay only needs HTTP 200 with `<eventId>:OK` somewhere in the body,
which `ack` provides. Errors (`FORBIDDEN`, `SERVICE_UNAVAILABLE`,
`BAD_REQUEST`, `CONFLICT` after repeated CAS losses) carry no `:OK`, so
LevelPlay retries them (20 times in 24 h, then daily for 7 days) and the
dashboard shows the failure. LevelPlay expects an answer within 400 ms; the
callback does a handful of storage reads and one transaction.

### Hardening left to the operator

- LevelPlay's documentation lists the IP addresses its callbacks come
  from; behind the Cloudflare tunnel the client IP Nakama sees is the
  tunnel's, so an IP allow-list belongs in Cloudflare (WAF rule on
  `/v2/rpc/ads_levelplay_callback`), not in the module.
- The `http_key` travels in the callback URL (that is how Nakama
  authenticates server-to-server RPCs). It also opens every other
  `http_key` RPC, all of which require their own secret (`admin_*`) or
  refuse to run without a session.

---

## 4. `ad_reward_status` (player)

```http
POST /v2/rpc/ad_reward_status          Authorization: Bearer <session>
"{\"sinceUtc\": 1761200000000, \"limit\": 20}"     // both optional
```

```ts
{
  rewards: [{ network: 'levelplay', eventId, status, coins, rewards, tier?,
              placementName?, adNetwork?, receivedAtUtc }],   // newest first
  dailyCount: 3,          // paid rewards today (UTC)
  dailyCap: 10,
  dailyResetAtUtc: 1761264000000,
  newBalance: { coins, gems }
}
```

`sinceUtc` filters to events received after it (`receivedAtUtc >
sinceUtc`); `limit` is 1–50 (default 20). The client remembers the time it
showed the ad and polls with it.

---

## 5. `ad_watched` (player, does not pay)

```http
POST /v2/rpc/ad_watched
{ "tier": "small"|"medium"|"large"|"xlarge",
  "provider": "levelplay"|"mock"|"admob"|"unityads",
  "adUnitId": "…", "impressionId": "…" (1–128), "watchedAtUtc": 1700000000000 }
```

Validates the input, emits `ad_watch_initiated` and answers:

```ts
{ rewardId, tier, coinsGranted: 0, granted: false, rewardVia: 'server_callback',
  newBalance: { coins, gems }, nextEligibleAtUtc: now, dailyCount, dailyCap: 10,
  idempotent: false }
```

It never moves the wallet, writes no sidecar rows and has no cooldown.
`granted` and `rewardVia` are new fields; `coinsGranted` is always 0.
Errors: `UNAUTHENTICATED`, `FORBIDDEN` (foreign `callerUserId`),
`BAD_REQUEST`, `NOT_FOUND` (unknown tier). Bypasses maintenance (D77).

---

## 6. Storage

| Collection | Owner | Schema |
|---|---|---|
| `ad_s2s_rewards` | per-user, key `levelplay:{eventId}` | `{network, eventId, status, coins, rewards, tier?, placementName?, adNetwork?, receivedAtUtc}` (R=1, W=0; T-25) |
| `ad_daily_count` | per-user, key `{userId}/{utcDate}` | `{count, lastUpdatedUtc}` (R=1, W=0) |
| `ad_last_watched`, `ad_watch_log` | per-user | rows written by the old paying `ad_watched`; no longer written |
| `idem` | per-user | the durable key `ad_reward:levelplay:{eventId}` (`core/idempotency.ts`) |

All are server-only (permission write 0; the storage hook refuses client
writes, T-18) and purged with the account (T-16).

---

## 7. Analytics

| Event | Fired from | Payload |
|---|---|---|
| `ad_watch_initiated` | `ad_watched` | `{tier, provider, adUnitId, transactionId=impressionId}` |
| `ad_watch_granted` | `ads_levelplay_callback` (paid) | `{transactionId=eventId, tier, adUnitId=placementName, amountCoins}` |
| `ad_watch_failed` | `ad_watched` (bad input), callback (bad signature) | `{errorCode, failureReason}` |

`admin_iap_analytics_get` aggregates `ad_watch_granted` into
`adWatchCount` / `adCoinsGranted`. `ad_watch_blocked` is no longer emitted.

---

## 8. Configuration

| `.env` / `runtime.env` | Meaning |
|---|---|
| `LEVELPLAY_S2S_PRIVATE_KEY` | the callback's Private Key; **empty = every callback rejected** (default) |
| `NAKAMA_RUNTIME_HTTP_KEY` | the `http_key` in the callback URL |

`docker-compose.yml` writes it into `runtime.env` of the generated
`nakama.yml`; change `.env` and recreate Nakama (always with the local
override when running locally:
`docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate nakama`).

Local testing without LevelPlay: `npm run smoke:live` recreates Nakama for
one boot with a random test key, sends signed GET callbacks itself and
recreates it again on the `.env` values. No LevelPlay server is contacted.
With real keys, use the dashboard's *Callback test* (human step).

---

## 9. Gotchas

- **The client's `onAdRewarded` is not proof.** Show the reward only when
  `ad_reward_status` lists the event; a callback can arrive a few seconds
  after the ad closes.
- **`[USER_ID]` must be the Nakama user id**; any other id is acknowledged
  as `unknown_user` and nobody is paid.
- **Daily cap is UTC**, as before (D75).
- **Amounts are tiers**: a dashboard reward that is not 5/15/30/60 pays
  nothing (logged at warn level with the amount).
- **Old rows**: `ad_watch_log` / `ad_last_watched` from the paying
  `ad_watched` stay until the account is deleted.
