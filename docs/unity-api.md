# Unity Integration API — CarVideoGameBackend (Phase 1 + Phase 2)

API reference for the Unity racing-game client. Covers auth, RPC contracts,
error codes, storage collections, and catalog shapes. Race results come back in
RPC responses; the server sends no race event over the socket (§7).

**Status:** every phase through Phase 9 is shipped, plus the server-fixes plan
(F0–F8, branch `fix/audit-preconditions`). The machine-readable contract is
`docs/openapi/unity-client.openapi.json` (and its `.yaml` mirror): every
player-facing RPC the server registers is there, and
`tests/unit/openapi_contract.test.ts` fails when the two drift. The operator
`admin_*` RPCs are indexed in `docs/admin.md` §2.

---

## 1. Endpoints & transport

| Channel | URL / transport | Notes |
|---|---|---|
| Production (Cloudflare tunnel) | `https://api.gapolaniadev.com` | Public-facing |
| Local (Docker + `docker-compose.local.yml`) | `http://127.0.0.1:8081` | Direct to the Nakama HTTP gateway; ports bound to 127.0.0.1 only (README, "Local stack") |
| Socket (relay match + matchmaker) | `wss://api.gapolaniadev.com` | Relay-pure match; the server does not inspect match frames |

**Server key** (HTTP Basic auth on the authenticate calls only, see §2): `NAKAMA_SERVER_KEY` from `.env`.
**HTTP key** (`?http_key=` query): `NAKAMA_RUNTIME_HTTP_KEY` from `.env`. Only for
server-to-server RPCs (`admin_*`, `ads_levelplay_callback`); a player RPC never
needs it.

The client gets a **session token** after authentication
(`POST /v2/account/authenticate/device`) and passes it as `Authorization: Bearer <token>`
on every RPC.

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
- Session token: **2 h**; refresh token: **7 days** (`session.token_expiry_sec`
  7200, `session.refresh_token_expiry_sec` 604800; plan T-02). Refresh with
  `POST /v2/account/session/refresh`.
- **Identity comes only from the session** (plan D-03, T-04). Nakama fills
  `ctx.userId` from the Bearer token on every RPC, HTTP or socket. The body
  fields `callerUserId`, `hostUserId` and `userId` (race create/join/submit)
  are optional and kept for compatibility: when present they must equal the
  session user, otherwise `FORBIDDEN`; when absent the session user is used.
  No session → `UNAUTHENTICATED`.

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

`error.code` is one of the 14 codes of `modules/src/core/errors.ts`
(`ERROR_CODES`): the original 13 plus `CONTENT_REJECTED` (plan T-22). The
OpenAPI `ErrorCode` enum and this table list exactly those codes
(`tests/unit/openapi_contract.test.ts`). Many errors also carry
`error.details.reason` with a finer reason (e.g. `NOT_HOST`, `BLOCKED`,
`MIN_LEVEL`, `NATIVE_LINK_REQUIRED`, `RECEIPT_USED`, `REFUNDED`,
`NOT_CONFIGURED`); branch on `code` first.

| Code | When |
|---|---|
| `BAD_REQUEST` | Malformed payload, missing field, wrong type, business-rule violation in input (e.g. size not allowed) |
| `UNAUTHENTICATED` | No session (`ctx.userId` empty) |
| `FORBIDDEN` | Authz violation: not host, not on roster, identity field ≠ session user, blocked, native call refused by a hook |
| `NOT_FOUND` | Unknown id (session, profile, club, offer, …) |
| `CONFLICT` | State transition not allowed, lost CAS race after retries, already claimed or used |
| `RATE_LIMITED` | Per-userId/per-RPC window exceeded |
| `INVALID_RESULT` | `race_submit_result` failed plausibility (clock, min time, lap sum) |
| `INTERNAL` | Uncaught server error — message is safe to surface |
| `CATALOG_INVALID` | A catalog failed validation at boot (the server does not start) |
| `INSUFFICIENT_FUNDS` | Wallet balance too low (store, upgrades, pass, tournaments, clubs, rerolls) |
| `SERVICE_UNAVAILABLE` | Maintenance window, or a dependency not configured or unreachable (e.g. IAP verification) |
| `UPGRADE_REQUIRED` | The body declares a `clientVersion` below the LiveOps minimum for its `platform` |
| `NOT_IMPLEMENTED` | An action the schema names but the server does not implement (admin only) |
| `CONTENT_REJECTED` | `chat_send`: the message contains a blocked word (plan T-22) |

Nakama answers HTTP 200 on `Err` envelopes — branch on `ok`, not on the status code.

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
  confidence?: Confidence;  // how the session was closed (`quorum` | `client` | `server`); absent while open
  version: number;          // monotonic CAS counter
}
```

---

## 6. RPCs

Player RPCs are `POST /v2/rpc/<name>` with `Authorization: Bearer <session token>`
and a JSON-string body (§3). No `http_key`. The caller is always the session
user (§2); the identity fields shown in the bodies below are optional.

### 6.1 `config_get`

Public catalog + clock sync. **No auth required for the payload**, but the HTTP
gateway still requires `Authorization` (use the session Bearer, or any token).

```json
// body (optional; any body is accepted)
"{\"platform\":\"android\",\"clientVersion\":\"0.3.0\"}"

