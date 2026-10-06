# Unity Integration API — CarVideoGameBackend (Phase 1 + Phase 2)

API reference for the Unity racing-game client. Covers auth, RPC contracts, the
`RaceCompleted` event payload (now also drives leaderboard writes), storage
collections, and catalog shapes.

**Status:** Phase 1 (race session + results), Phase 2 (leaderboards +
profile), Phase 3 (economy + garage + store), and Phase 4 (matchmaking
+ ranked) are all shipped. Phase 5 (LiveOps + account delete +
admin RPCs) is next.

---

## 1. Endpoints & transport

| Channel | URL / transport | Notes |
|---|---|---|
| Production (Cloudflare tunnel) | `https://api.gapolaniadev.com` | Public-facing |
| | Standalone (dev) | `http://localhost:8081` | Direct to Nakama HTTP gateway |
| Socket (relay match) | `wss://api.gapolaniadev.com` | Relay-pure match; Phase 1 doesn't inspect match frames |

**Server key** (HTTP Basic auth, see §3): `NAKAMA_SERVER_KEY` from `.env`.
**HTTP key** (query string on every RPC, server-side admin gate): `NAKAMA_RUNTIME_HTTP_KEY` from `.env`.

Both are server-side only. The client gets a **session token** after authentication
(`POST /v2/account/authenticate/device`) and passes it as `Authorization: Bearer <token>`.

---

## 2. Authentication (device ID flow)

```http
POST /v2/account/authenticate/device
Authorization: Basic base64(SERVER_KEY:)
Content-Type: application/json

{ "id": "<opaque-device-id-from-user>" }     // any stable string per device
```

**Response**:
```json
{
  "token":   "<session JWT — use as Bearer>",
  "refresh_token": "<JWT>",
  "user_id": "<uuid>",
  "expires_at": 1740000000
}
```

- Use the JWT as `Authorization: Bearer <token>` on every subsequent HTTP call.
- The same JWT works for sockets; pass it in the WebSocket connect frame.
- **The server does NOT inject `ctx.userId` over HTTP.** Every RPC that needs the
  caller's userId takes it in the body) — see §6.

---

## 3. Response envelope

Every RPC returns a JSON-string envelope. Clients branch on `ok`.

```ts
type Ok<T>  = { ok: true;  data: T };
type Err    = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };
type Resp<T>= Ok<T> | Err;
```

**Important:** the HTTP gateway requires the RPC body to be a **JSON string**, not a
JSON object. Send `""` (empty) for no payload, or `"<json-stringified-input>"` for input.

```bash
# ❌ wrong — returns "json: cannot unmarshal object into Go value of type string"
-d '{}'

# ✅ correct (no payload)
-d ''

# ✅ correct (with payload)
-d '{"matchId":"...","mode":"quick"}'
```

---

## 4. Error codes

| Code | When |
|---|---|
| `BAD_REQUEST` | Malformed payload, missing field, wrong type, business-rule violation in input (e.g. size not allowed) |
| `UNAUTHENTICATED` | No/invalid session token |
| `FORBIDDEN` | Authz violation: caller is not host, not on roster, or impersonation attempt |
| `NOT_FOUND` | `sessionId` not in storage, or `lastClosed` index has no entry |
| `CONFLICT` | State transition not allowed (`start` when not `created`, `join` when full, second `start`, etc.) |
| `RATE_LIMITED` | Per-userId/per-RPC window exceeded |
| `INVALID_RESULT` | `race_submit_result` failed step-2 plausibility (clock, min time, lap sum) |
| `INTERNAL` | Uncaught server error — message is safe to surface; details may have stack |
| `CATALOG_INVALID` | **Fatal at boot** — Nakama exits non-zero; the server is unreachable |

Nakama's gRPC status stays `OK` on `Err` envelopes — branch on `ok`, not on status code.

---

## 5. Storage collections

| Collection key | Owner | Perms | Schema version | Notes |
|---|---|---|---|---|
| `race_sessions/{sessionId}` | server (system userId) | 0/0 | 1 | One per race. Persisted until admin cleanup (RPC, HTTP-key protected). |
| `race_sessions/{sessionId}/reports/{userId}` | server | 0/0 | 1 | One per participant per race. Server-managed; clients never write. |
| `profiles/{userId}` | per-user | 0/0 | 1 | **Phase 2** — auto-created on first auth. `displayName` (2-20), `avatarUrl` (≤ 512), `schemaVersion`, timestamps. |
| `catalogs/tracks`, `catalogs/modes`, `catalogs/leaderboards`, `catalogs/profiles` | server (system) | 0/0 | 1 | Loaded at boot, immutable after. |

