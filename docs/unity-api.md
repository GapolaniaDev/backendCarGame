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

---

## 18. Phase 5 RPCs — LiveOps, account, admin, relay

Phase 5 adds 7 player-facing RPCs + 5 admin RPCs + 1 relay-token RPC.
Every RPC in this section accepts the optional `clientVersion` (semver
string) and `platform` (`'ios'|'android'|'windows'|'macos'|'linux'`)
fields. When either is present, the server enforces a min-version gate
(`UPGRADE_REQUIRED`) plus the maintenance gate
(`SERVICE_UNAVAILABLE`) — see `docs/liveops.md` §2 and §3.

**Maintenance gate summary** (which RPCs are gated vs which are exempt):

| RPC | Gated by | Notes |
|---|---|---|
| `liveops_config_get` | none (splash) | Always callable |
| `inbox_list` | none (splash) | Badge renders during maintenance |
| `account_delete` | none (GDPR) | Erasure cannot be blocked by ops |
| `admin_*` | `skipForAdmin: true` | Admins work during maintenance |
| `relay_token` | `skipForAdmin: true` | Clients need a relay URL even during pause |
| `wallet_get` | `liveopsGate` | full |
| `garage_get` | `liveopsGate` | full |
| `car_buy`, `car_upgrade`, `cosmetic_equip`, `loadout_set` | `liveopsGate` | full |
| `store_get`, `store_buy` | `liveopsGate` | full |
| `lb_get` | `liveopsGate` | full |
| `account_link`, `account_link_resolve_conflict` | `liveopsGate` | full |
| `inbox_claim` | `liveopsGate` | full |
| `profile_get`, `profile_update` | `liveopsGate` | full |
| `race_session_*`, `race_host_claim` | maintenance only | no `ClientPlatform` carry |
| `mm_ticket_params` | maintenance only | MmPlatform ≠ ClientPlatform |
| `ranked_get` | maintenance only | — |

### 18.1 `liveops_config_get`

Returns the merged LiveOps config (bundle default + storage
override). The client calls this on app start, during the splash, and
on every fresh login.

```json
// request
{ "callerUserId": "<uuid>" }

// response.data
{
  "version":        3,
  "flags":          { "maintenance": false },
  "minClientVersion": {
    "ios":     "1.2.0",
    "android": "1.2.0",
    "windows": "1.2.0",
    "macos":   "1.2.0",
    "linux":   "1.2.0"
  },
  "regions": [{ "id": "us-east-1", "displayName": "US East",
                "relayUrl": "wss://api.gapolaniadev.com" }],
  "calendar": [],
  "configHash": "<sha256-hex>"
}
```

`configHash` is a SHA-256 of the canonicalised payload — clients can
use it to skip processing when the server config is unchanged.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `SERVICE_UNAVAILABLE` | liveops config is malformed (boot error) |

See `docs/liveops.md`.

### 18.2 `inbox_list`

Returns the user's inbox messages (unread + recent claimed). NOT
maintenance-gated so the badge can render during the splash.

```json
// request
{
  "callerUserId": "<uuid>",
  "limit":        50,            // optional, default 50, max 100
  "cursor":       "<opaque>",    // optional, for pagination
  "includeClaimed": false        // optional, default false
}

// response.data
{
  "messages": [
    {
      "messageId":  "<uuid>",
      "kind":       "reward",
      "title":      "Welcome to Season 3",
      "body":       "Free 500 coins",
      "reward":     { "coins": 500 },
      "createdAt":  "2026-10-01T12:00:00Z",
      "expiresAt":  "2026-11-01T12:00:00Z",   // 30d retention
      "claimed":    false,
      "claimedAt":  null
    }
  ],
  "unreadCount": 3,
  "nextCursor":   "<opaque>"     // null when no more
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | malformed payload |

### 18.3 `inbox_claim`

Claim the reward attached to a message. Idempotent — calling twice
credits the reward exactly once (key = `messageId`).

```json
// request
{
  "callerUserId": "<uuid>",
  "messageId":    "<uuid>",
  "clientVersion": "1.2.0",     // optional, see §18 top
  "platform":      "ios"        // optional, see §18 top
}