// response.data
{
  "serverTimeMs":     1740000000000,
  "catalogsHash":     "sha256-of-catalogs-blob",
  "tracks":           [ ... track objects ... ],
  "modes":            [ ... mode objects ... ],
  "cars":             [ ... car objects ... ],
  "minClientVersion": "0.1.0"
}
```

`cars` is the car catalog in `cars.json` order; `catalogsHash` covers tracks, modes and cars.

`serverTimeMs` is used by the client to compute its clock offset vs the server
(median of N samples). `minClientVersion` is the LiveOps
`minClientVersion[platform]` (`platform` optional, default `ios`; plan T-14 —
it was a hard-coded `"1.0.0"`). A body that declares a `clientVersion` below it
gets `UPGRADE_REQUIRED`; without `clientVersion` the call always answers.
`config_get` is not maintenance-gated, so the client can still read the clock
and the minimum version to show the maintenance or update screen.

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

**Authz**: the host is the session user. `hostUserId` is optional; when present
it must equal the session user, otherwise `FORBIDDEN` (§2). The car class comes
from the player's garage, not from `hostLoadout` (plan T-10).

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

**Authz**: the session user must be in `session.roster`. Omitting `sessionId`
returns the caller's **active** session via the `race_active` index (plan T-08)
or, when there is none, the last closed one; with neither → `NOT_FOUND`. After
`matchmaker_matched` the client gets the session the matchmaker created this
way (plan T-09). Each roster entry carries `lastSeenMs` (plan T-07).

The `lastClosed` lookup is wired but returns `NOT_FOUND` until Chunk 9 (close +
quorum + RaceCompleted emission) finishes — currently active sessions are returned
without a `lastClosed` value.

**Dedicated race server** (additive; plan fishnet-nakama-server, D-04/D-05). When the
matchmaker assigned the session to a dedicated server, `session` carries
`serverHosted: true`, `server: { serverId, host, port }` and `laps`, and — while the
session is not `closed` — the response adds two top-level fields:

```json
{
  "session": { "serverHosted": true, "server": { "serverId": "race-eu-1", "host": "203.0.113.7", "port": 7770 }, "laps": 3, "...": "..." },
  "server": { "host": "203.0.113.7", "port": 7770 },
  "myJoinTicket": "3f2b9c0d5e1a4b7c8d9e0f1a2b3c4d5e"
}
```

`myJoinTicket` (32 hex characters) is the **caller's own** ticket for the race
server, valid until the session closes (a reconnection presents it again). The roster entries never expose `joinTicket`, neither the caller's nor anybody
else's, in any response. Sessions without a server (and closed ones) have neither field.

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

**Authz**: `report.userId` must be the session user (or a bot of the session
when `isBotReport=true`, accepted only from the host). Optional `requestId`
(1–128 chars, plan T-09): a retry with the same id returns the response of the
accepted submission instead of `CONFLICT`.

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
"{\"leaderboardId\":\"tt_neon_blvd_B_all\",\"view\":\"global\",\"limit\":20,\"cursor\":\"<nextCursor of the previous page>\"}"
// view ∈ { "global", "around_me", "friends" }
// aroundUserId optional — defaults to caller. Used by `around_me` to center.
// cursor optional (plan T-13) — nextCursor / prevCursor of a previous page of the same view.
// leaderboardId may also be a season's ranked table, e.g. "ranked_season_2".

// response.data
{
  "leaderboardId": "tt_neon_blvd_B_all",
  "view":          "global",
  "totalCount":    237,
  "records": [
    {
      "ownerId":  "<uuid>",
      "username": "player_123",
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
    // users without a profile fall back to { userId, displayName: <username>, avatarUrl: null }
  },
  "nextCursor": "<opaque>",   // null on the last page
  "prevCursor": null          // null on the first page
}
```

**View semantics**:

| View | Returns | Notes |
|---|---|---|
| `global` | the page in the table's own order (`wins_week` and ranked: most first; times: fastest first), Nakama's ranks | `ownerRecord` = `aroundUserId`'s row or `null` |
| `around_me` | Nakama's haystack around `aroundUserId` | falls back to the top page when that user has no record (NOT a 404) |
| `friends` | the caller and their friends (`friend_list_get`'s graph) that have a record, with global ranks | paged with `friends:<n>` cursors |

`totalCount` counts the whole table. A malformed `cursor` → `BAD_REQUEST`. A
season's ranked table that does not exist yet → an empty board.

**`limit`**: clamped to `[1, 100]`, default 20.

**Authz**: session user (§2); an optional `callerUserId` must match it, otherwise
`FORBIDDEN`.

Errors: `BAD_REQUEST` (missing leaderboardId / unknown view), `UNAUTHENTICATED`
(no caller), `FORBIDDEN` (caller mismatch), `NOT_FOUND` (unknown leaderboardId).

### 6.8 `profile_get` — Phase 2

Returns the caller's profile. Auto-creates a default profile (`displayName =
"Racer"`, `avatarUrl = null`) on first read.

With `userId` of **another** player (plan T-14) it returns only the public
projection `{ userId, displayName, avatarUrl, progression: { level } }` and never
creates anything: `NOT_FOUND` when that player has no profile.

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
    "updatedAt":   1740000000000,
    "progression": { "level": 2, "xp": 350, "levelStartXp": 200, "xpToNextLevel": 150, "unlockedLevels": ["class:D"], "lastDailyWinAt": 0 }
  }
}
```

`progression` is only on the caller's own profile. Level bar fill:
`(xp - levelStartXp) / (xp - levelStartXp + xpToNextLevel)`; the bar is full when
`xpToNextLevel` is `0` (max level).

**Authz**: session user (§2); an optional `callerUserId` must match it, otherwise
`FORBIDDEN`.

Errors: `FORBIDDEN`, `UNAUTHENTICATED`, `NOT_FOUND` (another player without a
profile).

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

**Authz**: session user (§2). **Spoof defense**:
the payload MUST NOT carry a `userId` field that differs from the caller (any
mismatch → `FORBIDDEN`).

Errors: `BAD_REQUEST` (length, pattern, avatarUrl too long), `FORBIDDEN`
(caller mismatch, spoofed userId, blocked word), `CONFLICT` (CAS — retry).

---

## 7. Race results (no socket event)

The server does **not** push a `RaceCompleted` message to the client: nothing
in the runtime sends it over the socket. The client reads the result from:

- the `race_submit_result` response that closes the session
  (`officialResults`, `confidence`, `flags`, and `rewards` per player); or
- `race_session_get` (with or without `sessionId`): once the session is
  `closed` it carries `results`. A session also closes lazily after the grace
  period with absent players `DNF` (plan T-06), so a client that did not
  send the closing report polls `race_session_get`.

`RaceCompleted` is an **internal** server event on the runtime's event bus,
published exactly once per session at close. Its subscribers write the
leaderboards (`docs/leaderboards.md`), ranked ratings, missions, achievements,
tournaments and anti-cheat partials. Shape, for reference only:

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
    laps?: number[];     // plan T-23 (anti-cheat partials)
  }>;
  flags: { needsReview: boolean; reviewReason?: string; botSession?: boolean };
  confidence?: 'quorum' | 'client' | 'server';   // plan T-09
  closedAt: number;      // server epoch-ms when close fired
}
```

**Confidence** is returned by `race_submit_result` (`confidence`) and stamped
on each leaderboard record's metadata (see §6.7 `lb_get`).

---

## 8. Catalogs (from `config_get`)

Every player-visible catalog text comes in English (the fallback) with a sibling key: `displayName` → `displayNameKey`, `title` → `titleKey`, `description` → `descriptionKey`. Keys are `<kind>.<id>.<field>` with kind `track`, `mode`, `car`, `cosmetic`, `store_section`, `store_offer`, `mission`, `achievement` or `division` and field `name`, `title` or `description` (e.g. `car.starter_viper.name`). A client uses its Unity Localization entry for the key when it has one and the English text otherwise. Keys are only added: clients that read `displayName` keep working.

### `tracks[]`

```json
{
  "id":          "neon_blvd",
  "displayName": "Neon Boulevard",
  "displayNameKey": "track.neon_blvd.name",
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
  "displayNameKey":  "mode.quick.name",
  "allowedSizes":    [2, 4, 6],
  "scoreMultiplier": 1.0,
  "usesRating":      false
}
```

`usesRating: true` means results feed into ranked season rating (Phase 4).

### `cars[]`

```json
{
  "id":           "starter_viper",
  "displayName":  "Starter Viper",
  "classId":      "D",
  "baseStats":    { "speed": 50, "acceleration": 50, "handling": 50, "nitro": 50 },
  "maxStats":     { "speed": 70, "acceleration": 70, "handling": 70, "nitro": 70 },
  "priceCoins":   0,
  "priceGems":    0,
  "requiredLevel": 1,
  "isStarter":    true,
  "displayNameKey": "car.starter_viper.name"
}
```

`priceGems` is always present (`0` when the car has no gem price).

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
| `quorum` | At least ⌈n/2⌉ of the human players reported (plan T-09) | All tables (`tt_*`, `lap_*`, `wins_week` +1 for rank-1 in `quick`/`ranked`) |
| `client` | Fewer than ⌈n/2⌉ humans reported (e.g. closed by the grace period); `needsReview: true` (`incomplete_reports`) | `tt_*` / `lap_*` only when `mode === 'time_trial'`. `wins_week` suppressed. |
| `server` | No humans reported; order is the bot roster by `totalMs` | All tables but `wins_week` (bots never win) |

`race_submit_result` returns the confidence (`confidence`), and the internal
`RaceCompleted` event carries it (plan T-09). Per-record confidence is also stamped on each leaderboard record's metadata
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
B64=$(printf "%s:" "$SERVER_KEY" | base64)

# 1) auth as device
TOKEN=$(curl -s -X POST https://api.gapolaniadev.com/v2/account/authenticate/device \
  -H "Authorization: Basic $B64" -H 'Content-Type: application/json' \
  -d '{"id":"unity-smoke"}' | jq -r .token)

# 2) config_get (player RPCs: Bearer only, no http_key)
curl -s -X POST "https://api.gapolaniadev.com/v2/rpc/config_get" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '""' | jq

# 3) race_session_create
curl -s -X POST "https://api.gapolaniadev.com/v2/rpc/race_session_create" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '"{\"matchId\":\"<match-id-from-socket>\",\"mode\":\"quick\",\"trackId\":\"neon_blvd\",\"size\":4,\"hostLoadout\":{\"classId\":\"C\",\"bodyId\":\"starter_viper\"}}"' | jq
```