**`RaceSession` schema** (`race_sessions/{sid}`):

```ts
interface RaceSession {
  schemaVersion: 1;
  id: string;
  matchId: string;          // Nakama match ID (relay)
  mode: 'quick' | 'ranked' | 'private' | 'time_trial';
  trackId: string;
  size: 1 | 2 | 4 | 6;
  roster: RosterEntry[];
  host: string;             // userId of current host
  hostSuccession: string[]; // ascending RTT; Phase 1 unused
  state: 'created' | 'started' | 'closing' | 'closed';
  startedAt: number | null; // server epoch-ms when 'started' was accepted
  results: RaceResult[];    // sorted by rank (DNFs last)
  flags: { needsReview: boolean; reviewReason?: string };
  version: number;          // monotonic CAS counter
}
```

---

## 6. RPCs

All RPCs are `POST /v2/rpc/<name>?http_key=<HTTP_KEY>` with
`Authorization: Basic base64(SERVER_KEY:)` and JSON-string body.

### 6.1 `config_get`

Public catalog + clock sync. **No auth required for the payload**, but the HTTP
gateway still requires `Authorization` (use the session Bearer, or any token).

```json
// body
" ""  (empty string — RPC takes no input)

// response.data
{
  "serverTimeMs":     1740000000000,
  "catalogsHash":     "sha256-of-catalogs-blob",
  "tracks":           [ ... track objects ... ],
  "modes":            [ ... mode objects ... ],
  "minClientVersion": "1.0.0"
}
```

`serverTimeMs` is used by the client to compute its clock offset vs the server
(median of N samples). `minClientVersion` lets the server force client upgrades.

### 6.2 `race_session_create`

Host creates the session and locks in roster size + loadout.

```json
// body
"{\"matchId\":\"<nakama-match-id>\",\"mode\":\"quick\",\"trackId\":\"neon_blvd\",\"size\":4,\"hostLoadout\":{\"classId\":\"C\",\"bodyId\":\"starter_viper\"},\"hostUserId\":\"<uuid>\"}"

// response.data
{
  "sessionId":        "<uuid>",
  "rosterVersion":    1,
  "hostSuccession":   ["<uuid>", "<uuid2>", ...]
}
```

**Authz**: `hostUserId` MUST match `ctx.userId` when the request comes via an
authenticated socket; on mismatch → `FORBIDDEN`. Over HTTP gateway, `ctx.userId`
is null so the server trusts your declared `hostUserId` (the gateway already
authenticated the caller via Bearer token).

Errors: `BAD_REQUEST` (size not in `mode.allowedSizes`, trackId not in catalog),
`CONFLICT` (a live session with the same `matchId` exists).

### 6.3 `race_session_join`

Each non-host player joins the session.

```json
// body
"{\"sessionId\":\"<uuid>\",\"userId\":\"<uuid>\",\"callerUserId\":\"<uuid>\",\"loadout\":{\"classId\":\"C\",\"bodyId\":\"starter_viper\"}}"

// response.data
{ "rosterVersion": 2, "rosterSize": 2 }
```

**Authz**:
- `userId === callerUserId` (impersonation protection; mismatch → `FORBIDDEN`)
- Caller not already in roster
- Session state is `created`
- `roster.length < size` (capacity)

Errors: `FORBIDDEN`, `NOT_FOUND` (no session), `CONFLICT` (full, duplicate, or not in `created`).

### 6.4 `race_session_start`

Host-only. Seals `startedAt` with the server clock and returns it.

```json
// body
"{\"sessionId\":\"<uuid>\",\"callerUserId\":\"<host-uuid>\"}"

// response.data
{ "startedAt": 1740000005000 }
```

**Authz**: `callerUserId === session.host` (mismatch → `FORBIDDEN`). Session must
be in `created` (already-started → `CONFLICT`).

The client should start its local countdown at `serverNow + (clientClockSkewMs)`,
not at the moment of the call, to be fair across machines with skewed clocks.

Errors: `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`.

### 6.5 `race_session_get`

Returns the live session, plus (Phase 1, Chunk 6) the most recent closed session
the caller participated in.

```json
// body — omit sessionId to get the caller's active session
"{\"callerUserId\":\"<uuid>\"}"
// or
"{\"sessionId\":\"<uuid>\",\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "session":   { /* full RaceSession */ },
  "lastClosed": { /* optional RaceSession — null/undefined if none */ }
}
```

