# CarVideoGameBackend

Nakama 3.27 backend for the racing game. Implements the 9-phase plan in [`specs/`](./specs/).

**Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅**: race session lifecycle, leaderboard catalog + writer + read RPCs, profile module with after-auth auto-create, **economy + wallet + ledger, garage + cars + cosmetics + loadout, progression + XP, store with daily rotation + packs**. Next up is matchmaking + ranked (Phase 4). See [`docs/leaderboards.md`](./docs/leaderboards.md) for Phase 2, [`docs/economy.md`](./docs/economy.md) / [`docs/garage.md`](./docs/garage.md) / [`docs/store.md`](./docs/store.md) for Phase 3.

## Quick start (Docker)

Toda la stack corre en Docker — Postgres, Nakama, Prometheus y Grafana. El build del bundle JS de Nakama se hace con Node en el host porque `esbuild` no está en la imagen de Nakama. Una vez arriba, todo se reinicia con `docker compose`.

| Servicio | Puerto host | URL local | Notas |
|---|---|---|---|
| **Nakama API** (HTTP/gRPC) | `8081` | `http://localhost:8081` | gRPC + REST API gateway |
| **Nakama console** (admin) | `8090` | `http://localhost:8090` | UI de administración |
| **Prometheus** (métricas) | `9090` | `http://localhost:9090` | Scrape cada 15s; retención 30d |
| **Grafana** (dashboards) | `3000` | `http://localhost:3000` | Datasources auto-provisioned (Viewer anónimo) |
| **Postgres** (DB) | — | `172.28.0.2:5432` interno | Red `172.28.0.0/16` fija para IP routing del tunnel |

#### Prereqs en tu máquina:
- **Docker** ≥ 24 con `docker compose` v2
- **Node.js** ≥ 20 (solo para el build del bundle JS — no corre runtime)
- **git**

#### Setup desde cero:

```bash
# 1. Clonar
git clone https://github.com/GapolaniaDev/backendCarGame.git
cd backendCarGame

# 2. Configurar variables (copiar plantilla y editar)
cp .env.example .env
#   Completar: POSTGRES_PASSWORD, NAKAMA_SERVER_KEY, NAKAMA_GWP_SECRET,
#   NAKAMA_SESSION_ENCRYPTION_KEY, NAKAMA_SESSION_REFRESH_ENCRYPTION_KEY,
#   NAKAMA_RUNTIME_HTTP_KEY, NAKAMA_CONSOLE_PASSWORD, NAKAMA_CONSOLE_SIGNING_KEY,
#   GRAFANA_ADMIN_PASSWORD
#   Sugerencia: openssl rand -hex 32 para cada *_KEY

# 3. Instalar deps de Node y buildear el módulo JS que Nakama carga
npm install
npm run build
#   Esto produce modules/index.js (gitignored) que se monta en el container

# 5. Levantar la stack completa
docker compose up -d
#   Primera vez: tarda ~30s mientras Postgres inicializa + Nakama corre migrate up

# 6. Verificar
curl -sf http://localhost:8081/v2/console/account | jq . || echo "Nakama not ready yet, retry"
docker compose logs nakama | tail -20

# 7. Smoke test RPC
HTTP_KEY=$(grep ^NAKAMA_RUNTIME_HTTP_KEY .env | cut -d= -f2)
SERVER_KEY=$(grep ^NAKAMA_SERVER_KEY .env | cut -d= -f2)
B64=$(printf "%s:" "$SERVER_KEY" | base64)
curl -s -X POST "http://localhost:8081/v2/account/authenticate/device?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" -H 'Content-Type: application/json' \
  -d '{"id":"smoke-test"}' | jq .
```

#### Comandos comunes:

```bash
# Rebuild + restart Nakama tras editar modules/src/**
npm run build && docker compose up -d --force-recreate nakama

# Logs en vivo de un servicio
docker compose logs -f nakama
docker compose logs -f postgres

# Parar todo (mantiene volúmenes)
docker compose down

# Parar + borrar volúmenes (BORRAR DB — todo el progreso se pierde)
docker compose down -v

# Conectar a Postgres directamente
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB
```

#### Túnel a internet (opcional)

Si querés exponer la API fuera de tu red local para que un cliente externo (Unity build, otro dev) se conecte:

```bash
# Quick tunnel — URL random *.trycloudflare.com
docker compose --profile tunnel-quick up -d tunnel-quick

# Named tunnel — URL fija con tu dominio (configurar TUNNEL_TOKEN en .env primero)
docker compose --profile tunnel-named up -d tunnel-named
```

Ver `docker-compose.yml` para detalles del routing por IP estática (`172.28.0.10` para Nakama) — necesario porque Cloudflare tunnel no puede resolver docker service names, solo IPs.

## Stack

- **Runtime**: Nakama 3.27.0 (Docker image `heroiclabs/nakama:3.27.0`) running the **JavaScript runtime** (single bundled `index.js`, no Lua modules)
- **Language**: TypeScript (strict mode) bundled by **esbuild** to a single CJS file
- **Tests**: Vitest (unit + e2e harness that loads the compiled bundle with stubbed `nk`/`logger`/`initializer`)
- **Database**: Postgres 16 (managed by Nakama's own migrations)
- **Observability**: Prometheus scrapes Nakama's `--metrics.prometheus_port` endpoint; Grafana visualises

## Repository layout

```
.
├── docker-compose.yml           # Nakama + Postgres + Grafana + Prometheus + Cloudflare
├── modules/
│   ├── index.js                 # BUILT ARTIFACT (gitignored) — Nakama runtime entrypoint
│   └── src/                     # TypeScript source (the part that gets versioned)
│       ├── main.ts              # InitModule — wires core, registers RPCs, installs EventBus
│       ├── core/                # envelope, errors, logger, event bus, rate limit, idempotency, storage, catalog, time
│       ├── race/                # race session RPCs + validation + ordering + state machine + close path
│       ├── leaderboards/        # Phase 2: leaderboard catalog, writer, lb_get RPC
│       ├── profiles/             # Phase 3: profile module with after-auth auto-create
│       ├── economy/             # Phase 3: wallet (grant/spend/ledger), rewards, wallet_get RPC
│       ├── progression/         # Phase 3: XP + leveling + RaceCompleted XP subscriber
│       ├── garage/              # Phase 3: garage storage, car_buy/upgrade/equip/loadout RPCs
│       └── store/               # Phase 3: store catalog, daily rotation, store_get/buy RPCs
│       └── catalogs/            # versioned JSON catalogs (tracks, modes, cars, upgrades, cosmetics, rewards, levels, store)
├── tests/                       # Vitest unit + e2e tests
├── docs/                        # Operation docs (see docs/race-protocol-ops.md)
├── specs/                       # Phase plan + checklist PDFs (Spanish)
```

## Development

```bash
# Install dependencies (Node 20+ required)
npm install

# Build the Nakama runtime bundle (modules/src → modules/index.js)
npm run build

# TypeScript check (no emit)
npm run typecheck

# Run all tests
npm test

# Lint
npm run lint

# Lint + typecheck + test + build
npm run verify
```

## Running Nakama

```bash
docker compose up -d
```

The compose entrypoint runs `nakama migrate up` and starts Nakama with `--runtime.js_entrypoint=index.js`. **Do not change the entrypoint** — the YAML key `runtime.javascript.entrypoint` is ignored in 3.27; only the CLI flag works. After any change to `modules/src/**/*` run `npm run build` then `docker compose up -d --force-recreate nakama` so the runtime re-reads the entrypoint.

## RPC envelope

Every RPC returns a JSON-stringified envelope:

```ts
type Ok<T> = { ok: true;  data: T };
type Err    = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };
type Resp<T>= Ok<T> | Err;
```

Clients branch on `ok`. Nakama's gRPC status stays `OK`; domain error codes ride inside the envelope.

### Phase 1 error codes

| Code | When |
|---|---|
| `BAD_REQUEST` | malformed payload, missing field, wrong type |
| `UNAUTHENTICATED` | no userId on context (should be unreachable behind Nakama) |
| `FORBIDDEN` | caller is not host / not on roster / not the bot's host |
| `NOT_FOUND` | sessionId absent in storage |
| `CONFLICT` | state transition not allowed (e.g. start when not `created`, join when full, ALREADY_REPORTED) |
| `RATE_LIMITED` | userId hit the per-RPC window |
| `INVALID_RESULT` | report failed step-1 (NOT_IN_ROSTER) or step-2 plausibility (TIME_EXCEEDS_CLOCK / BELOW_MIN_TIME / LAP_COUNT_MISMATCH / LAP_SUM_MISMATCH / CLOCK_UNSET) |
| `INTERNAL` | uncaught; the envelope is still returned |
| `CATALOG_INVALID` | fatal at boot — Nakama exits non-zero |

## Phase 1 RPCs

| RPC | Inputs | Errors | Notes |
|---|---|---|---|
| `config_get` | `{}` | `INTERNAL` | returns serverTimeMs, catalogsHash, tracks, modes, minClientVersion |
| `race_session_create` | `{ matchId, mode, trackId, size, hostLoadout, hostUserId? }` | `BAD_REQUEST`, `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED` | hostUserId required only on HTTP (when ctx.userId is null) |
| `race_session_join` | `{ sessionId, userId, callerUserId, loadout }` | `BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED` | callerUserId must equal ctx.userId or the joiner; rejects double-join and started-state |
| `race_session_start` | `{ sessionId, callerUserId? }` | `FORBIDDEN`, `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED` | only host can start; only valid from `created` |
| `race_session_get` | `{ sessionId?, callerUserId? }` | `BAD_REQUEST`, `NOT_FOUND` | without sessionId returns the caller's last closed session (via `last_closed/{userId}` index); caller must be in the roster |
| `race_submit_result` | `{ sessionId, report, callerUserId }` | `BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_RESULT`, `RATE_LIMITED` | `report.userId` must match caller for human reports; `report.isBotReport=true` requires caller === session.host. Last submitted report closes the session and the response carries `officialResults` + final `confidence` |

### `race_submit_result` report payload

```ts
{
  userId: string;       // the player the report is for (host for bot reports)
  totalMs: number;      // aggregate finish time
  laps: number[];       // per-lap times; length === track.modes[mode]
  isBotReport: boolean; // true only when the host reports for a bot
}
```

### `race_submit_result` response

```ts
{
  accepted: true,
  confidence: 'quorum' | 'client' | 'server',  // final ordering confidence
  officialResults?: {              // present only when this submit closed the session
    rank: number;                 // 1-indexed
    userId: string;
    isBot: boolean;
    totalMs: number;              // 0 for abandoned
    abandoned: boolean;
  }[],
  flags: { needsReview: boolean; reviewReason?: string }
}
```

Confidence semantics:
- `'quorum'` — every roster human reported; no review needed
- `'server'` — zero humans reported (all-bot race); host's order is final
- `'client'` — incomplete reports; humans must resolve. `reviewReason='incomplete_reports'`

### Idempotency

`race_submit_result` caches its response in `nk.localcache` for 60 s keyed by `${sessionId}:${report.userId}`. Retries within the window return the cached envelope verbatim (including `officialResults` if the first call closed the session). After 60 s the cache expires and a retry is treated as a fresh call.

## In-process events

- `RaceCompleted` — published on the `EventBus` exactly once per session (CAS-guarded). Default subscriber in `main.ts` logs the event with sid/mode/track/size/results count/needsReview. Phase 2 also installs the **leaderboards** subscriber that writes time/best-lap/wins tables from the event; future phases register economy and analytics subscribers.

---

## Phase 2 — Leaderboards + Profiles

Phase 2 ships the leaderboard catalog, the `RaceCompleted` → leaderboard writer subscriber, the `lb_get` read RPC, the profile module (auto-create on auth + `profile_get`/`profile_update`), and the `removePlayerFromAll` helper for disconnect cleanup.

### Leaderboard catalog

91 tables total, generated from `modules/src/catalogs/leaderboards.json` at boot:

- `wins_week` — weekly wins counter (Monday 00:00 UTC reset), `incr desc`
- per (track × class × pattern): `tt_{track}_{class}_{all|week}` (race time, `best asc`) and `lap_{track}_{class}_all` (best lap, `best asc`)
- 6 tracks × 5 classes (D, C, B, A, S) × 3 patterns + 1 `wins_week` = 91

Tables are registered through `initializer.registerLeaderboardCreate(...)` at `InitModule`. The catalog is also cached in `nk.localcache` (7-day TTL) so hot reads avoid re-walking the JSON.

### `RaceCompleted` event enrichment (Phase 2)

The event now carries an additional `sessionId` (already present) and the subscriber stamps every leaderboard record with metadata:

```ts
{
  __server_token__: 'phase2',  // presence = server-wrote, client cannot forge
  sessionId: string,
  mode: RaceModeId,
  confidence: 'quorum' | 'client' | 'server',
  isBot: boolean,
  car: string,        // bodyId from the entry's loadout
  platform?: string,  // optional, from report metadata
  control?: string,   // optional
  clientVersion?: string
}
```

### Phase 2 RPCs

| RPC | Inputs | Errors | Notes |
|---|---|---|---|
| `lb_get` | `{ leaderboardId, view, limit?, aroundUserId?, callerUserId }` | `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND` | `view ∈ {global, around_me, friends}`. `limit` clamped to `[1,100]` (default 20). Profiles enriched in the same response. `friends` currently returns just the caller (graph stub). |
| `profile_get` | `{ callerUserId }` | `UNAUTHENTICATED`, `FORBIDDEN` | Reads the caller's profile; auto-creates a default (`displayName='Racer'`, `avatarUrl=null`) on first read. |
| `profile_update` | `{ displayName?, avatarUrl?, callerUserId }` | `BAD_REQUEST`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMITED` | CAS update via storage `version`. Validation against `catalogs/profiles.json`: displayName 2-20 chars, pattern `^[A-Za-z0-9 _\-.]+$`, blocked-words list; avatarUrl ≤ 512 chars. Rejects payload `userId` that doesn't match the caller (spoof defense). |

### `lb_get` response

```ts
{
  leaderboardId: string;
  view: 'global' | 'around_me' | 'friends';
  totalCount: number;
  records: Array<{
    ownerId: string;
    rank: number;          // 1-indexed within the full table
    score: number;
    subscore: number;
    metadata: Record<string, unknown>;
  }>;
  ownerRecord: { ownerId: string; rank: number; score: number; subscore: number; metadata: ... } | null;
  profiles: Record<userId, { userId: string; displayName: string; avatarUrl: string | null }>;
}
```

### `lb_get` view semantics

- **`global`** — top-N sorted ascending by score; `ownerRecord` is the caller's own entry (null if not on the table).
- **`around_me`** — band of `limit/2` records on each side of the caller; clamped to the array bounds. Falls back to top-N when the caller has no record.
- **`friends`** — stubbed to "just the caller" until the friends module lands.

### Confidence → leaderboard write rules

| Confidence | How it's derived | Time/best-lap writes | wins_week write |
|---|---|---|---|
| `quorum` | every human agreed on the order | ✅ written | ✅ +1 for rank-1 (quick/ranked only) |
| `server` | zero humans reported (all-bot race) | ✅ written | ❌ never (bots don't win) |
| `client` | humans disagree or some didn't report | ✅ written only for `time_trial` mode | ❌ pending review |

The `time_trial` mode is special-cased: even at `client` confidence, the time table is written because the soloist's run is self-evidenced.

### Profile module

- **Storage**: `profiles/{userId}` owned by `userId`, perms 0/0. CAS via `version`.
- **Auto-create**: registered on `registerAfterAuthenticateDevice/Custom/Email/Apple` — every new auth lands with a default profile. Failures log and never abort the auth.
- **Default profile**: `{ schemaVersion: 1, userId, displayName: 'Racer', avatarUrl: null, createdAt, updatedAt }`.
- **Validation catalog** (`modules/src/catalogs/profiles.json`): `displayName` 2–20 chars matching `^[A-Za-z0-9 _\-.]+$`; blocked-words list (case-insensitive whole-token match); `avatarUrl` ≤ 512 chars.
- **Spoof defense**: `profile_update` rejects any payload `userId` that differs from the authenticated caller.

### `removePlayerFromAll(userId)`

`modules/src/race/remove_player.ts` — utility for disconnect cleanup. Walks every persisted `race_sessions` object, marks the player's roster entry `abandoned: true` (so the close-time ordering sees them as DNF). Idempotent. Returns `{ abandonedFrom: string[], closedSessions: string[] }`. Currently only called from tests; the runtime disconnect hook lands in Phase 4.

## Future work

- Phase 3+ per `specs/Checklist de desarrollo por fases — Juego de carreras con Nakama.pdf`
- Authoritative match relay rewrite (currently relay-pure per Phase 1)
- `CLOSE_GRACE_MS` timer so non-reporting humans are marked `abandoned` automatically (currently close fires only when `allSubmitted`)
- Analytics event emission from server (Phase 5)
- Runtime disconnect hook that drives `removePlayerFromAll` (Phase 4)

See [`/Users/gustavo/.claude/plans/graceful-mapping-clarke.md`](file:///Users/gustavo/.claude/plans/graceful-mapping-clarke.md) for the full Phase 1 implementation plan, [`docs/leaderboards.md`](./docs/leaderboards.md) for the Phase 2 leaderboard spec, and [`docs/race-protocol-ops.md`](./docs/race-protocol-ops.md) for the operational protocol codes the client uses.

## Phase 3 — economy, garage, store

Eight new RPCs landed in Phase 3 (`wallet_get`, `garage_get`, `car_buy`, `car_upgrade`, `cosmetic_equip`, `loadout_set`, `store_get`, `store_buy`) plus the foundation work for the wallet, garage, and store subsystems. Three new catalogs were loaded at boot: `cars + upgrades + cosmetics`, `rewards + levels`, and `store`.

| Module | File | What it owns |
|---|---|---|
| `economy/wallet.ts` | `grant/spend/walletGet/applyLedger` helpers + ledger metadata packing | wallet idempotency (7-day TTL via `nk.localcachePut`) |
| `economy/rewards.ts` | position-aware reward computation per mode/size/rank/confidence | consumed by `RaceCompleted` subscriber |
| `economy/rpcs.ts` | `wallet_get` RPC | sub-ms wallet viewer for the header HUD |
| `economy/subscriber.ts` | `subscribeEconomyRewards` | wires wallet grants into the `RaceCompleted` event bus |
| `progression/leveling.ts` | XP + level computation | additive on top of `profile.progression` field |
| `progression/subscriber.ts` | `subscribeProgressionRewards` | wires XP grants into the `RaceCompleted` event bus |
| `garage/storage.ts` | `readGarage/writeGarageCreate/writeGarageUpdate/addCarToGarage/applyUpgrade/equipCosmetic/setActiveCar/addCosmeticToBag/markPackPurchased` | CAS-pattern helpers for the garage doc |
| `garage/stats.ts` | `computeStats + computeStatsRanked` | equalize-to-class-cap stat guarantees |
| `garage/rpcs.ts` | `garage_get/car_buy/car_upgrade/cosmetic_equip/loadout_set` | owner-only enforcement + D3 compensating refund |
| `garage/after_auth.ts` | `registerGarageAutoCreate` | seeds the starter `viper` garage on first auth (4 channels) |
| `store/rotation.ts` | `withDailyRotation` + `resolveDailyRotation` | FNV-1a daily rotation, deterministic per UTC day |
| `store/filter.ts` | `filterOffersForSection` + `ownershipFromGarage` | drops expired/level_low/already_owned offers |
| `store/packs.ts` | `PACK_TABLE` | 4 one-time entitlement packs |
| `store/rpcs.ts` | `store_get/store_buy` | D3 compensating refund, refund-on-pack-CAS-conflict |

### Phase 3 decisions locked

| ID | Decision | Where |
|---|---|---|
| D1 | Auto-create profile + garage on first auth | `profiles/after_auth.ts`, `garage/after_auth.ts` |
| D2 | `garage_get` returns the full garage in one call (no pagination) | `garage/rpcs.ts::garage_get` |
| D3 | Compensating-refund pattern for wallet + storage (Nakama JS runtime does NOT support wallet ops inside `multiUpdate`) | `economy/wallet.ts` + every mutation RPC |
| D4 | Cosmetic compatibility Strict — `cosmetic_equip` validates ownership + bag + slot + class | `garage/rpcs.ts::cosmetic_equip` |
| D5 | Loadout publicly readable (but only via future `player_get`; today `garage_get` enforces owner-only) | `garage/rpcs.ts::loadout_set` |
| D6 | XP grant per `RaceCompleted` finisher (capped at 50 per race) | `progression/subscriber.ts` |
| D7 | `RaceCompleted` event is NOT enriched with rewards — authoritative server-side grants only | `economy/subscriber.ts` |
| D8 | Wallet ledger metadata packed as compact `motivo:idOrigen[;k=v,...]` ≤ 200 bytes | `economy/wallet.ts::formatLedgerMetadata` |

### Phase 3 RPC quick reference

| RPC | Output shape | D-pattern |
|---|---|---|
| `wallet_get` | `{ coins, gems, pending, ledger }` | sub-ms, no storage reads |
| `garage_get` | `{ garage: GarageView }` | D2 — full garage |
| `car_buy` | `{ garage, newBalance }` | D3 compensating refund |
| `car_upgrade` | `{ garage, costPaid }` | D3 compensating refund |
| `cosmetic_equip` | `{ garage }` | D4 Strict validation |
| `store_get` | `{ dailySeed, sections }` | daily rotation + filters |
| `store_buy` | `{ delivery, newBalance }` | D3 + pack grant/reverse |
| `loadout_set` | `{ loadout }` | owner-only storage write |

See [`docs/economy.md`](./docs/economy.md), [`docs/garage.md`](./docs/garage.md), [`docs/store.md`](./docs/store.md), and `docs/unity-api.md` §16 for the full per-RPC contract.

### Tests

Phase 3 adds 90+ tests on top of the 288 from Phase 2 (378 total at
the close of Phase 3). The most important e2e suites:

| Suite | Cases | Coverage |
|---|---|---|
| `tests/e2e/garage.test.ts` | 7 | First-auth auto-create + garage_get round-trip |
| `tests/e2e/garage-mutations.test.ts` | 15 | car_buy / upgrade / equip / loadout_set |
| `tests/e2e/store.test.ts` | 14 | store_get filtering + store_buy success + every error |
| `tests/e2e/wallet.test.ts` | 7 | wallet_get round-trip + auth checks |
| `tests/e2e/phase3-flow.test.ts` | 2 | Full new-user lifecycle (auth → wallet → garage → store → upgrade) |
| `tests/e2e/refund-safety.test.ts` | 3 | Forced CAS failure → spend refunded via :refund |