The `matchId` comes from the socket match allocation (`ISession.MatchId` in
the Unity client). Against the local Docker stack, `npm run smoke:live`
exercises every RPC end to end (README).

---

## 14. What the client MUST NOT do

- **Never write to storage.** All `race_sessions/*` and `profiles/*` writes are server-only.
- **Never write to leaderboards.** There is no client RPC to write a record. The
  `beforeLeaderboardRecordWrite` hook rejects any record that lacks the
  `__server_token__` server stamp; clients cannot forge it.
- **Never act for another player.** The server takes the caller from the session
  only; an identity field in the body that names someone else is `FORBIDDEN`.
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

Eight new RPCs landed in Phase 3. All are owner-only: the caller is the
session user (§2); an optional `callerUserId` must match it. Cross-user
reads/writes return `FORBIDDEN`. No session returns `UNAUTHENTICATED`.

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

`sections[].section.displayNameKey` and `sections[].offers[].offer.displayNameKey` are the localization keys of the English `displayName` fields (T-11, D-11).

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

**Authz**: same as §16 — session user; an optional `callerUserId` must match it.

**Dedicated race server** (additive; plan fishnet-nakama-server, D-03). Send
`"hosting":"dedicated"` (mode `quick` only; any other mode is `BAD_REQUEST`) to queue for a
race on a dedicated server. The response then adds `hosting`, `minCount` and `maxCount` to
`output` and the same `hosting` to `ticket.query` and `ticket.metadata`; `size` is always
`4` whatever was sent. Pass `minCount`/`maxCount` to the matchmaker (`AddMatchmakerAsync`
min/max count): the group has 2 to 4 players.

```json
// response.data (hosting: "dedicated")
{
  "ticket": {
    "query":    { "mode":"quick","size":4,"version":"1.0.0","region":"eu-west-1","segmentBy":"none","ratingBand":"unrated","hosting":"dedicated" },
    "metadata": { "mode":"quick","size":"4","version":"1.0.0","region":"eu-west-1","segmentBy":"none","hosting":"dedicated" }
  },
  "output": { "mode":"quick","size":4,"hosting":"dedicated","minCount":2,"maxCount":4,"version":"1.0.0","region":"eu-west-1","mm":{"segmentBy":"none"},"constraints":{"excludeTrackIds":[]} }
}
```

Dedicated tickets queue only with dedicated tickets. When no race server is free at match
time, no session is created (§6.5 keeps answering `NOT_FOUND`): the client gives up after its
wait for the session.

Errors: `BAD_REQUEST` (unknown mode / size / platform / hosting; hosting with a mode other than
`quick`; malformed JSON). Rate limit: 30/60s.

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

`divisionName` (English) and `divisionNameKey` (`division.<id>.name`) are added to the output (T-11, D-11).

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