**Authz**: caller must be in `session.roster` (over socket `ctx.userId` is used;
over HTTP, `callerUserId` is required). Omitting `sessionId` returns the caller's
**active** session via an index; if they don't have one → `NOT_FOUND`.

The `lastClosed` lookup is wired but returns `NOT_FOUND` until Chunk 9 (close +
quorum + RaceCompleted emission) finishes — currently active sessions are returned
without a `lastClosed` value.

Errors: `NOT_FOUND`, `FORBIDDEN`.

### 6.6 `race_submit_result`

Per-player report of lap times. **Stub in Phase 1** (Chunk 7 in progress). When
landed, the contract is:

```json
// body
"{\"sessionId\":\"<uuid>\",\"report\":{\"userId\":\"<uuid>\",\"totalMs\":47000,\"laps\":[15500,15500,16000],\"isBotReport\":false},\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "accepted":   true,
  "confidence": "quorum" | "client" | "server",
  "officialResults": [ /* RaceResult[] — present only when this submit closed the session */ ],
  "flags":      { "needsReview": false, "reviewReason": null }
}
```

**Authz**: when `ctx.userId` is set (socket), it must match `report.userId`; over
HTTP, `callerUserId` must match `report.userId`. `isBotReport=true` only
accepted from host (`session.host` === `report.userId`).

**Validations (step-2, Chunk 8)**:
- `report.userId` in `session.roster`
- Session state ∈ {`started`, `closing`}
- Idempotency: same `report.userId` already has `reportedAt` → `CONFLICT`
- Clock: `report.totalMs` ≤ `now - session.startedAt`
- Min time: `report.totalMs` ≥ `track.minTimeMsByClass[loadout.classId]`
- Lap sum: `sum(laps) === report.totalMs`
- Lap count: `laps.length === mode.laps`

Errors: `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_RESULT`.

---

### 6.7 `lb_get` — Phase 2

Read a leaderboard with one of three views and get profile enrichment in the
same response.

```json
// body
"{\"leaderboardId\":\"tt_neon_blvd_B_all\",\"view\":\"global\",\"limit\":20,\"callerUserId\":\"<uuid>\"}"
// view ∈ { "global", "around_me", "friends" }
// aroundUserId optional — defaults to caller. Used by `around_me` to center.

// response.data
{
  "leaderboardId": "tt_neon_blvd_B_all",
  "view":          "global",
  "totalCount":    237,
  "records": [
    {
      "ownerId":  "<uuid>",
      "rank":     1,
      "score":    87420,
      "subscore": 1740000000000,
      "metadata": {
        "__server_token__": "phase2",
        "sessionId":        "<uuid>",
        "mode":             "quick",
        "confidence":       "quorum",
        "isBot":            false,
        "car":              "starter_viper"
      }
    }
    // …
  ],
  "ownerRecord": { /* same shape as a record; null when caller has no record */ },
  "profiles": {
    "<uuid>": { "userId": "<uuid>", "displayName": "Hugo", "avatarUrl": "https://cdn/avatar.png" }
    // users without a profile fall back to { userId, displayName: userId, avatarUrl: null }
  }
}
```

**View semantics**:

| View | Returns | Notes |
|---|---|---|
| `global` | top-N sorted by `score asc, subscore asc` | `ownerRecord` = caller's own row or `null` |
| `around_me` | band of `limit/2` on each side of the caller | clamped to array bounds; falls back to top-N when caller has no record (NOT a 404) |
| `friends` | stub: just the caller | real friend graph lands in a later phase |

**`limit`**: clamped to `[1, 100]`, default 20.

**Authz**: `callerUserId` MUST match `ctx.userId` when present (over socket);
over HTTP gateway it's authoritative. Mismatch → `FORBIDDEN`.

Errors: `BAD_REQUEST` (missing leaderboardId / unknown view), `UNAUTHENTICATED`
(no caller), `FORBIDDEN` (caller mismatch), `NOT_FOUND` (unknown leaderboardId).

### 6.8 `profile_get` — Phase 2