// response.data
{
  "messageId":    "<uuid>",
  "reward":       { "coins": 500 },
  "newBalance":   { "coins": 1500, "gems": 25 },
  "alreadyClaimed": false
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `NOT_FOUND` | unknown messageId OR not in this user's inbox |
| `GONE` | message past `expiresAt` |
| `SERVICE_UNAVAILABLE` | maintenance (idempotent retries on next launch) |

### 18.4 `account_link`

Attach an external identity (Apple / Google / email) to the
device-id account. Returns `{linked:true, bonusClaimed:true,
newBalance:{...}}` on success, or `{linked:false, conflict:{...}}` if
the provider is already linked elsewhere.

```json
// request
{
  "callerUserId":  "<uuid>",
  "provider":      "apple" | "google" | "email" | "custom",
  "token":         "<provider-specific opaque>",
  "clientVersion": "1.2.0",
  "platform":      "ios"
}

// response.data — happy path
{
  "linked":         true,
  "bonusClaimed":   true,
  "newBalance":     { "coins": 500, "gems": 0 }
}

// response.data — conflict
{
  "linked":  false,
  "conflict": {
    "conflictToken": "<opaque>",
    "otherUserId":   "<uuid>",
    "otherProfile":  { "displayName": "...", "avatarUrl": "..." },
    "expiresAt":     "2026-10-08T12:00:00Z"
  }
}
```

The 500-coin bonus is granted **once per profile** (gated by
`profile.accountLinkBonusClaimed`). See `docs/account-linking.md` §1.

### 18.5 `account_link_resolve_conflict`

Resolve a conflict from `account_link`. Two choices:
`'link'` (keep current, purge the other account) or `'cancel'`.

```json
// request
{
  "callerUserId":  "<uuid>",
  "conflictToken": "<from prior account_link conflict>",
  "choice":        "link" | "cancel",
  "confirmText":   "DELETE-OTHER-ACCOUNT",   // required when choice='link'
  "clientVersion": "1.2.0",
  "platform":      "ios"
}

// response.data — cancelled
{ "resolved": "cancelled" }

// response.data — linked
{
  "resolved":                "linked",
  "affectedAccountDeleted":  true,
  "bonusClaimed":            true,
  "newBalance":              { "coins": 500, "gems": 0 }
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | missing `confirmText` on `'link'`, malformed payload |
| `NOT_FOUND` | unknown `conflictToken` OR expired (>24h) |
| `FORBIDDEN` | `conflictToken` belongs to another user |

### 18.6 `account_delete`

GDPR right to erasure. Bypasses the maintenance gate — a broken
session token still rejects, but an ops pause does not.

```json
// request
{
  "callerUserId": "<uuid>",
  "confirmText":   "DELETE"   // sentinel — exact match
}

// response.data
{
  "deletedAt": "2026-10-07T12:00:00Z",
  "summary": {
    "storageDeleted":      7,
    "collectionsAffected": ["profiles","loadout","garage","ranked_records", ...],
    "boardsDeleted":       3,
    "boardsAffected":      ["ranked_season_2","wins_season_2", ...],
    "unlinkedAuths":       2,
    "wasClubLeaderOf":     [],          // always [] in v1 (clubs = Phase 7)
    "abandonedFromRaces":  0
  }
}
```

Cascade: profiles, loadout, garage, ranked_records, abandons, every
linked custom auth, every leaderboard record. Skips the `pc-account`
config and `abandons` aggregate counters.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | `confirmText !== 'DELETE'` |

See `docs/account-linking.md` §6 for the cascade contract.

### 18.7 `relay_token`

Mint a short-lived HMAC token the client presents to the relay
replica. Always callable — `skipForAdmin: true` on the maintenance
gate. **Requires `ctx.userId`** (the socket must be authenticated;
`callerUserId` is ignored).

```json
// request
{
  "callerUserId":  "<uuid>",
  "clientVersion": "1.2.0",
  "platform":      "ios"
}

// response.data
{
  "token":     "v1.<base64-payload>.<base64-sig>",
  "relayUrl":  "wss://api.gapolaniadev.com",
  "expiresAt": 1762515600,        // unix SECONDS, now+60min
  "regionId":  "us-east-1"
}
```

The token format is `v1.<userId|region|expSec>.<hmacSha256>`. The
relay-side `beforeAuthenticateDevice` verifies offline (no home
round-trip) using `LiveopsConfig.relayTokenSecret`. TTL:
`RELAY_TOKEN_TTL_SEC = 60 * 60`.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no socket `userId` |
| `SERVICE_UNAVAILABLE` | no regions configured / `relayTokenSecret` missing |
| `UPGRADE_REQUIRED` | min-version failed (admin bypass on maintenance only) |

### 18.8 Admin RPCs (compact reference)

All five share the same auth shape: `adminKey` in the body matching
`LiveopsConfig.adminRpcKey`. They bypass maintenance. Full request /
response / errors live in `docs/admin.md`.

| RPC | Purpose |
|---|---|
| `admin_wallet_adjust` | Grant or remove coins/gems for a single user |
| `admin_send_inbox` | Push a reward inbox message to N user IDs |
| `admin_sanitize_session` | Force-close a single race session |
| `admin_remove_player` | Remove a player from a single race session |
| `admin_cleanup_race_sessions` | Delete closed race sessions older than N hours |

Each call writes an `admin_action` analytics row.

### 18.9 New fields / headers

| Field | Where it appears | Notes |
|---|---|---|
| `clientVersion` | every Phase 5 RPC body | semver string; triggers `UPGRADE_REQUIRED` when stale |
| `platform` | every Phase 5 RPC body | `ios` \| `android` \| `windows` \| `macos` \| `linux` |
| `region` | server-stamped on `mm_ticket_params` | defaults to home region (e.g. `us-east-1`); client can override in a future iteration |
| `http_key` query | every admin RPC | defense-in-depth; see `docs/admin.md` §1 |

### 18.10 Maintenance gate behaviour

| Class | Behaviour during maintenance |
|---|---|
| Gated RPCs (player-facing, gated) | Return `SERVICE_UNAVAILABLE`; client shows the splash with the liveops config |
| Splash RPCs (`liveops_config_get`, `inbox_list`) | Always callable |
| GDPR RPC (`account_delete`) | Always callable (GDPR > ops) |
| Admin RPCs (`admin_*`, `relay_token` with `skipForAdmin`) | Always callable |

See `docs/liveops.md` §2 for the full matrix and rationale.

---

## 19. Phase 6 RPCs — Missions, Achievements, Battle Pass

Phase 6 ships the daily/weekly missions module, the achievements
module, and the battle pass with XP economy. Nine new RPCs in total
(8 player-facing + 1 admin), three new storage collections
(`missions_daily`, `missions_weekly`, `achievements` + `pass` +
`pass_xp_ledger`), and a deterministic assignment via a salted SHA-256
hash. Every RPC in this section accepts the optional `clientVersion`
(semver string) and `platform` (`'ios'|'android'|'windows'|'macos'|'linux'`)
fields, plus the per-RPC rate limit enforced by `assertNotInMaintenance`
+ `liveopsGate`. See `docs/missions.md` and `docs/pass.md` for the
deep-dive on the modules and decision matrix.

**Maintenance gate summary** (which Phase 6 RPCs are gated vs which are exempt):

| RPC | Gated by | Notes |
|---|---|---|
| `missions_get`, `mission_claim`, `mission_reroll` | `assertNotInMaintenance` | full |
| `achievements_get`, `achievement_claim` | `assertNotInMaintenance` | full |
| `pass_get`, `pass_claim`, `pass_buy_premium` | `assertNotInMaintenance` | full |
| `admin_grant_premium` | none (admin surface) | Always callable (admin) |

### 19.1 `missions_get`

Returns the player's daily + weekly mission assignments plus progress
and reward metadata. Lazy-creates the assignment rows on first access;
the assignment is **deterministic** per `(userId, dateUtc)` via
`ASSIGNMENT_SALT='cv-missions-assignment-v1'` SHA-256. The same
`userId` always gets the same 3 daily missions on the same UTC day.

```json
// request
{ "callerUserId": "<uuid>", "clientVersion": "1.2.0", "platform": "ios" }

// response.data
{
  "daily": {
    "dateUtc": "2026-10-07",
    "assignedAt": 1760610240,
    "rerollsLeftToday": 1,
    "missions": [
      {
        "instanceId": "daily:daily_race_5@2026-10-07",
        "missionId": "daily_race_5",
        "title": "Cinco carreras del día",
        "description": "Termina 5 carreras hoy",
        "kind": "race_count",
        "filters": {},
        "target": 5,
        "reward": { "coins": 100, "xp": 50 },
        "progress": 0,
        "completed": false,
        "claimed": false,
        "locked": false   // unlockLevel > playerLevel
      }
    ]
  },
  "weekly": { /* same structure, weekUtc in place of dateUtc */ },
  "rerollsLeftToday": 1,
  "nowUtc": "2026-10-07T12:00:00Z"
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `SERVICE_UNAVAILABLE` | maintenance or catalog not loaded |
| `RATE_LIMITED` | 60 calls / 60s per caller |

### 19.2 `mission_claim`

Claim the reward for a completed mission. Idempotent via CAS — a
second claim returns `CONFLICT`. Routes `reward.coins/gems` to the
wallet (idempotent ledger key `mission:${kind}:${missionId}:${userId}`),
`reward.xp` to the battle pass via `addPassXp`, and `reward.cosmeticId`
to the garage bag.

```json
// request
{
  "callerUserId": "<uuid>",
  "missionId":    "daily_race_5",
  "kind":         "daily",
  "clientVersion": "1.2.0",
  "platform":      "ios"
}

// response.data
{
  "missionId":   "daily_race_5",
  "reward":      { "coins": 100, "xp": 50 },
  "kind":        "daily",
  "xpGranted":   50,           // routed to Battle Pass
  "passLevel":   2,
  "levelUps":    [2]
}
```

| Error | When |
|---|---|
| `BAD_REQUEST` | missing `missionId`; `kind` not `daily` or `weekly` |
| `NOT_FOUND` | `missionId` not in catalog or not in user's current row |
| `INVALID_RESULT` | progress < target (not yet completed) |
| `CONFLICT` | already claimed |
| `RATE_LIMITED` | 30 / 60s per caller |

### 19.3 `mission_reroll`

Re-roll a single daily mission. First call per UTC day is **free**
(decrements `rerollsLeftToday`); subsequent calls cost 50 gems
(`PAID_REROLL_COST_GEMS = 50`). Returns the new mission definition.

```json
// request (free reroll)
{ "callerUserId":"<uuid>", "missionId":"daily_race_5", "clientVersion":"1.2.0", "platform":"ios" }

// request (gems reroll)
{ "callerUserId":"<uuid>", "missionId":"daily_race_5", "useGems":true, "clientVersion":"1.2.0", "platform":"ios" }

// response.data (free)
{
  "newMission":        { "id": "daily_top_3_5", "title": "...", ... },
  "costGems":           0,
  "rerollsLeftToday":   0
}

// response.data (paid)
{ "newMission": {...}, "costGems": 50, "rerollsLeftToday": 0 }
```

| Error | When |
|---|---|
| `BAD_REQUEST` | missing `missionId` |
| `NOT_FOUND` | `missionId` not in catalog |
| `INSUFFICIENT_FUNDS` | `useGems: true` and wallet < 50 gems |
| `RATE_LIMITED` | 10 / 60s per caller |

### 19.4 `achievements_get`

Returns all 22 achievements with progress + locked flag (locked)
to `progression.level`. Lazy-creates the achievements storage row on
first access (D13).

```json
// request
{ "callerUserId":"<uuid>", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "achievements": [
    {
      "achievementId": "achv_wins_quick_10",
      "title":         "Diez victorias rápidas",
      "description":   "Gana 10 carreras en modo quick",
      "kind":          "wins_quick",
      "target":        10,
      "reward":        { "coins": 500, "xp": 200 },
      "progress":      4,
      "completed":     false,
      "claimed":       false,
      "locked":        false
    }
  ],
  "nowUtc": "2026-10-07T12:00:00Z"
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `SERVICE_UNAVAILABLE` | maintenance or catalog not loaded |
| `RATE_LIMITED` | 60 / 60s per caller |

### 19.5 `achievement_claim`

Claim the reward for a completed achievement. Idempotent via CAS.
Routes `reward.coins/gems` to the wallet, `reward.xp` to the battle
pass, `reward.cosmeticId` to the garage bag (best-effort — missing in
catalog → log + skip, never throws).

```json
// request
{ "callerUserId":"<uuid>", "achievementId":"achv_wins_quick_10", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "achievementId": "achv_wins_quick_10",
  "reward":        { "coins": 500, "xp": 200 },
  "granted":       { "coins":500, "gems":0, "cosmetics":[], "cars":[], "skippedCosmetics":[], "skippedCars":[] },
  "xpGranted":     200,
  "passLevel":     3,
  "levelUps":      [3]
}
```

| Error | When |
|---|---|
| `BAD_REQUEST` | missing `achievementId` |
| `NOT_FOUND` | unknown achievement or not in user's row |
| `INVALID_RESULT` | progress < target |
| `CONFLICT` | already claimed |
| `RATE_LIMITED` | 30 / 60s per caller |

### 19.6 `pass_get`

Lazy-creates the player's PassRecord, performs the D11 lazy season
close when applicable, and returns the level state. The pass has 40
levels today (`pass_s1.json`); each level has a free + premium reward.

```json
// request
{ "callerUserId":"<uuid>", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "userId":             "<uuid>",
  "seasonId":           "s1",
  "seasonClosed":       false,
  "endUtc":             "2027-12-31T00:00:00Z",
  "xp":                 0,
  "currentLevel":       1,
  "nextLevel":          2,
  "xpRequired":         100,
  "xpRemaining":        100,
  "premiumPurchased":   false,
  "levels": [
    {
      "level":         1,
      "xpRequired":    0,
      "freeReward":    { "coins": 100 },
      "premiumReward": { "coins": 200 },
      "freeClaimed":   false,
      "premiumClaimed": false
    }
    // ... 39 more
  ],
  "premiumPriceGems": 800
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `SERVICE_UNAVAILABLE` | maintenance or catalog not loaded |
| `RATE_LIMITED` | 60 / 60s per caller |

### 19.7 `pass_claim`

Claim the reward for a single level's free or premium track.
Idempotent — second claim returns `CONFLICT`. Cosmetic / car rewards
are best-effort (`reward_granter.ts::grantPassReward` never throws;
missing in catalog → log + skip).

```json
// request (free)
{ "callerUserId":"<uuid>", "level":1, "track":"free", "clientVersion":"1.2.0", "platform":"ios" }

// request (premium, premium must be purchased)
{ "callerUserId":"<uuid>", "level":1, "track":"premium", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "level":        1,
  "track":        "free",
  "reward":       { "coins": 100 },
  "granted":      { "coins":100, "gems":0, "cosmetics":[], "cars":[], "skippedCosmetics":[], "skippedCars":[] },
  "newXp":        0,
  "currentLevel": 1,
  "nextLevel":    2
}
```

| Error | When |
|---|---|
| `BAD_REQUEST` | `level` not a positive integer; `track` not `free` or `premium`; level out of catalogue range |
| `INVALID_RESULT` | player XP < level threshold |
| `FORBIDDEN` | `track === 'premium'` and `premiumPurchased: false` |
| `CONFLICT` | already claimed; season closed; CAS retries exhausted |
| `RATE_LIMITED` | 30 / 60s per caller |

### 19.8 `pass_buy_premium`

Spend `premiumPriceGems` from the wallet and unlock the premium track.
Idempotent — second call returns the current state without re-charging.

```json
// request
{ "callerUserId":"<uuid>", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "userId":           "<uuid>",
  "seasonId":         "s1",
  "premiumPurchased": true,
  "priceGems":        800,
  "newGemsBalance":   9200
}
```

| Error | When |
|---|---|
| `INSUFFICIENT_FUNDS` | wallet gems < 800 |
| `CONFLICT` | season closed; CAS retries exhausted |
| `RATE_LIMITED` | 10 / 60s per caller |

### 19.9 `admin_grant_premium`

Admin override that flips `premiumPurchased` WITHOUT charging gems.
Shared-secret gated (NOT maintenance-gated). Idempotent.

```json
// request
{ "userId":"<target-uuid>", "adminKey":"<LiveopsConfig.adminRpcKey>" }

// response.data
{ "userId":"<target-uuid>", "seasonId":"s1", "premiumPurchased":true, "viaAdmin":true }
```

| Error | When |
|---|---|
| `FORBIDDEN` | `adminKey` missing or mismatched |
| `BAD_REQUEST` | `userId` missing |
| `SERVICE_UNAVAILABLE` | `LiveopsConfig.adminRpcKey` not configured |
| `CONFLICT` | CAS retries exhausted |

### 19.10 XP sources (summary)

The Battle Pass XP is granted through `addPassXp(nk, logger, userId, delta, dedupeKey?)`. Sources:

| Source | Multiplier (race) | Dedupe key | When |
|---|---|---|---|
| `race_quick` | × 1.0 (= 20 XP) | `sessionId` | Every finished race on `RaceCompleted` event |
| `race_ranked` | × 1.25 (= 25 XP) | `sessionId` | same |
| `race_private` | × 0.25 (= 5 XP) | `sessionId` | same |
| `race_time_trial` | × 0.5 (= 10 XP) | `sessionId` | same |
| `mission_claim` | n/a | (none) | `reward.xp` from mission catalog on claim |
| `achievement_claim` | n/a | (none) | `reward.xp` from achievement catalog on claim |

Race XP is **deduplicated** via the `pass_xp_ledger` collection keyed
by `(userId, source, sessionId)`. Mission/achievement XP grants are
naturally deduplicated by the claim CAS (second claim returns
`CONFLICT` before `addPassXp` is reached).

`addPassXp` returns `{record, levelUps: number[], applied: boolean}`.
`applied: false` is non-fatal — the subscriber never throws.

### 19.11 Season close + lazy storage

- **Lazy close** — `pass_get` checks the catalog's `endUtc` on every
  access. When `now > endUtc` AND the global `season_close/{seasonId}`
  marker is absent, it writes the marker (server-owned,
  `SYSTEM_USER_ID`) and flips the per-player `seasonClosed` flag.
  After close, every `pass_claim` returns `CONFLICT: 'pass season is
  closed'`. The pass has **no** end-of-season reward dump (only
  ranked does — see [`docs/ranked.md`](./ranked.md) D7).
- **Lazy storage** — `PassRecord` and `AchievementsRecord` are
  both lazy (no per-user row until the first read RPC). A player who
  never opens the pass or achievements has no storage footprint.

### 19.12 Cosmetic / car idempotency

`reward_granter.ts` (missions + achievements) and
`reward_granter.ts` (pass) grant cosmetic IDs to `garage.cosmetics
Bag` and car IDs to `garage.cars` via CAS. Idempotent because both
helpers check "already in bag / already in garage" before writing. A
claim RPC that lands a cosmetic already in the bag returns a `200`
envelope with `skippedCosmetics: [cosmeticId]` — never an error.

### 19.13 Phase 6 client integration checklist

```
auth → missions_get (read once)                          // badges show absent, locked, completed, claimed
auth → achievements_get (read)                           // 22 cards
auth → pass_get (read)                                   // lazy-creates PassRecord; renders 40 levels

pass_get on every pass-tab mount (pass_get can be stale when season closes)
missions_get on every missions-tab mount (assignment may carry the day)

header HUD refresh after race (race pass XP):
  race finished → pass_get (XP + level)
  mission_claim → mission_claim response, then pass_get
  achievement_claim → achievement_claim response, then pass_get
  pass_claim → pass_claim response, then garage_get + wallet_get
  pass_buy_premium → pass_buy_premium response, then wallet_get
```

See `docs/missions.md`, `docs/pass.md`, `docs/economy.md`,
`docs/garage.md`.
## 20. Phase 7 RPCs — Social, Parties, Moderation

Phase 7 ships 26 RPCs + 1 fix across 8 chunks (friend codes,
invites, blocks, clubs CRUD + membership, chat, moderation, parties,
party_join fix). Server: storage-based + flat invitations + storage
parties (Nakama 3.27 JS lacks `registerParty*` API).

All Phase 7 RPCs follow the standard `Resp<T> = Ok<T> | Err` envelope
(see §3). The table below lists the surface.

| RPC | Auth | Gated | Returns |
|---|---|---|---|
| `friend_code_get` | owner | YES | `{code, userId, createdAt}` |
| `friend_add_by_code` | owner | YES | `{friendId, friendCode, since, mutual}` |
| `friend_list_get` | owner | YES | `{items, count}` |
| `friend_remove` | owner | YES | `{removed: true}` |
| `recent_rivals_get` | owner | YES | `{rivals, count}` |
| `invite_send` | owner | YES | `{inviteId, delivered, expiresAt}` |
| `invite_list` | owner | YES | `{items, count}` |
| `invite_respond` | owner | YES | `{status, inviteId, partyId?}` |
| `block_add` | owner | YES | `{created: boolean}` |
| `block_remove` | owner | YES | `{removed: boolean}` |
| `block_list` | owner | YES | `{items, count}` |
| `club_create` | owner + level ≥ 8 | YES | `{clubId, costCoins, balanceAfter}` |
| `club_get` | owner | YES | `{club}` |
| `club_search` | owner | YES | `{items, count}` |
| `club_update` | leader | YES | `{updated: true}` |
| `club_members_list` | owner | YES | `{members, nextCursor}` |
| `club_kick` | leader | YES | `{kicked: true}` |
| `club_promote` | leader | YES | `{promoted: true, role: 'admin'}` |
| `club_demote` | leader | YES | `{demoted: true, role: 'member'}` |
| `club_leave` | member | YES | `{left: true}` |
| `chat_send` | owner | YES | `{messageId, sentAt}` |
| `chat_list` | owner | NO (read) | `{items, count}` |
| `report_player` | owner | YES | `{reportId, silenced, untilUtc?, distinctCount, triggeredSilence}` |
| `admin_view_reports` | adminKey | YES (bypass) | `{reports, count}` |
| `admin_silence` | adminKey | YES (bypass) | `{silenced: true, untilUtc}` |
| `admin_unsilence` | adminKey | YES (bypass) | `{silenced: false, untilUtc: 0}` |
| `party_create` | owner | YES | `{partyId, leaderUserId, maxSize, state, createdAt, members[]}` |
| `party_invite` | leader | YES | `{inviteId, expiresAt, partyId, targetUserId}` |
| `party_join` | owner | YES | `{party, partyId, joinedAt}` |
| `party_leave` | member | YES | `{left: true, disbanded}` |
| `party_kick` | leader | YES | `{kicked: true, partyId, targetUserId}` |
| `party_get` | member | NO (read) | `{party: {partyId, leaderUserId, maxSize, state, createdAt, members[]}}` |

### 20.1 Friend codes (Chunk 1)

8-character codes over a 31-char alphabet (`0-9 A-Z minus I, O, U`
case-folded). Salted by `FRIEND_CODE_SALT='cv-friend-code-v1'`.
Generated deterministically via SHA-256(userId || salt) → first 8
chars of the alphabet index. Friend codes are immutable once issued.

Mutual friendships: both sides write a row to `friend_edges`. Caller
side: `owner=caller, key=friendId`. Friend side: `owner=friendId,
key=caller`. Either side may `friend_remove`.

### 20.2 Invites (Chunk 2 + Chunk 9 fix)

Two kinds: `group` (club/party), `private_room` (race). TTL = 24h
default, clamped to [now, now + 7d] when caller supplies `expiresAt`.
Self-invite → BAD_REQUEST. Either-side block → FORBIDDEN. Online push
STUBBED: `nk.socketSend` is not in 3.27 JS runtime — `delivered:
'offline'` always. Clients poll `invite_list`.

**Chunk 9 fix**: `invite_respond(accept=true)` on a `group` invite
with `payload.partyId` calls `parties_repo.joinParty(callerId,
partyId)`. The response includes `partyId` when the join succeeds.
Errors do NOT undo the invite acceptance.

### 20.3 Clubs (Chunks 3-5)

`club_create` spends 5000 coins + requires level ≥ 8 + is a
Nakama group (NOT a storage collection). Membership rows live in
`clubs_members` storage (system-owned, public read) — this is the
authoritative roster because 3.27 JS lacks `groupUsersRemove`. Weekly
leaderboard + reward via `clubs_week_points` (lazy reset, no
`registerLeaderboardReset`).

### 20.4 Chat (Chunk 6)

`chat_send`: 200 char cap, multi-lang blocked words (es/en/pt)
leet-normalized, 1 msg/sec + 20/min rate. `chat_list` reads from
`chat_history/{channel}/{targetId}` with 7-day TTL. Channel types:
`club` (targetId = clubId), `direct` (targetId = recipientUserId).
3 reports in 24h → 1h chat-only silence (auto-triggered by the report
flow).

`registerBeforeSendChannelMessage` missing in 3.27 JS — the
`validateChatSend` synchronous helper is called from `chat_send` RPC
itself. Same semantic, different surface.

### 20.5 Moderation (Chunk 7)

`report_player`: per-reporter 5/hour rate. Reasons: `cheating`,
`toxic_chat`, `username`, `other`. 3 distinct reporters in 24h → 1h
silence (auto-triggered; `silenced: true`, `untilUtc: <now+1h>`).
Reports anonymous to targets; only `admin_view_reports` exposes
`reporterUserId`.

Admin RPCs (`admin_view_reports`, `admin_silence`, `admin_unsilence`)
require `adminKey` (shared-secret from `liveops_config.adminRpcKey`,
Phase 5 D7). Bypass maintenance. `admin_unsilence` writes `untilUtc=0`
(lazy clear, preserves audit history).

### 20.6 Parties (Chunks 8-9)

Storage-based (NOT Nakama party API — 3.27 JS lacks `registerParty*`).
`parties/{partyId}/<SYSTEM_USER>` + `active_party/{userId}/{userId}`
inverse index. maxSize ∈ {2, 4, 6}, default 4. PARTY_MAX_SIZE = 6.

`party_create`: caller becomes leader + only member. `party_invite`:
leader-only, delegates to `invites_repo.writeInviteCreate(kind='group')`
with payload `{partyId, partyMaxSize}`. `party_leave`: non-leader
always OK; leader alone → disband; leader with members → FORBIDDEN.
`party_kick`: leader-only. `party_get`: members-only (NOT
maintenance-gated, since it's a read).

**Matchmaker integration**: `mm_ticket_params` accepts an optional
`partyId`. When set, validates caller is leader + party is `open` +
members ≥ 1, then stamps `partyId` + `partySize` into the ticket
metadata. The leader's rating becomes the matchmaker band ceiling.

**Matchmaker matched-hook grouping**: `validatePartyGrouping` rejects
a candidate where matched entries carry different `partyId` values
("party split") or where the matched count differs from `partySize`
("party partial").

### 20.7 Phase 7 client integration checklist

```
auth → friend_code_get (cache the code locally)
auth → recent_rivals_get (read once)

party flow:
  party_create → {partyId}
  party_invite → {inviteId}
  peer: invite_list → invite_respond(accept=true) → joins party
  party_get (on every party-tab mount)
  party_leave when the user backs out

matchmaker with party:
  mm_ticket_params({..., partyId}) → ticket with stamped partyId+partySize
  matchmakerAdd(ticket)
  matchmakerMatched hook verifies party grouping

club flow:
  club_create (level 8 + 5000 coins, gated)
  club_search / club_get (browse)
  invite_send(kind='group', payload: {clubId}) → peer joins
  club_members_list (paginated via cursor)

moderation:
  report_player (when user reports a peer)
  admin_* gated by adminRpcKey (NOT for end-users)
```

See `docs/social.md`, `docs/parties.md`, `docs/chat-flow.md`-style
narrative (when added).

---

## 21. Phase 8 RPCs — Tournaments, Events, Anti-cheat, Admin Dashboard

Phase 8 ships four cross-cutting concerns: live tournaments, time-bounded
events, server-side anti-cheat, and an operator dashboard. The end-user
sees §21.1 (tournaments) and §21.2 (events); §21.3 (anti-cheat) and
§21.4 (admin dashboard) are operator-only.

### 21.1 Tournaments

```http
POST /v2/rpc/tournament_list
{ "callerUserId": "<uuid>", "status": "open" | "closing" | "all" }
→ { "tournaments": [{id, trackId, entryFee, minLevel, maxAttempts, state,
                     startsAtUtc, endsAtUtc, prizeTable}], "nextCursor" }

POST /v2/rpc/tournament_get
{ "callerUserId": "<uuid>", "tournamentId": "<tid>" }
→ { "tournament": {...} }

POST /v2/rpc/tournament_join
{ "callerUserId": "<uuid>", "tournamentId": "<tid>" }
→ { "joined": true, "entryFee": 100, "paidEntryFee": 100 }
```

`race_submit_result` accepts an OPTIONAL `tournamentId` field. When
present, the race subscriber updates the per-user `bestTimeMs` and
writes to the leaderboard. Multiple attempts allowed up to `maxAttempts`;
the leaderboard shows the minimum.

Tournament states: `open` (joining + racing), `closing` (last hour, no
new joins, racing still allowed), `closed` (prizes distributed or
voided). The 60s scanner in the server handles the transitions.

### 21.2 Events

```http
POST /v2/rpc/event_list
{ "callerUserId": "<uuid>" }
→ { "events": [{id, kind, startsAtUtc, endsAtUtc, isActive, payload}],
    "now": <epoch-ms> }
```

Three event kinds: `xp_double`, `featured_track`, `special_offer`. See
`docs/events.md` for the per-kind semantics.

The `store_get` RPC (chunk 8) decorates matching SKUs with `basePrice`,
`finalPrice`, and `activeSpecialOfferId?` when the user has an active
special offer in `profile.activeSpecialOffers`. The client should
display `finalPrice` in the store UI; if `activeSpecialOfferId` is
present, show a "Limited time" badge with the offer id (for analytics
attribution on the client side).

### 21.3 Anti-cheat (operator)

NOT exposed to end-users. The server-side subscriber (chunk 4) detects
impossible partial times, abrupt improvement, and position gaps in
low-confidence races. The detection rules live in
`catalogs/anti_cheat_thresholds.json`.

For the client UI: `race_submit_result` returns an `outcome.antiCheat`
block when a mark was created. The client should show a non-blocking
"unusual time" toast (not a punishment — operator reviews before any
sanction).

### 21.4 Admin dashboard (operator)

The 6 admin RPCs from chunk 9 are not for end-users. Operators use:

- `admin_overview_get` — top-of-dashboard counts (player count, active
  tournaments, active events, server uptime).
- `admin_tournaments_stats_get({fromDate, toDate})` — per-day opened /
  closed / participants / prizeCoinsDistributed.
- `admin_events_stats_get({fromDate, toDate})` — per-day
  xpDoubleActivated / featuredTrackActivated / specialOfferRedemptions /
  totalCoinsGranted.
- `admin_players_search({q, limit?, cursor?})` — case-insensitive
  userId OR displayName match. Limit 1..200 (default 20). Paginate via
  `nextCursor`.
- `admin_wallet_grant({userId, coins?, gems?, reason})` — whitelisted
  reasons only (`admin_grant` / `admin_compensation` /
  `admin_tournament_refund` / `admin_event_compensation` / `admin_other`).
  Both `coins` and `gems` capped at 100,000 per call.
- `admin_anti_cheat_dashboard_get({fromDate, toDate})` — live snapshot:
  pending marks, last-7d confirmed / dismissed, sanctioned users, top
  marked users, recent marks.

All 6 use `body.adminKey` (D7 amended; the HTTP `?http_key` query
parameter still works for ad-hoc curl tests but the JS check is the
source of truth). They bypass maintenance (operator can act during a
maintenance window) and write `admin_action` analytics per call.

### 21.5 Client integration recipe

```csharp
// End-user (read-only):
event_list → cache by {id, endsAtUtc} (refresh on home-tab mount)
tournament_list(status='open') → show "Live now" carousel
tournament_list(status='closing') → show "Ending soon" carousel
store_get → if any offer has activeSpecialOfferId, show discount badge
```

```csharp
// On race close (result handler):
var ac = result.antiCheat;
if (ac != null && ac.marked) {
  // Soft-acknowledge — do NOT punish the player client-side.
  ShowToast("Your time was flagged for review");
}
```

```csharp
// On store mount (post-login):
var offers = await NakamaClient.Rpc("store_get", ...);
foreach (var s in offers.sections) {
  foreach (var o in s.offers) {
    if (o.activeSpecialOfferId != null) {
      o.DisplayBadge("Limited time");
      o.DisplayPrice(o.finalPrice);
    } else {
      o.DisplayPrice(o.basePrice);
    }
  }
}
```

See `docs/tournaments.md`, `docs/events.md`, `docs/anti-cheat.md`,
`docs/admin.md` for the full operator surface.

---

## 22. Phase 9 RPCs — IAP, ads, admin analytics

Phase 9 ships three public RPCs (the IAP + ads + subscription surface)
and sixteen admin RPCs (six for IAP operations + ten for analytics).
All bypass maintenance (D63, D72, D77, D79, D91).

### 22.1 Public RPCs

- `iap_purchase({platform, productId, receiptData, transactionId})` —
  single entry point for Apple/Google/Mock purchases. The client passes
  the platform-specific productId (`com.cvg.coins100` for Apple,
  `coins_100` for Google). Returns the same shape regardless of provider.
  Maintenance bypass (D63). See `docs/iap.md` §2.
- `iap_subscription_status({})` — read the caller's current sub state.
  No body. Returns `{hasSubscription, subscription: {isActive, isExpired,
  expiresAtUtc, autoRenewing, ...}}` or `{hasSubscription: false}`.
  Maintenance bypass (D72). See `docs/iap.md` §7.
- `iap_subscription_cancel({platform, transactionId})` — one-way cancel
  (D70). Sub remains active until `expiresAtUtc`. Re-cancel returns
  `CONFLICT`. Maintenance bypass (D72).
- `ad_watched({tier, provider, adUnitId, impressionId, watchedAtUtc})`
  — single entry point for rewarded ads. The client generates the
  `impressionId` as a UUID v4; the server verifies format + 60s skew.
  `provider` is `mock` only in Phase 9 (D76). Maintenance bypass (D77).
  See `docs/ads.md` §2.

### 22.2 Admin RPCs (16 total)

All use `body.adminKey` (D7 amended). The HTTP `?http_key` query param
still works for ad-hoc curl tests but the JS check is the source of
truth.

#### IAP operations (6 — Phase 9 Chunk 6)

- `admin_iap_purchases_list({platform?, userId?, limit?, cursor?})` —
  filter purchases. D80 pagination via `storageList` cursor.
- `admin_iap_purchases_get({userId, transactionId})` — full purchase +
  attached fraud flags.
- `admin_iap_refund({userId, transactionId, reason})` — 90d cap (D86).
  Empty reason → `BAD_REQUEST`. Already refunded → `CONFLICT` (D90).
- `admin_iap_fraud_flags_list({status?})` — filter by `pending` /
  `reviewed` / `actioned` / `dismissed`.
- `admin_iap_fraud_flag_action({transactionId, action, reason})` —
  `ban` adds a 30d `admin_anti_cheat_sanction` on the conflicting user
  (D85); `dismiss` / `confirm` are status flips.
- `admin_iap_revenue_stats_get({fromDate, toDate, platform?})` —
  per-platform totals + 60s cache (D83). `netRevenue = totalRevenue - refunded`.

#### IAP analytics (4 — Phase 9 Chunk 7)

- `admin_iap_analytics_get({fromDate, toDate})` — aggregated counts:
  `totalInitiated`, `totalValidated`, `totalDelivered`, `totalFailed`,
  `validationRate`, `deliveryRate`, `totalRefunded`, `netRevenue`,
  `purchaseCount`, `uniqueBuyers`, `adWatchCount`, `adCoinsGranted`,
  `averageOrderValue`. 60s cache.
- `admin_iap_ltv_get({cohortWeekStart, windows: ['7d'|'30d'|'90d']})` —
  cohort math (D93): cohort = first delivered in
  `[cohortStart, cohortStart+7d)`, LTV windows measured from cohort
  start. Returns `{cohortSize, ltv: {7d, 30d, 90d}, perPack[]}`.
- `admin_iap_funnel_get({packId?, platform?, fromDate?, toDate?})` —
  3 stages (initiated/validated/delivered) with `conversionFromInitiated`
  and `conversionFromPrevious`. `byPack` and `byPlatform` mirror the
  global funnel.
- `admin_iap_top_buyers_get({fromDate, toDate, limit?})` —
  `admin-only privacy` (D92). `username` resolved via `nk.accountGetId`.
  Default limit 20 (1..200).

#### Ads analytics (1 — same RPC, different signal)

The ad pipeline emits 4 event types (`ad_watch_initiated`,
`ad_watch_granted`, `ad_watch_blocked`, `ad_watch_failed`) and the
`admin_iap_analytics_get` RPC aggregates `ad_watch_granted` into
`adWatchCount` + `adCoinsGranted` (per the date range). No dedicated
ads admin RPC in Phase 9 — see `docs/ads.md` §7.

#### Subscriptions (no new admin RPC in Phase 9)

Subscription state is read via the public `iap_subscription_status`.
The 5-min scanner handles renewal + expiry. Operators audit
`iap_subscriptions/{userId}` directly.

#### Maintenance bypass + cache

All 16 admin RPCs bypass maintenance. The 6 with aggregation logic
(1 IAP revenue + 4 IAP analytics + 1 ads via `admin_iap_analytics_get`)
use 60s in-memory TTL caches keyed on input parameters.

### 22.3 Error codes (IAP slice)

| Code | Cause |
|---|---|
| `UNAUTHENTICATED` | `ctx.userId` missing (iap_purchase, ad_watched) |
| `BAD_REQUEST` | Missing/invalid field; empty refund reason; invalid platform |
| `NOT_FOUND` | Pack not in catalog; tier not in catalog; purchase not found; subscription not on file |
| `CONFLICT` | Cross-user fraud; refund window expired; already refunded; daily cap reached; cooldown not elapsed; already cancelled |
| `INTERNAL` | Receipt verify failure; mock verify failure; storage write failure |
| `SERVICE_UNAVAILABLE` | Admin key not configured |

### 22.4 Client integration recipe

```csharp
// On IAP purchase (post-store-transaction callback):
var platform = StoreKit.IsApple() ? "apple" : "google";
var productId = StoreKit.GetCurrentProductId();
var receiptData = StoreKit.GetReceiptBase64();
var txId = StoreKit.GetTransactionId();
var r = await NakamaClient.Rpc("iap_purchase", new {
  platform, productId, receiptData, transactionId = txId
});
if (r.idempotent) {
  // Replay — content was already granted on first call. Update UI and exit.
  return;
}
// On success, refresh wallet + garage from the new balance.
var content = r.content;
if (content.coinsGranted > 0)  ShowToast($"+{content.coinsGranted} coins");
if (content.firstTimeBonus > 0) ShowToast($"+{content.firstTimeBonus} first-time bonus!");
if (content.cosmeticId != null) ShowToast("New cosmetic unlocked");
```

```csharp
// On rewarded ad completion (Unity Ads / AdMob callback):
var impressionId = Guid.NewGuid().ToString();
var watchedAtUtc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
var r = await NakamaClient.Rpc("ad_watched", new {
  tier, provider = "mock", adUnitId, impressionId, watchedAtUtc
});
if (r.idempotent) {
  // Same impressionId replayed — same reward. Refresh UI, exit.
  return;
}
ShowToast($"+{r.coinsGranted} coins");
UpdateDailyAdCounter(r.dailyCount, r.dailyCap);  // e.g. "3 / 10 today"
if (r.dailyCount >= r.dailyCap) {
  DisableAdButton();
}
```

```csharp
// On subscription status poll (every 60s on home tab):
var r = await NakamaClient.Rpc("iap_subscription_status", new { });
if (!r.hasSubscription) {
  ShowSubscriptionUpsell();
  return;
}
if (r.subscription.isActive && r.subscription.autoRenewing) {
  ShowActiveBadge();
} else if (r.subscription.isActive && !r.subscription.autoRenewing) {
  ShowCancellingBadge($"Renews until {FormatDate(r.subscription.expiresAtUtc)}");
} else {
  ShowExpiredBadge();
}
```

```csharp
// On subscription cancel (settings → "Cancel subscription"):
// First: ask the App Store / Play Store to show their native cancel UI.
// After their confirmation:
var r = await NakamaClient.Rpc("iap_subscription_cancel", new {
  platform, transactionId = latestTransactionId
});
// Sub remains active until expiresAtUtc. UI should show "Cancelling —
// active until {date}".
```

### 22.5 Polling cadences

| RPC | Recommended cadence | Reason |
|---|---|---|
| `iap_purchase` | per store-transaction (event) | one-shot |
| `iap_subscription_status` | every 60s on home tab | balance may change from renewal (server-driven) |
| `iap_subscription_cancel` | one-shot on user tap | not polled |
| `ad_watched` | per ad completion (event) | one-shot |
| `admin_iap_analytics_get` | every 5min on operator dashboard | 60s server cache makes 30s polls wasteful |
| `admin_iap_ltv_get` | every 1h on operator dashboard | cohort math is heavy |
| `admin_iap_funnel_get` | every 5min | 60s server cache |
| `admin_iap_top_buyers_get` | every 1h on operator dashboard | privacy-sensitive; not for end-user UI |

### 22.6 Privacy

`admin_iap_top_buyers_get` is **admin-only** (D92). The `username` field
in the response is resolved via `nk.accountGetId` and MUST NOT be
exposed to end users. The RPC also bypasses maintenance so operators can
audit buyers during a maintenance window.

See `docs/iap.md`, `docs/ads.md`, and `docs/admin.md` §13-15 for the
full operator surface.
