# LiveOps — CarVideoGameBackend

The LiveOps subsystem controls everything that can change after the
server is deployed: feature flags, maintenance windows, minimum client
version per platform, region routing, calendar events, the analytics
webhook, and the shared secrets used by the admin RPCs and the relay
token HMAC.

**Phase**: 5 (Chunks 1, 2, 6, 7, 8, 9)
**Source**: `modules/src/liveops/`

---

## 1. LiveOps config storage

The config is a single storage row at
`collection = "liveops"`, `key = "config"`, `userId = SYSTEM_USER_ID`.
There is **no in-memory cache** — every read goes through
`loadLiveopsConfig(nk, logger)`. The validation runs on every read;
invalid configs cause the reader to throw, and the calling RPC returns
`SERVICE_UNAVAILABLE`.

The bundled default lives at
`modules/src/catalogs/liveops_config.json` and is consulted by
`bootEnsure()` (init in `main.ts`). At boot the bundle writes the
default into storage when no row exists, so a fresh deploy always has
something to serve.

### Schema (`LiveopsConfig`, `modules/src/liveops/types.ts`)

```ts
{
  schemaVersion: 1,
  version: 1,                 // bumped on every admin override
  flags: { maintenance: false },
  minClientVersion: {
    ios:     "0.1.0",
    android: "0.1.0",
    windows: "0.1.0",
    macos:   "0.1.0",
    linux:   "0.1.0",
  },
  regions: [
    { id: "us-east-1", displayName: "US East",
      relayUrl: "wss://api.gapolaniadev.com" },
  ],
  calendar: [],               // future: events, tournaments
  adminRpcKey:    "p5v8-admin-key",        // shared secret for admin RPCs
  analyticsWebhook: "https://...",         // optional outbound POST target
  relayTokenSecret: "p5v8-region-relay-dev-secret-rotate-in-prod",
  nodeRole:        "home",                 // "home" | "relay"
}
```

| Field | Required | Notes |
|---|---|---|
| `flags.maintenance` | yes | When `true`, gated RPCs return `SERVICE_UNAVAILABLE` (see §2). |
| `minClientVersion.<platform>` | yes | Semver compare; stale clients receive `UPGRADE_REQUIRED`. |
| `regions[]` | yes (≥1) | Each region has `id` + `relayUrl`. v1 always returns the first; future: client picks. |
| `calendar[]` | no | Reserved for Phase 8 events/tournaments. Today: ignored. |
| `adminRpcKey` | yes for admin RPCs | Shared secret; see `docs/admin.md`. |
| `analyticsWebhook` | no | When set, every `emit()` does a best-effort POST. |
| `relayTokenSecret` | yes for relay split | HMAC-SHA-256 secret for the `relay_token` token (see `docs/unity-api.md` §18.7). |
| `nodeRole` | yes | `home` registers 28 RPCs; `relay` only registers `race_session_get` + `race_submit_result`. |

### Validation

`validate(raw)` in `modules/src/liveops/config.ts`:

- `flags.maintenance` MUST be a boolean.
- Each `minClientVersion.<platform>` MUST be a non-empty semver string.
- `regions` MUST be a non-empty array of `{id, relayUrl}`.
- `adminRpcKey`, when present, MUST be ≥ 16 chars.
- `analyticsWebhook`, when present, MUST start with `http://` or `https://`.
- `relayTokenSecret`, when present, MUST be ≥ 16 chars.
- `nodeRole` MUST be `'home'` or `'relay'`.

Validation runs on every read AND on every admin override. A malformed
override is rejected with the same code that the reader would throw.

---

## 2. Maintenance gate

`assertNotInMaintenance(logger, nk, userId, opts?)` in
`modules/src/core/liveops.ts`. When `flags.maintenance === true`, the
helper returns a `SERVICE_UNAVAILABLE` response which the calling RPC
serialises and returns to the client. Otherwise returns `null`.

### RPCs gated by maintenance

Gated RPCs and the wire code:

| RPC | Gated by | Notes |
|---|---|---|
| `wallet_get` | `liveopsGate` | min-version + maintenance |
| `garage_get`, `car_buy`, `car_upgrade`, `cosmetic_equip`, `loadout_set` | `liveopsGate` | min-version + maintenance |
| `store_get`, `store_buy` | `liveopsGate` | min-version + maintenance |
| `lb_get` | `liveopsGate` | min-version + maintenance |
| `account_link`, `account_link_resolve_conflict` | `liveopsGate` | min-version + maintenance |
| `inbox_claim` | `liveopsGate` | min-version + maintenance |
| `profile_get`, `profile_update` | `liveopsGate` | min-version + maintenance |
| `race_session_create`, `race_session_join`, `race_session_start` | `assertNotInMaintenance` | maintenance only — race RPCs don't carry ClientPlatform |
| `race_session_quick_bots`, `race_host_claim` | `assertNotInMaintenance` | maintenance only |
| `mm_ticket_params` | `assertNotInMaintenance` | MmPlatform ≠ ClientPlatform; min-version not enforced here |
| `ranked_get` | `assertNotInMaintenance` | maintenance only |

### RPCs NOT gated (always callable)

| RPC | Reason |
|---|---|
| `liveops_config_get` | Splash screen needs the lock + the config. |
| `inbox_list` | Badge / banner must render even during maintenance so the player sees what they're missing. |
| `account_delete` | **GDPR right to erasure — cannot be blocked by an operational pause.** |
| `admin_*` (5 RPCs) | `assertNotInMaintenance(..., { skipForAdmin: true })`. Admins can still send inbox grants, adjust wallets, clean up sessions during a maintenance window. |
| `relay_token` | `assertNotInMaintenance(..., { skipForAdmin: true })`. Clients need a relay URL/token even when the home is paused; admins mint tokens during ops drills. |

### Why some RPCs use `assertNotInMaintenance` directly

`liveopsGate` combines `assertNotInMaintenance` +
`assertMinClientVersion`. RPCs that carry `clientVersion` +
`platform: 'ios' | 'android' | 'windows' | 'macos' | 'linux'` use
`liveopsGate`. RPCs that carry `platform: 'mobile' | 'console' | 'pc'`
or no platform at all (race RPCs, matchmaking) use
`assertNotInMaintenance` only — the min-version check is orthogonal
and enforced where the input shape allows.

---

## 3. Min client version gate

`assertMinClientVersion(clientVersion, platform, cfg)` in
`modules/src/core/liveops.ts`. Semver compare (numerically, not
lexically): `1.2.10 > 1.2.9`. Stale clients receive
`UPGRADE_REQUIRED` with `details: { clientVersion, required, platform }`
so the client can show "update required".

Per-platform overrides exist so iOS can ship a hotfix without forcing
Android to update.

| Constant / file | Purpose |
|---|---|
| `MIN_VERSION_DEFAULT = '0.1.0'` (`core/liveops.ts`) | Used in unit tests + the default `minClientVersion` map. |
| `LiveopsConfig.minClientVersion.<platform>` | Per-platform required version. |

---

## 4. Calendar events (deferred)

`LiveopsConfig.calendar: CalendarEntry[]` is reserved for Phase 8
events/tournaments. v1 ships an empty list. The schema is open:

```ts
interface CalendarEntry {
  id: string;                // "season-launch-2026"
  kind: 'event' | 'tournament' | 'maintenance';
  startsAt: number;          // unix ms
  endsAt:   number;          // unix ms
  displayName: string;
  config?: Record<string, unknown>;
}
```

Validation accepts any array; readers are not wired today.

---

## 5. Bootstrap — how to set adminRpcKey + analyticsWebhook post-deploy

The admin RPCs cannot set their own key (chicken/egg). To install the
initial `adminRpcKey`, `relayTokenSecret`, or `analyticsWebhook`, use
one of:

1. **`liveops_config_override` ops tool** (recommended). The tool
   writes the storage row directly:
   ```
   collection: "liveops", key: "config", userId: SYSTEM_USER_ID
   value: { ..., adminRpcKey: "...", relayTokenSecret: "..." }
   ```
   The bundled `bootEnsure()` will NOT overwrite an existing row, so
   the override persists.

2. **A one-shot Node script** that calls `nk.storageWrite` against the
   running Nakama via its gRPC admin port (see
   `scripts/seed-liveops.ts`).

3. **Edit the bundled `modules/src/catalogs/liveops_config.json` and
   rebuild** — only viable for dev; production has the row locked.

Validation runs on the override; a malformed config is rejected.

To rotate `adminRpcKey`:

```
1. Write a new config row with adminRpcKey = NEW_KEY, version = N+1.
2. Wait 5s for any in-flight admin RPCs to settle.
3. Update your ops tool to send the new key.
4. (Optional) Remove the old key from the secret manager.
```