Returns the caller's profile. Auto-creates a default profile (`displayName =
"Racer"`, `avatarUrl = null`) on first read.

```json
// body
"{\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "profile": {
    "userId":      "<uuid>",
    "displayName": "Racer",
    "avatarUrl":   null,
    "createdAt":   1740000000000,
    "updatedAt":   1740000000000
  }
}
```

**Authz**: `callerUserId` MUST match `ctx.userId` on socket; mismatch →
`FORBIDDEN`.

Errors: `FORBIDDEN`, `UNAUTHENTICATED`.

### 6.9 `profile_update` — Phase 2

Update the caller's profile. CAS via storage `version`. Validation rules from
`catalogs/profiles.json`:

- `displayName` — 2-20 chars, pattern `^[A-Za-z0-9 _\-.]+$`, blocked-words
  list (case-insensitive whole-token match)
- `avatarUrl` — ≤ 512 chars

```json
// body
"{\"displayName\":\"Hugo Fast\",\"avatarUrl\":\"https://cdn.example/avatar.png\",\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "profile": { /* same shape as profile_get */ }
}
```

**Authz**: `callerUserId` MUST match `ctx.userId` on socket. **Spoof defense**:
the payload MUST NOT carry a `userId` field that differs from the caller (any
mismatch → `FORBIDDEN`).

Errors: `BAD_REQUEST` (length, pattern, avatarUrl too long), `FORBIDDEN`
(caller mismatch, spoofed userId, blocked word), `CONFLICT` (CAS — retry).

---

## 7. RaceCompleted event (socket-only)

Subscribed automatically when the player joins a match; emitted by the server
**exactly once per session**, at close. Shape:

```ts
interface RaceCompletedEvent {
  schemaVersion: 1;
  sessionId: string;
  mode: 'quick' | 'ranked' | 'private' | 'time_trial';
  trackId: string;
  size: 1 | 2 | 4 | 6;
  results: Array<{
    rank: number;        // 1-indexed; DNFs share rank after last finisher
    userId: string;
    isBot: boolean;
    totalMs: number;
    abandoned: boolean;
    lapSumInvalid?: boolean;
  }>;
  flags: { needsReview: boolean; reviewReason?: string };
  closedAt: number;      // server epoch-ms when close fired
}
```

The Unity client uses this to drive the result screen, personal-best pop-up, and
the per-player XP / wallet delta (Phase 3).

**Phase 2 note**: the server also subscribes the leaderboard writer to this
event — every human finisher is written to the appropriate `tt_*` / `lap_*` /
`wins_week` table (see `docs/leaderboards.md` for the confidence → write
matrix). The event payload itself is unchanged; the Unity client does not need
to react to leaderboard writes — it reads through `lb_get` instead.

**Confidence** — still not in the event payload. Clients compute it implicitly
from `flags.needsReview`: `false` → `quorum` or `server`; `true` → `client`.
Per-record confidence is now stamped on each leaderboard record's metadata
(see §6.7 `lb_get`).

---

## 8. Catalogs (from `config_get`)

### `tracks[]`

```json
{
  "id":          "neon_blvd",
  "displayName": "Neon Boulevard",
  "modes": {
    "quick":      3,    // laps for this mode on this track
    "ranked":     5,
    "private":    3,
    "time_trial": 1
  },
  "checkpoints":   8,
  "minTimeMsByClass": {
    "D": 48000, "C": 44000, "B": 40000, "A": 36000, "S": 32000
  }
}
```

The car class (`CarClassId` ∈ `{D, C, B, A, S}`) drives `minTimeMsByClass` — the
server rejects reports faster than this as `INVALID_RESULT`.

### `modes[]`

```json
{
  "id":              "quick",
  "displayName":     "Quick Race",
  "allowedSizes":    [2, 4, 6],
  "scoreMultiplier": 1.0,
  "usesRating":      false
}
```

`usesRating: true` means results feed into ranked season rating (Phase 4).

---

## 9. Car classes (`Loadout.classId`)

```ts
type CarClassId = 'D' | 'C' | 'B' | 'A' | 'S';
```

D is the slowest class (highest `minTimeMsByClass`), S is the fastest. The Phase 3
garage catalog will populate the body catalog — Phase 1 only requires a
client-side `bodyId: string` (UI label).

---

## 10. Confidence values

```ts
type Confidence = 'quorum' | 'client' | 'server';
```

| Value | When | Leaderboard writes (Phase 2) |
|---|---|---|
| `quorum` | All human reports agree on order | All tables (`tt_*`, `lap_*`, `wins_week` +1 for rank-1 in `quick`/`ranked`) |
| `client` | Humans disagree; order is host's; `needsReview: true` | `tt_*` / `lap_*` only when `mode === 'time_trial'`. `wins_week` suppressed. |
| `server` | No humans reported; order is host's bot roster | All tables but `wins_week` (bots never win) |

The Confidence is **not in the `RaceCompletedEvent` payload** — clients infer it
from `flags.needsReview`: `false` → `quorum` or `server`; `true` → `client`.
Per-record confidence IS stamped on each leaderboard record's metadata
(`metadata.confidence`), so `lb_get` consumers see it directly.

---

## 11. Match relay protocol (op codes)

**TODO** — `docs/race-protocol-ops.md` (Chunk 10 of Phase 1). Today, the Unity
client encodes the existing op codes (checkpoint, lap complete, finish line) in its
match handler; the server is relay-pure (doesn't inspect frames). The doc will
**enumerate the codes it currently sends** so the server-side RPCs can be aligned
with the relay frame contract once Phase 1 closes.

---

## 12. Versioning

- All storage objects carry `schemaVersion: 1`. **The Unity client never reads
  or writes storage;** the server is the only reader/writer.
- The server bumps `schemaVersion` and adds a migrator in `core/storage.ts`
  when shapes change.
- `config_get.minClientVersion` lets the server force an upgrade; clients must
  compare their `Application.version` and prompt for an app store jump if older.

---

## 13. Quick smoke script (curl)

```bash
SERVER_KEY=$(grep ^NAKAMA_SERVER_KEY .env | cut -d= -f2)
HTTP_KEY=$(grep ^NAKAMA_RUNTIME_HTTP_KEY .env | cut -d= -f2)
B64=$(printf "%s:" "$SERVER_KEY" | base64)