**Authz**: session user (§2). NO `FORBIDDEN` for cross-user reads — D11
marks ranked as public.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `FORBIDDEN` | `callerUserId` present and ≠ session user |
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
fields. The maintenance gate (`SERVICE_UNAVAILABLE`) always applies; the
min-version gate (`UPGRADE_REQUIRED`) applies only when `clientVersion` is
present and below `minClientVersion[platform]` — a request without it passes
(plan T-14, D-05) — see `docs/liveops.md` §2 and §3.

**Maintenance gate summary** (which RPCs are gated vs which are exempt):

| RPC | Gated by | Notes |
|---|---|---|
| `liveops_config_get` | none (splash) | Always callable |
| `inbox_list` | none (splash) | Badge renders during maintenance |
| `account_delete` | none (GDPR) | Erasure cannot be blocked by ops |
| `admin_*` | `skipForAdmin: true` | Admins work during maintenance |
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
  "calendar": [{ "id": "evt_xp2_late_oct", "type": "event", "kind": "xp_double",
                 "startUtc": "2026-10-23T00:00:00Z", "endUtc": "2026-10-30T23:59:59Z" }],
  "configHash": "<sha256-hex>"
}
```

`calendar` comes from the one event source, `events.json` (plan T-23):
the events that have not ended, plus the maintenance windows of the
liveops config.

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

Since T-17 this is the **only** inbox: admin messages, club week prizes
and ranked season rewards (claimable, `reward`), plus notices of what the
server already delivered (tournament prizes and refunds, event bonuses,
IAP, ads, subscriptions: `kind: "system"`, `granted`, no `reward`).

```json
// request
{
  "limit":        50,            // optional, default 50, max 100
  "cursor":       "<opaque>",    // optional, for pagination
  "includeClaimed": false        // optional, default false
}