The reader does NOT cache, so the rotation is immediate.

---

## 6. Audit trail

Every server-side event lands in `analytics_events` storage
(`collection: "analytics_events"`, `key: "<ts>-<uuid>"`,
`permissionRead: 2`, `permissionWrite: 0`). When
`analyticsWebhook` is set, every `emit()` also fires a best-effort
`POST` to the configured URL.

Event name union (in `core/admin/analytics.ts`):

| Event | Source RPC / hook | Props |
|---|---|---|
| `admin_action` | any `admin_*` RPC | `rpcName, userId, reason, …` |
| `session_started` | `race_session_create` | `sessionId, hostId, mode, size, trackId` |
| `race_completed` | race close hook | `sessionId, mode, size, closedAt, durationMs, …` |
| `wallet_moved` | grant / spend | `userId, kind, delta, reason, newBalance` |
| `store_purchase` | `store_buy` | `userId, offerId, priceCoins, priceGems, finalBalance` |
| `matchmaker_matched` | matched hook | `sessionId, humanCount, botCount, ticketCount, ratingSpread` |
| `host_claimed` | `race_host_claim` | `sessionId, oldHost, newHost, withinGrace` |
| `profile_updated` | `profile_update` | `userId, changedFields[]` |
| `mm_ticket_params_called` | `mm_ticket_params` | `mode, segmentBy, version, region` |
| `account_linked` | `account_link` | `userId, provider, bonusClaimed` |
| `account_link_conflict` | `account_link` | `userId, provider` |
| `account_link_conflict_resolved` | `account_link_resolve_conflict` | `userId, choice, affectedAccountDeleted` |
| `account_deleted` | `account_delete` | `userId, summary{...}` |

### Querying (admin tool)

```ts
const rows = nk.storageList({
  collection: 'analytics_events',
  limit: 100,
  cursor: <opaque>,
});
// rows.objects.sort((a, b) => b.value.ts - a.value.ts);
```

### Webhook payload

```json
{
  "name":  "race_completed",
  "ts":    1762512000000,
  "id":    "1762512000000-<uuid>",
  "props": { "sessionId": "...", "mode": "ranked", ... }
}
```

Webhook failures (non-2xx, timeout, DNS) are logged at warn level and
the event still succeeds. There is no retry/queue today — that's
future work. See `modules/src/core/admin/analytics.ts`.

---

## 7. Region relay

Two node roles: `home` (full API, 28 RPCs) and `relay`
(`race_session_get` + `race_submit_result` only). The role is set via
`LiveopsConfig.nodeRole`.

- **Home**: client gets a session token, calls `relay_token` RPC,
  receives `{token, relayUrl, expiresAt, regionId}`. `relayUrl` points
  to the canonical region (v1: always the first region in the catalog).
- **Relay**: rejects unauthenticated sockets via
  `beforeAuthenticateDevice` unless `vars.relayToken` is a valid
  HMAC-SHA-256 token signed with `relayTokenSecret`. Verification is
  offline — no home round-trip.

Token wire format: `v1.<base64-payload>.<base64-sig>`. TTL: 60 minutes
(`RELAY_TOKEN_TTL_SEC`). `admin` RPCs + `relay_token` itself bypass
maintenance.

See `docs/unity-api.md` §18.7 and `modules/src/region/`.

---

## 8. Quick reference

| Task | File | Function |
|---|---|---|
| Read config (no cache) | `liveops/config.ts` | `loadLiveopsConfig(nk, logger)` |
| Validate raw | `liveops/config.ts` | `validate(raw): { ok, errors }` |
| Bundle default | `catalogs/liveops_config.json` | read at boot |
| Maintenance check | `core/liveops.ts` | `assertNotInMaintenance(logger, nk, userId, opts?)` |
| Min version check | `core/liveops.ts` | `assertMinClientVersion(version, platform, cfg)` |
| Combined gate | `core/liveops.ts` | `liveopsGate(logger, nk, userId, version, platform)` |
| Analytics emit | `core/admin/analytics.ts` | `emit(nk, logger, name, props, opts?)` |
| Audit wrapper | `core/admin/analytics.ts` | `emitAdminAction(nk, logger, rpcName, props)` |
| Region routing | `core/region.ts` | `isHome(nk, logger)` / `isRelay(nk, logger)` |
| Token sign/verify | `region/relay_token.ts` | `signRelayToken(nk, payload, secret)` / `verifyRelayToken(...)` |