# 1) auth as device
TOKEN=$(curl -s -X POST https://api.gapolaniadev.com/v2/account/authenticate/device \
  -H "Authorization: Basic $B64" -H 'Content-Type: application/json' \
  -d '{"id":"unity-smoke"}' | jq -r .token)

# 2) config_get
curl -s -X POST "https://api.gapolaniadev.com/v2/rpc/config_get?http_key=$HTTP_KEY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '""' | jq

# 3) race_session_create
curl -s -X POST "https://api.gapolaniadev.com/v2/rpc/race_session_create?http_key=$HTTP_KEY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"matchId":"<match-id-from-socket>","mode":"quick","trackId":"neon_blvd","size":4,"hostLoadout":{"classId":"C","bodyId":"starter_viper"},"hostUserId":"<uuid-from-token>"}' | jq
```

The `hostUserId` and `matchId` come from the auth response and the socket match
allocation respectively; in the Unity client, wire them from the
`IAccountService.CurrentUserId` and the `ISession.MatchId` properties.

---

## 14. What the client MUST NOT do

- **Never write to storage.** All `race_sessions/*` and `profiles/*` writes are server-only.
- **Never write to leaderboards.** There is no client RPC to write a record. The
  `beforeLeaderboardRecordWrite` hook rejects any record that lacks the
  `__server_token__` server stamp; clients cannot forge it.
- **Never trust `ctx.userId` over HTTP.** It's always null — pass `hostUserId`/`callerUserId`
  in the payload.
- **Never trust `DateTime.UtcNow` for race timing.** Use the offset from
  `config_get.serverTimeMs` and the `race_session_start.startedAt` value.
- **Never put a `userId` field in `profile_update` payloads.** The server
  rejects any mismatch with the authenticated caller as `FORBIDDEN` (spoof
  defense).

---

## 15. What's NOT in Phase 1+2 (deferred)

| Surface | Phase |
|---|---|
| Matchmaker economy / ranked entries / XP / wallet | 3 |
| Match relay server-side frame inspection | 5 |
| Missions / pass / store / IAP | 6 / 9 |
| Friends / clubs / chat | 7 |
| Real `friends` view (currently just the caller) | 7 |

For these, refer to the corresponding `~/.claude/plans/phase-N-*.md` plan once it
exists.

---

## 16. Phase 3 RPCs — economy, garage, store

Eight new RPCs landed in Phase 3. All are owner-only (the socket
`ctx.userId` must equal the payload `callerUserId`; HTTP gateways send
`callerUserId` explicitly). Cross-user reads/writes return
`FORBIDDEN`. Missing identity returns `UNAUTHENTICATED`.

### 16.1 `wallet_get`

Returns the current spendable wallet plus a forward-compatible
pending/ledger summary. Sub-millisecond: one `nk.accountGetId` call
plus a 30-day ledger window scan.

**Input** — `{}` or `{ callerUserId?: string }`.

**Output**:

```ts
interface WalletGetOutput {
  coins: number;
  gems: number;
  /** Always empty in Phase 3 — gift/season-drop subsystem lands in Phase 5. */
  pending: PendingCredit[];
  ledger: { last30dCount: number };
}