// response.data
{
  "messages": [
    {
      "id":         "season_2-rank-2",
      "kind":       "reward",
      "title":      "Season reward: Silver",
      "body":       "Season 1 — Silver tier (rank 2-3)",
      "reward":     { "coins": 2500, "cosmeticId": "..." },
      "source":     "season_silver",          // additive (T-17)
      "createdAt":  1760000000000,            // epoch ms
      "expiresAt":  1762592000000             // 30d retention
    },
    {
      "id":         "tournament:tt_ladder_2026w42:prize:<uuid>:1",
      "kind":       "system",
      "title":      "Tournament prize",
      "body":       "Tournament prize: rank 1",
      "granted":    { "coins": 400 },         // additive: already paid
      "source":     "tournament_prize",
      "createdAt":  1760000000000,
      "expiresAt":  1762592000000
    }
  ],
  "unreadCount": 2,
  "nextCursor":   ""             // "" when no more
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | malformed payload |

### 18.3 `inbox_claim`

Claim a message. The payout (coins / gems), the garage items and
`claimedAt` are **one transaction** (T-17): two concurrent claims pay
once, and a failed payout writes nothing, so the message stays
claimable. A notice (no `reward`) is just acknowledged.

```json
// request
{
  "messageId":    "season_2-rank-2",
  "clientVersion": "1.2.0",     // optional, see §18 top
  "platform":      "ios"        // optional, see §18 top
}

// response.data
{
  "message":     { "id": "season_2-rank-2", "claimedAt": 1760000500000, ... },
  "newBalance":  { "coins": 3500, "gems": 25 },        // when currencies were paid
  "delivered":   { "cosmeticId": "paint_red_flame" },  // garage items added
  "undelivered": ["cosmetic:legendary_aether_chassis"] // additive: not in the catalog (logged)
}
```

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `NOT_FOUND` | unknown messageId OR not in this user's inbox |
| `CONFLICT` | already claimed (also the loser of two concurrent claims), or a concurrent update (`details.reason = VERSION_CONFLICT`: retry) |
| `BAD_REQUEST` | message past `expiresAt` (the message says "expired") |
| `INTERNAL` | the payout failed: nothing written, still claimable |
| `SERVICE_UNAVAILABLE` | maintenance |

### 18.4 `account_link`

Linking is **native** (T-15): the client links with the Nakama client
API (`LinkGoogleAsync`, `LinkAppleAsync`, `LinkEmailAsync`,
`LinkCustomAsync`, `LinkSteamAsync`, `LinkFacebookAsync`) and Nakama
verifies the identity. `account_link` then credits the one-time 500-coin
bonus. It takes no token: a body with `token` is rejected
(`BAD_REQUEST`, `details.reason = NATIVE_LINK_REQUIRED`).

```json
// request
{ "provider": "google" }   // optional: must be linked to the account

// response.data
{
  "linked":       true,
  "providers":    ["google"],
  "bonusClaimed": true,
  "newBalance":   { "coins": 500, "gems": 0 }
}
```

| Error | When |
|---|---|
| `BAD_REQUEST` | `token` sent (NATIVE_LINK_REQUIRED), unknown provider |
| `CONFLICT` | `details.reason = NOT_LINKED`: no linked identity, or `provider` not linked |
| `NOT_FOUND` | the account no longer exists |

See `docs/account-linking.md` §1.

### 18.5 `account_link_resolve_conflict`

A native link of an identity owned by another account fails with HTTP
409. The client authenticates with that identity (`create: false`) to
get a session of the other account, then:

```json
// 1. with the OTHER account's session
{ "step": "open" }
// response.data
{
  "conflictToken": "<uuid>",
  "expiresAt":     "2026-10-22T12:10:00.000Z",     // 10 minutes
  "target": { "userId": "<uuid>", "createdAt": 0,
              "profile": { "name": "...", "level": 3, "xp": 120, "coins": 900, "gems": 4 } }
}

// 2. with the session that KEEPS the identity
{ "step": "resolve", "conflictToken": "<uuid>", "choice": "link", "confirmText": "TRANSFER" }
// response.data
{ "resolved": "linked", "affectedAccountDeleted": true, "relinkProviders": ["google"] }
// or choice "cancel" → { "resolved": "cancelled" }
```

After `link` the other account is deleted with the full account purge
(§18.6) and its identities are free: link them again natively and call
`account_link` for the bonus.

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | missing fields, `confirmText` not `TRANSFER`, resolving from the account being deleted |
| `CONFLICT` | `open` without a linked identity (`NOT_LINKED`) |
| `NOT_FOUND` | unknown, used or expired `conflictToken`; the other account is gone |

### 18.6 `account_delete`

GDPR right to erasure. Bypasses the maintenance gate — a broken
session token still rejects, but an ops pause does not.

```json
// request
{
  "confirmText":   "DELETE"   // sentinel — exact match
}

// response.data
{
  "deletedAt": "2026-10-07T12:00:00Z",
  "summary": {
    "storageDeleted":      42,
    "collectionsAffected": ["garage","idem","inbox","profiles", ...],
    "referencesRemoved":   3,                  // friends' mirror edges, invites sent, ...
    "boardsDeleted":       3,
    "boardsAffected":      ["lap_neon_blvd","time_neon_blvd","wins_week"],
    "unlinkedAuths":       ["google"],
    "wasClubLeaderOf":     [],
    "abandonedFromRaces":  0
  }
}
```

Cascade (T-16): every collection of the registry `core/collections.ts`
(owned objects, system rows keyed by the user, other players' references),
every leaderboard record, then `accountDeleteId` (identities, friends,
group memberships, wallet ledger).

| Error | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `BAD_REQUEST` | `confirmText !== 'DELETE'` |
| `INTERNAL` | the Nakama account delete failed |

See `docs/account-linking.md` §3–§4 for the cascade contract.

### 18.7 `relay_token` (removed)

Removed on 2026-10-22 together with the regional Nakama relay
(decision D-01 of the backend fix plan). Race traffic uses Unity Relay.

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
| `clientVersion` | every Phase 5 RPC body | optional semver string; triggers `UPGRADE_REQUIRED` when present and stale (absent = passes, plan T-14) |
| `platform` | every Phase 5 RPC body | `ios` \| `android` \| `windows` \| `macos` \| `linux` |
| `region` | server-stamped on `mm_ticket_params` | defaults to home region (e.g. `us-east-1`); client can override in a future iteration |
| `http_key` query | every admin RPC | defense-in-depth; see `docs/admin.md` §1 |

### 18.10 Maintenance gate behaviour

| Class | Behaviour during maintenance |
|---|---|
| Gated RPCs (player-facing, gated) | Return `SERVICE_UNAVAILABLE`; client shows the splash with the liveops config |
| Splash RPCs (`liveops_config_get`, `inbox_list`) | Always callable |
| GDPR RPC (`account_delete`) | Always callable (GDPR > ops) |
| Admin RPCs (`admin_*` with `skipForAdmin`) | Always callable |

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

Each mission carries `titleKey` and `descriptionKey` next to its English `title` and `description` (T-11, D-11).

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

Claim the reward for a completed mission. The `claimed` flag,
`reward.coins/gems` (durable key
`mission:${kind}:${period}:${missionId}:${userId}`) and `reward.xp`
(battle pass) commit in one transaction (T-20): a second claim returns
`CONFLICT`, and a failed payout leaves the mission claimable.

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
  "newBalance":  { "coins": 1100, "gems": 0 },
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
(`PAID_REROLL_COST_GEMS = 50`), charged in the same transaction as the
new mission (T-20: without gems the mission does not change). Returns
the new mission definition.

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

Each achievement carries `titleKey` and `descriptionKey` next to its English `title` and `description` (T-11, D-11).

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

Claim the reward for a completed achievement. The `claimed` flag,
`reward.coins/gems`, `reward.cosmeticId` (garage bag) and `reward.xp`
(battle pass) commit in one transaction (T-20). A cosmetic missing from
the catalog is logged and returned in `undelivered` (additive).

```json
// request
{ "callerUserId":"<uuid>", "achievementId":"achv_wins_quick_10", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "achievementId": "achv_wins_quick_10",
  "reward":        { "coins": 500, "xp": 200 },
  "granted":       { "coins":500, "gems":0, "cosmetics":[], "skippedCosmetics":[] },
  "xpGranted":     200,
  "passLevel":     3,
  "levelUps":      [3],
  "newBalance":    { "coins": 1500, "gems": 0 }
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

Claim the reward for a single level's free or premium track. The
claim mark, the coins/gems and the garage items commit in one
transaction (T-19): a second claim returns `CONFLICT` and a failed
payout leaves the level claimable. Cosmetics / cars missing from the
catalogs are logged and returned in `undelivered` (additive).

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
  "nextLevel":    2,
  "newBalance":   { "coins": 100, "gems": 0 },
  "undelivered":  ["cosmetic:paint_winter01"]   // only when something is missing
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

Spend `premiumPriceGems` from the wallet and unlock the premium track,
in one transaction (T-19: a failed charge changes nothing). Idempotent —
second call returns the current state without re-charging.

```json
// request
{ "callerUserId":"<uuid>", "clientVersion":"1.2.0", "platform":"ios" }

// response.data
{
  "userId":           "<uuid>",
  "seasonId":         "s1",
  "premiumPurchased": true,
  "priceGems":        800,
  "newGemsBalance":   9200,
  "newBalance":       { "coins": 0, "gems": 9200 }
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
| `mission_claim` | n/a | (claim) | `reward.xp` from mission catalog, in the claim's transaction |
| `achievement_claim` | n/a | (claim) | `reward.xp` from achievement catalog, in the claim's transaction |

Race XP is **deduplicated** via the `pass_xp_ledger` collection keyed
by `(userId, source, sessionId)`, written in the same storage write as
the XP. Mission/achievement XP is the pass record CAS inside the
claim's transaction (T-20), so the claim and its XP land together.

`addPassXp` returns `{record, levelUps: number[], applied: boolean}`.
`applied: false` is non-fatal — the subscriber never throws.

### 19.11 Season close + lazy storage

- **Season close (T-19)** — once `now > endUtc`, the global
  `season_close/{seasonId}` marker is written (by `pass_get`, the
  service ticker or `admin_pass_season_close`) and every player's
  record is settled, paged and resumable: the levels reached and not
  claimed go to the inbox as one claimable `pass_end:{seasonId}`
  message (plus one per car). After close, `pass_claim` and
  `pass_buy_premium` return `CONFLICT: 'pass season is closed'`. See
  [`docs/pass.md`](./pass.md) §5.
- **Lazy storage** — `PassRecord`, mission rows and
  `AchievementsRecord` are created on first need: the read RPC, or a
  race / claim that touches them (T-20). Everything is owner-read,
  server-only write (T-18).

### 19.12 Cosmetic / car idempotency

`garage/delivery.ts` plans the garage CAS that each claim commits in
its transaction (cosmetic ids to `garage.cosmeticsBag`, car ids to
`garage.cars`). A cosmetic already in the bag is skipped (`200` with
`skippedCosmetics: [cosmeticId]`, never an error); one missing from the
catalog is also listed in `undelivered`.

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
| `club_create` | level ≥ 8, not in a club | YES | `{clubId, name, costPaid, newBalance}` |
| `club_get` | any | YES | `{club, members, weeklyRank}` |
| `club_search` | any | YES | `{clubs, nextCursor}` |
| `club_join` | level ≥ 8, not in a club (T-21) | YES | `{clubId, userId, role, joinedAt}` |
| `club_update` | leader / admin | YES | `{clubId, updatedAt}` |
| `club_members_list` | any | YES | `{members, nextCursor}` |
| `club_kick` | leader / admin | YES | `{removed, clubId, targetUserId}` |
| `club_promote` | leader | YES | `{clubId, userId, role}` |
| `club_demote` | leader | YES | `{clubId, userId, role}` |
| `club_leave` | member | YES | `{left, clubId, userId}` |
| `chat_send` | member / friend | YES | `{messageId, ts, channelId}` |
| `chat_list` | member / friend | NO (read) | `{messages, nextCursor}` |
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

`club_create` charges 5000 coins (level ≥ 8, not in a club) in the
transaction that writes the club metadata and the leader's membership.
A club is a CLOSED Nakama group; the roster is the group joined with one
membership row per player (`clubs_members/current/{userId}`), which holds
the role and the weekly contribution (plan T-21).

`club_join { clubId }` is the only way in: one club per player, room
left, level ≥ 8, the club's minimum division, no block with the leader
or an admin. Refusals carry `details.reason`: `CONFLICT`
(`ALREADY_MEMBER` | `ALREADY_IN_CLUB` | `CLUB_FULL`) or `FORBIDDEN`
(`BLOCKED` | `MIN_LEVEL` | `MIN_DIVISION`). The native `JoinGroup` and the
other client group calls answer 403. `club_promote` / `club_demote` accept
`officer` as an alias of `admin`. `club_members_list` pages with an
offset cursor over leader, admins, then members by join date. Weekly
points live in the `club_week` leaderboard (lazy reset on the first
`club_get` / `club_search` of the week); the winners' reward is a
claimable inbox message.

### 20.4 Chat (Chunk 6)

`chat_send`: 200 char cap, 1 msg/sec + 20/min rate. A blocked word
(es/en/pt, leet-normalized) answers `CONTENT_REJECTED`; a direct message
to a player with a block either way answers `FORBIDDEN` with
`details.reason = 'BLOCKED'` (plan T-22). Channel types: `club`
(targetId = clubId), `direct` (targetId = recipientUserId).
3 reports in 24h → 1h chat-only silence (auto-triggered by the report
flow).

`chat_list { channelType, targetId, limit?, cursor? }` returns the
history newest first, 7-day retention; pass `nextCursor` back for the
next (older) page (`''` = no more). `senderName` is the account username.
A club history hides the messages of senders with a block with the
reader. `validateChatSend` runs inside the RPC (no native channel).

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
→ { "tournament": {...}, "myEntry": {...} | null,
    "topTimes": [{userId, bestTimeMs, position, username}],   // top 10 (T-23)
    "myRank": 3 | null }

POST /v2/rpc/tournament_join
{ "callerUserId": "<uuid>", "tournamentId": "<tid>" }
→ { "entryId", "joinedAt", "attemptsRemaining", "paidEntryFee", "newBalance" }
```

`tournament_join` charges the entry fee and writes the entry in one
transaction (plan T-23): `INSUFFICIENT_FUNDS` leaves no entry. Prizes
arrive in the inbox as claimable rewards (`inbox_claim` pays them); a
tournament closes once.

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
`finalPrice`, and `activeSpecialOfferId?` while a `special_offer` event of
the calendar is live (one event source, `events.json`, plan T-23; the
`calendar` of `liveops_config_get` is the same list). The client should
display `finalPrice` in the store UI; if `activeSpecialOfferId` is
present, show a "Limited time" badge with the offer id (for analytics
attribution on the client side). `store_buy` charges exactly that
`finalPrice` (same function, server clock) and reports it as
`pricePaid` (plan T-12).

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

Phase 9 ships the IAP + ads + subscription surface and sixteen admin
RPCs (six for IAP operations + ten for analytics). Plan F7 (T-24, T-25)
made receipt verification real and moved ad payouts to LevelPlay's
signed server-to-server callback. All bypass maintenance (D63, D72, D77,
D79, D91).

### 22.1 Public RPCs

- `iap_purchase({platform, productId, receiptData, transactionId})` —
  single entry point for Apple/Google purchases. The client passes the
  platform-specific productId (`com.cvg.coins100` for Apple, `coins_100`
  for Google), Unity's `Order.Info.Receipt` as `receiptData` (unified
  receipt; Google in the `UnityPayload` or `PurchaseJson` format) and the
  store transaction id. The server verifies with the store credentials of
  `runtime.env` (the mock only with `IAP_MOCK=true`), rejects refunded
  purchases (`details.reason = REFUNDED`) and delivers once per
  `(user, platform, transaction)`: a retry answers `idempotent: true`.
  Rejections carry `details.reason`; a store without credentials is
  `SERVICE_UNAVAILABLE` / `NOT_CONFIGURED`. Maintenance bypass (D63). See
  `docs/iap.md` §2–§3.
- `iap_subscription_status({})` — read the caller's current sub state.
  No body. Returns `{hasSubscription, subscription: {isActive, isExpired,
  expiresAtUtc, autoRenewing, ...}}` or `{hasSubscription: false}`.
  Maintenance bypass (D72). See `docs/iap.md` §7.
- `iap_subscription_cancel({platform, transactionId})` — one-way cancel
  (D70). Sub remains active until `expiresAtUtc`. Re-cancel returns
  `CONFLICT`. Maintenance bypass (D72).
- `ad_watched({tier, provider, adUnitId, impressionId, watchedAtUtc})`
  — **does not pay** since T-25 (PC-05): an optional report of a watch
  seen by the client; answers `granted: false`, `coinsGranted: 0`,
  `rewardVia: 'server_callback'`, the balance and today's paid count.
  Maintenance bypass (D77). See `docs/ads.md` §5.
- `ad_reward_status({sinceUtc?, limit?})` — the caller's rewards paid by
  the ad network's callback (newest first), `dailyCount`, `dailyCap`,
  `dailyResetAtUtc`, `newBalance`. Poll it after a rewarded ad closes.
  See `docs/ads.md` §4.
- `ads_levelplay_callback` — **server-to-server only** (LevelPlay calls
  it with `http_key`; a session is `FORBIDDEN`). Pays a rewarded ad once
  per signed LevelPlay event; never called by the client. See
  `docs/ads.md` §3.

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
| `UNAUTHENTICATED` | `ctx.userId` missing (iap_purchase, ad_watched, ad_reward_status) |
| `BAD_REQUEST` | Missing/invalid field; empty refund reason; invalid platform; receipt rejected (`details.reason`: `INVALID_RECEIPT`, `PRODUCT_MISMATCH`, `PROVIDER_MISMATCH`, `EXPIRED`, `REFUNDED`, `PENDING`) |
| `NOT_FOUND` | Pack not in catalog; tier not in catalog; purchase not found; subscription not on file |
| `CONFLICT` | Receipt used by another account (`RECEIPT_USED`); `ALREADY_CONSUMED`; refund window expired; already refunded; already cancelled |
| `FORBIDDEN` | (callback) bad signature (`BAD_SIGNATURE`) or called with a session |
| `INTERNAL` | Storage / wallet failure |
| `SERVICE_UNAVAILABLE` | Receipt verification not configured or unreachable (`NOT_CONFIGURED`, `NETWORK_ERROR`, `VERIFICATION_FAILED`); ad callback secret not configured; admin key not configured |

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
// Rewarded ads (T-25): init LevelPlay with the Nakama user id, so its
// S2S callback names the account to pay:
//   LevelPlay.SetDynamicUserId / Init(appKey, userId: session.UserId)
// After the ad closes (onAdRewarded is NOT proof of payment), poll:
var shownAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 5_000;
for (var i = 0; i < 3; i++) {
  await UniTask.Delay(2_000);
  var r = await NakamaClient.Rpc("ad_reward_status", new { sinceUtc = shownAt });
  var paid = r.rewards.FirstOrDefault(x => x.status == "granted");
  if (paid != null) {
    ShowToast($"+{paid.coins} coins");
    UpdateDailyAdCounter(r.dailyCount, r.dailyCap);  // e.g. "3 / 10 today"
    break;
  }
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
| `ad_watched` | optional, per ad completion | report only, never pays |
| `ad_reward_status` | 2–3 polls, 2 s apart, after an ad closes | the network's callback pays a few seconds later |
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

## 23. Dedicated race servers (server-to-server)

These RPCs are called by the headless race servers (dedicated builds), **never by the game client**. They use the runtime `http_key` in the URL (no player session) and carry `serverKey` in the JSON body. `serverKey` must equal `RACE_SERVER_SECRET` of the server `.env` (`runtime.env`), compared in constant time. While the secret is empty every call is rejected. OpenAPI tag: `server-to-server`.

| Condition | `error.code` |
|---|---|
| `RACE_SERVER_SECRET` empty (`details.reason: NOT_CONFIGURED`) | `SERVICE_UNAVAILABLE` |
| wrong or missing `serverKey`, or a player session (`details.reason: BAD_SERVER_KEY`) | `FORBIDDEN` |
| invalid input | `BAD_REQUEST` |
| concurrent update (`details.reason: VERSION_CONFLICT`) | `CONFLICT` |

### 23.1 `rs_heartbeat`

Registers the server or refreshes its registry row (`race_servers/{serverId}`, system-owned, permissions 0/0). Send one every 3 s: a server is alive while `lastSeenMs` is at most 10 s old.

Request:

```json
{ "serverKey": "…", "serverId": "race-eu-1", "host": "203.0.113.7", "port": 7770,
  "capacity": 1, "activeSessionId": null, "buildVersion": "0.1.0" }
```

| Field | Rule |
|---|---|
| `serverId` | 1-64 characters of `[A-Za-z0-9._-]` |
| `host` | non-empty |
| `port` | integer 1-65535 |
| `capacity` | integer 1-16 (stored; each process declares 1) |
| `activeSessionId` | the session being served, or `null` |
| `buildVersion` | optional string, up to 64 characters |

Response `data`:

```json
{ "assignment": null }
```

Example with a pending assignment:

```json
{ "assignment": { "sessionId": "9f2c…", "mode": "quick", "trackId": "track_01", "laps": 3,
  "expectedUserIds": ["u1", "u2"], "joinDeadlineMs": 1761724830000, "joinRemainingMs": 27500,
  "botDifficulty": 2 } }
```

`assignment` is `null | { sessionId, mode, trackId, laps, expectedUserIds[], joinDeadlineMs, joinRemainingMs, botDifficulty? }`. It is the session the matchmaker reserved for this server while that session is still `created`: `expectedUserIds` are the human players of the roster and `joinDeadlineMs` is the session's creation time plus 30 s; joinRemainingMs is max(0, joinDeadlineMs - now) by the server clock (0 once the window has passed), so the race server does not need to compare joinDeadlineMs with its own clock. `botDifficulty` is an integer 0..4 (0 easiest, 4 hardest) for the bots the race server fills in. The matchmaker computes it when it creates the session, with the same rule as `quick_bots` (average ranked rating of the human players; a player without a ranked record is ignored, and when nobody has one the rating counts as 1000, difficulty 2). It is omitted for sessions created before the field existed. The same assignment is repeated on every heartbeat until the session starts.

Rules:

- If `activeSessionId` is `null` and the registry still holds a `sessionId` whose session is `closed` or no longer exists, the server is freed (`sessionId = null`).
- The service ticker frees the `sessionId` of any server without heartbeat for more than 30 s.


All the RPCs below take `serverId` (the id of the heartbeat) and `sessionId` (the session of the `assignment`) beside `serverKey`. A session that is not hosted by that server — a relay session, or one assigned to another server — is `FORBIDDEN` with `details.reason: NOT_ASSIGNED`.

### 23.2 `rs_join_validate`

A player connected to the race server and presented the `joinTicket` the client received in `race_session_get` (`myJoinTicket`, see `race_session_get`). The ticket must belong to a human of the roster of the session; it is compared in constant time and stays valid while the session is `created` or `started` (a reconnection uses it again).

Request: `{ "serverKey": "…", "serverId": "race-eu-1", "sessionId": "…", "joinTicket": "…" }`

Response `data`:

```json
{ "userId": "…", "displayName": "Ana", "classId": "D", "bodyId": "starter_viper" }
```

`displayName` is the account display name, else its username. `classId` and `bodyId` are the loadout the matchmaker fixed for the player.

| Condition | `error.code` | `details.reason` |
|---|---|---|
| session unknown, not hosted, or assigned to another server | `FORBIDDEN` | `NOT_ASSIGNED` |
| session `closing` or `closed` | `FORBIDDEN` | `BAD_STATE` |
| the ticket matches no human of the roster | `FORBIDDEN` | `BAD_TICKET` |
| `joinTicket` is not a string | `BAD_REQUEST` | |

### 23.3 `rs_session_start`

Moves the session `created → started` and stamps `startedAt` with the server clock. Idempotent: on a session already `started` it answers the same `startedAt`.

Request: `{ "serverKey": "…", "serverId": "…", "sessionId": "…" }` — Response `data`: `{ "startedAt": 1761340000000 }`. A closed session is `CONFLICT` (`details.reason: BAD_STATE`); an unknown one is `NOT_FOUND`.

### 23.4 `rs_submit_results`

The official results of the race. The race server is the authority: the call closes the session with confidence `server` (it feeds the time and wins leaderboards like `quorum`), pays the humans, and frees the server.

Request:

```json
{ "serverKey": "…", "serverId": "race-eu-1", "sessionId": "…", "requestId": "any-unique-id",
  "results": [
    { "userId": "…", "isBot": false, "displayName": "Ana", "totalMs": 150000, "laps": [50000, 50000, 50000], "dnf": false, "rank": 1 },
    { "userId": null, "isBot": true,  "displayName": "Bot 1", "totalMs": 152000, "laps": [51000, 50000, 51000], "dnf": false, "rank": 2, "estimated": false },
    { "userId": "…", "isBot": false, "displayName": "Bruno", "totalMs": 0, "laps": [], "dnf": true, "rank": 3 }
  ] }
```

Response `data`:

```json
{ "officialResults": [ { "rank": 1, "userId": "…", "isBot": false, "totalMs": 150000, "abandoned": false } ],
  "rewards": { "<userId>": { "coins": 120, "xp": 12, "gems": 0, "leveledUp": false, "newLevel": 1, "…": "same entries as race_submit_result" } } }
```

Rules:

- A finisher (`dnf: false`) has as many `laps` as the session (`laps` of the assignment) and `sum(laps) == totalMs`; otherwise `INVALID_RESULT` (`details.reason`: `LAP_COUNT_MISMATCH`, `LAP_SUM_MISMATCH`, `LAP_NOT_POSITIVE`).
- A human (`isBot: false`) must be a human of the roster, once (`INVALID_RESULT`: `NOT_IN_ROSTER`, `DUPLICATE_RESULT`). Humans that are not listed, or listed with `dnf: true`, are DNF (`abandoned: true`, `totalMs: 0`, no payout).
- Bots (`isBot: true`) only appear in `results`/`officialResults` and are never paid. Their `userId` may be `null`: the response then names them `bot_ds_{index}`. A bot may not use the id of a player (`BOT_ID_CLASH`).
- A human lap under the minimum of the car class on that track does not reject the results: the session closes with `flags.needsReview = true` and `reviewReason: lap_below_min`.
- Ranks: with the optional per-row `rank` (integer `1..rows`) the server's order rules and `officialResults` keep those ranks. `rank` goes on every row or on none (`INVALID_RESULT`: `RANK_INCOMPLETE`), never above the number of rows (`RANK_OUT_OF_RANGE`) and never repeated (`DUPLICATE_RANK`); a non-integer or non-positive `rank` is `BAD_REQUEST`. Humans that are not listed take the ranks after the last row. Without `rank`: finishers by `totalMs` (ties keep the sent order), then the DNFs.
- `estimated: true` (bot only, with `dnf: false`) marks a bot that had not finished: it needs no `laps` or `totalMs` check, enters `officialResults` with `totalMs: 0` and `abandoned: false`, and keeps its `rank`; without `rank` it goes after every timed finisher and before the DNFs, in the sent order. On a human it is `INVALID_RESULT` (`ESTIMATED_NOT_BOT`); with `dnf: true` it is `INVALID_RESULT` (`ESTIMATED_WITH_DNF`).
- Payout size: the reward row is chosen by the number of result rows (humans and bots), rounded up to the catalog key 2/4/6, so a human 3rd of 4 rows is paid from the `"4"` row even if only 2 humans were matched. The session keeps its matched `size`.
- The session must be `created` or `started`; a `created` one is started implicitly (`startedAt` = now) in the same close, so a failed `rs_session_start` does not lose the results. A closed one is `CONFLICT` (`details.reason: BAD_STATE`).
- Idempotent by `requestId` (1-128 characters): a retry returns the stored response and pays nothing more. Another `requestId` on an already closed session is `CONFLICT` (`BAD_STATE`).
- `rewards` has an entry only for the humans that were paid, with the entries of `race_submit_result`.

### 23.5 `rs_session_release`

The server cannot run the session (nobody joined in time, an error). A `created` or `started` session is closed as abandoned without payouts (every player DNF) and the server is freed.

Request: `{ "serverKey": "…", "serverId": "…", "sessionId": "…", "reason": "no_players" }` (`reason`: optional string, up to 256 characters, logged) — Response `data`: `{ "released": true }`.

Idempotent: a session that is already closed, or gone, only frees the server.

### 23.6 Client RPCs on a server-hosted session

On a session with `serverHosted: true` the players neither join, start, claim the host nor report: `race_session_join`, `race_session_start`, `race_host_claim` and `race_submit_result` answer `FORBIDDEN` with `details.reason: SERVER_HOSTED`. The client reads the outcome with `race_session_get` (`state: closed` and `results`); the payouts of the race arrive through the usual wallet and profile reads.

Closing a server-hosted session (results, release, the ticker or a lazy close) frees its server in the registry at once.