interface PendingCredit {
  currency: 'coins' | 'gems';
  amount: number;          // positive
  reason: string;          // sourceId (race session, mission id, etc.)
  expiresAt?: number;      // epoch-ms; absent = no expiry
}
```

> **Note**: `pending` is always `[]` in Phase 3. The shape is here so
> the client can render a generic "Tienes X regalos pendientes" badge
> today without a follow-up RPC. See `docs/economy.md`.

### 16.2 `garage_get`

Returns the entire garage (cars + cosmetics + loadout + daily
counters) in one call — no pagination, no per-car fetches. Auto-creates
the starter garage (viper + zero upgrades) on first read so a client
that authenticates via an after-auth channel the hook doesn't cover
still gets a usable garage immediately.

**Input** — `{ userId?: string; callerUserId: string }`. Defaults to
self when `userId` is omitted.

**Output** — `{ garage: GarageView }`:

```ts
interface GarageView {
  userId: string;
  cars: OwnedCarView[];
  cosmeticsBag: string[];        // cosmetic ids the player owns
  purchasedPacks: string[];      // pack ids already redeemed
  loadout: LoadoutView | null;
  lastDailyWin: number;
  dailyPrivateCount: number;
  dailyResetAt: number;
}

interface OwnedCarView {
  carId: string;
  classId: 'D' | 'C' | 'B' | 'A' | 'S';
  upgrades: { engine: number; tires: number; nitro: number; handling: number };
  cosmetics: Partial<Record<CosmeticSlot, string>>;
  computedStats: { speed: number; acceleration: number; handling: number; nitro: number };
}

interface LoadoutView {
  activeCarId: string;
  equipped: Partial<Record<CosmeticSlot, string>>;
  stats: { speed: number; acceleration: number; handling: number; nitro: number };
}
```

See `docs/garage.md`.

### 16.3 `car_buy`

Buy a car from the catalog by `carId`. Wallet reads BEFORE the spend
(`nk.accountGetId`), then `nk.walletUpdate` (deducted via `spend()`
with idempotency key `garage:buy:{userId}:{carId}`), then CAS write
of the garage. On CAS conflict the spend is refunded via `grant()`
with key `garage:buy:refund:{userId}:{carId}` so the player can
retry without losing coins.

**Input** — `{ carId: string; callerUserId: string }`.

**Output** — `{ garage: GarageView; newBalance: { coins: number; gems: number } }`.

| Error | When |
|---|---|
| `INSUFFICIENT_FUNDS` | wallet balance < offer price |
| `CONFLICT` | car already owned OR CAS garage write failed (refund issued — retry safely) |
| `NOT_FOUND` | `carId` not in catalog |

### 16.4 `car_upgrade`

Upgrade one of `engine | tires | nitro | handling` on an owned car to
a new level (1..UPGRADE_MAX). Cost is `upgrades.perCarClass[classId][line][newLevel]`.
Stats are recomputed server-side; the response includes the new
`garage.cars[].computedStats` snapshot.

**Input** — `{ carId: string; line: UpgradeLine; newLevel: number; callerUserId: string }`.

**Output** — `{ garage: GarageView; costPaid: { coins: number; gems: number } }`.

### 16.5 `cosmetic_equip`

Equip a cosmetic on a specific slot of a specific car. Validates:
- car is owned
- cosmetic is in `garage.cosmeticsBag`
- cosmetic type matches the slot
- cosmetic's `compatibleClasses` includes the car's `classId`

**Input** — `{ carId: string; slot: CosmeticSlot; cosmeticId: string; callerUserId: string }`.

**Output** — `{ garage: GarageView }`.

### 16.6 `loadout_set`

Change the active car in the loadout. Equipped cosmetics are pulled
from the new active car's `cosmetics` so the loadout always reflects
the active car's choices.

**Input** — `{ carId: string; callerUserId: string }`.

**Output** — `{ loadout: LoadoutView }`.

### 16.7 `store_get`

Returns the catalog sections after applying the player's filters
(level, ownership, packs-purchased) plus the daily rotation. Rotation
is deterministic per UTC day (FNV-1a hash of `${offerId}:${dayIndex}`
over the `daily` section's offers, top `dailyRotationPoolSize` wins).
All players see the same rotation on the same day.

**Input** — `{ nowMs?: number; callerUserId: string }`. `nowMs` is
optional client-supplied "now" for deterministic tests.

**Output**:

```ts
interface StoreGetOutput {
  /** base36 day index the rotation is anchored to. */
  dailySeed: string;
  sections: ReadonlyArray<{
    section: { id: 'permanent' | 'daily' | 'level_gated'; displayName: string };
    offers: ReadonlyArray<{ offer: StoreOffer; isDailyOffer: boolean }>;
  }>;
}
```

### 16.8 `store_buy`

Redeem a `store_get` offer. Spend first via `spend()` with key
`store:buy:{kind}:{userId}:{refId}`, then mutate the garage (add car
to garage / cosmetic to bag / mark pack purchased), then CAS write
the garage. On CAS conflict refund via `grant()` with `:refund` suffix.
For packs, the pack contents are granted with `:pack` and reversed
on CAS conflict with `:pack:reverse`.

**Input** — `{ offerId: string; nowMs?: number; callerUserId: string }`.

**Output**:

```ts
interface StoreBuyOutput {
  delivery:
    | { kind: 'car'; refId: string }
    | { kind: 'cosmetic'; refId: string }
    | { kind: 'pack'; refId: string; changeset: { coins?: number; gems?: number } };
  newBalance: { coins: number; gems: number };
}
```

| Error | When |
|---|---|
| `NOT_FOUND` | `offerId` not in catalog |
| `BAD_REQUEST` | offer expired |
| `CONFLICT` | car/cosmetic/pack already owned OR CAS conflict (refund issued — retry safely) |
| `INSUFFICIENT_FUNDS` | wallet balance < offer price |
| `FORBIDDEN` | player level below `requiredLevel` |

### 16.9 Phase 3 client integration checklist

```
auth → wallet_get (read)         // optional, mostly for refreshes
auth → garage_get                // auto-creates starter garage on first call
                                 // → after-auth hook handles auth channels 1-4
                                  //   (device, email, custom, apple); channel 5+
                                  //   falls back to garage_get auto-create

header HUD refresh after every wallet mutation:
  race_session → wallet_get (coins + gems after RaceCompleted reward)
  car_buy      → wallet_get + garage_get
  car_upgrade  → wallet_get + garage_get
  store_buy    → wallet_get + garage_get
  cosmetic_equip / garage_get
  loadout_set  / garage_get

store_get on every shop screen open (rotation anchor changes at UTC midnight)
```

See `docs/economy.md`, `docs/garage.md`, `docs/store.md`.

---

## 17. Phase 4 RPCs — matchmaking, ranked, host recovery

Four new RPCs landed in Phase 4 plus one matchmaker hook installed via
`initializer.registerMatchmakerMatched`. The matchmaker itself is
owned by the Nakama runtime — these RPCs cover the contracts the
client and the runtime depend on.

### 17.1 `mm_ticket_params`

Builds the matchmaker query + metadata the client then passes to
`nk.matchmakerAdd`. Server-stamps `version` and `region` so clients
cannot influence them (D1). Returns the rating band for the current
player's last-rated window (D9) and the `mm.segmentBy` field (D8;
defaults to `none`, overridable via `liveops_config/current`).

```json
// body
"{\"mode\":\"quick\",\"size\":4,\"platform\":\"pc\",\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "ticket": {
    "query":    { "mode":"quick","size":4,"version":"1.0.0","region":"eu-west-1","segmentBy":"none","ratingBand":"unrated" },
    "metadata": { "mode":"quick","size":"4","version":"1.0.0","region":"eu-west-1","segmentBy":"none" }
  },
  "output": {
    "mode":       "quick",
    "size":       4,
    "version":    "1.0.0",
    "region":     "eu-west-1",
    "mm":         { "segmentBy": "none" },
    "constraints":{ "excludeTrackIds": [] }
  }
}
```

For `ranked` mode the `ratingBand` is `low-high` (e.g. `900-1100`)
derived from the player's `lastRatedAt` per `ranked_config.json`.
For other modes the band is the literal `unrated` so quick and
ranked pools never accidentally intersect.

**Authz**: same as §16 — `callerUserId` must match `ctx.userId` on
socket; HTTP gateway uses payload as authoritative.

Errors: `BAD_REQUEST` (unknown mode / size / platform; malformed
JSON). Rate limit: 30/60s.

### 17.2 `race_session_quick_bots`

Solo or small-party fill. Builds a `quick` session with humans + bots
(D10), picks a track deterministically (D2), and starts the race
immediately. Bot difficulty derived from average human rating (D3).
Bots never host (D5).

```json
// body
"{\"size\":4,\"hostLoadout\":{\"classId\":\"C\",\"bodyId\":\"starter_viper\"},\"humanRoster\":[{\"userId\":\"<uuid>\",\"rttMs\":50,\"rating\":1100},{\"userId\":\"<friend-uuid>\",\"rttMs\":80,\"rating\":1050}],\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "sessionId":      "<uuid>",
  "mode":           "quick_bots",
  "trackId":        "neon_blvd",
  "size":           4,
  "host":           "<uuid>",     // lowest-rttMs human
  "startedAt":      1740000005000,
  "roster": [
    { "userId":"<uuid>",        "isBot":false, "rttMs":50, "loadout":{"classId":"C","bodyId":"starter_viper"} },
    { "userId":"<friend-uuid>", "isBot":false, "rttMs":80, "loadout":{"classId":"C","bodyId":"starter_viper"} },
    { "userId":"bot_qb_d2_0",   "isBot":true,  "botDifficulty":2, "loadout":{"classId":"C","bodyId":"bot-body-2"} },
    { "userId":"bot_qb_d2_1",   "isBot":true,  "botDifficulty":2, "loadout":{"classId":"C","bodyId":"bot-body-2"} }
  ],
  "botDifficulty": 2,
  "botCount":      2
}
```

**Authz**: `callerUserId` must be the FIRST entry in `humanRoster`
(host is always the caller — bots can never host). Cross-user caller
→ `FORBIDDEN`.

| Error | When |
|---|---|
| `BAD_REQUEST` | invalid size, duplicate userId, empty userId, too many humans for the size |
| `FORBIDDEN` | caller's userId is not first in `humanRoster` |
| `NOT_FOUND` | explicit `trackId` not in catalog |
| `RATE_LIMITED` | 6 calls / 60s per caller |

### 17.3 `race_host_claim`

Host succession on disconnect. The next human in `hostSuccession` may
claim within the 20-second grace window (`ranked_config.graceSeconds`
+ 5s tolerance). The relay stamps `disconnectReportedAt` on the host's
roster entry; this RPC promotes the next human to host under CAS.

```json
// body
"{\"sessionId\":\"<uuid>\",\"callerUserId\":\"<next-uuid>\"}"

// response.data
{
  "sessionId": "<uuid>",
  "newHost":   "<next-uuid>",
  "claimedAt": 1740000050000
}
```

**Authz**: caller must be in `session.roster` and the next human in
`hostSuccession` AFTER the current host. Skipping ahead → `BAD_REQUEST`.

| Error | When |
|---|---|
| `NOT_FOUND` | sessionId doesn't exist |
| `FORBIDDEN` | caller not in roster |
| `BAD_REQUEST` | state ≠ `started`; no disconnect stamp; not next in succession; grace expired |
| `CONFLICT` | CAS race lost (another caller claimed first) |
| `RATE_LIMITED` | 3 calls / 60s per caller |

Idempotent re-claim by the same caller returns the same `claimedAt`
without a CAS write.

### 17.4 `ranked_get`

Public ranked summary for `targetUserId` (defaults to caller). Always
allows cross-user reads (D11). Lazily closes the active season when
its `endsAt` is past (D7) — distributes tier rewards via the inbox
and spins up the next season.

```json
// body
"{\"userId\":\"<optional-uuid>\",\"callerUserId\":\"<uuid>\"}"

// response.data
{
  "userId":             "<uuid>",
  "seasonId":           "season_2",
  "rating":             1247,
  "peak":               1290,
  "division":           "oro",
  "divisionProgress":   0.47,
  "racesPlayed":        23,
  "wins":               8,
  "topThree":           14,
  "recentAbandons":     0,
  "rank":               142,
  "daysLeftInSeason":   412,
  "abandonsLast24h":    1,           // D6 counter
  "blockedUntilUtc":    null         // D6 block, or null when clean
}
```

**Authz**: `callerUserId` must match `ctx.userId` on socket. NO
`FORBIDDEN` for cross-user reads — D11 marks ranked as public.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `FORBIDDEN` | `callerUserId` mismatch on socket |
| `NOT_FOUND` | no active season in the catalog |
| `RATE_LIMITED` | 30 calls / 60s per caller |
| `BAD_REQUEST` | malformed JSON |

### Matchmaker hook (server-side, no client surface)

`initializer.registerMatchmakerMatched` is registered at `InitModule`.
The runtime calls it on every matchmaker suggestion. The hook
validates each candidate (mode / version / region alignment, size
match) and returns `{ matched: true }` for the first valid candidate
or `{ matched: false, reason: string }` to drop the suggestion.

> **Stats equalization in ranked (D12):** When a ranked session is
> created via the matchmaker path, every roster entry's
> `loadout.stats` is clamped UP to the car's class max via
> `applyStatsEqualizationToMatchedSession`. For non-matched paths
> (`race_session_create` / `race_session_join`), the same logic
> runs inline via `loadoutStatsFor`. The bundled `cars` catalog's
> `maxStats` field is the source of truth; upgrades are ignored in
> ranked.

See `docs/matchmaking.md` and `docs/ranked.md` for the full
contract, decision matrix, and the E2E test coverage.