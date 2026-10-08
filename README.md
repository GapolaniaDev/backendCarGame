# CarVideoGameBackend

Nakama 3.27 backend for the racing game. Implements the 9-phase plan in [`specs/`](./specs/).

**Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ · Phase 4 ✅ · Phase 5 ✅ · Phase 6 ✅**: race session lifecycle, leaderboard catalog + writer + read RPCs, profile module with after-auth auto-create, **economy + wallet + ledger, garage + cars + cosmetics + loadout, progression + XP, store with daily rotation + packs**, **matchmaking ticket params + matchmakerMatched hook + bot fill + host recovery + ranked seasons + rating math + abandon policy + lazy close + stats equalization**, **LiveOps config (no-cache) + maintenance gate + min client version + per-user inbox + account linking + account delete cascade + admin RPCs (shared-secret auth) + analytics events + region relay (nodeRole + HMAC relay_token)**, **missions (daily + weekly) + achievements + battle pass + XP economy (race XP via multiplier + mission/achievement XP via catalog) + lazy season close + per-grant XP ledger dedupe**. See [`docs/leaderboards.md`](./docs/leaderboards.md) for Phase 2, [`docs/economy.md`](./docs/economy.md) / [`docs/garage.md`](./docs/garage.md) / [`docs/store.md`](./docs/store.md) for Phase 3, [`docs/matchmaking.md`](./docs/matchmaking.md) / [`docs/ranked.md`](./docs/ranked.md) for Phase 4, [`docs/liveops.md`](./docs/liveops.md) / [`docs/account-linking.md`](./docs/account-linking.md) / [`docs/admin.md`](./docs/admin.md) for Phase 5, [`docs/missions.md`](./docs/missions.md) / [`docs/pass.md`](./docs/pass.md) for Phase 6.

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
│       ├── store/               # Phase 3: store catalog, daily rotation, store_get/buy RPCs
│       ├── matchmaking/         # Phase 4: mm_ticket_params, matchmakerMatched hook, quick_bots, host_choice, track_picker
│       ├── ranked/              # Phase 4: rating math, divisions, seasons, ranked_get, RaceCompleted → ranked subscriber
│       ├── liveops/             # Phase 4-5: liveops config (no-cache), abandon tracker, inbox messages
│       ├── account/             # Phase 5: account_link, account_link_resolve_conflict, account_delete cascade
│       ├── admin/               # Phase 5: admin RPCs (wallet_adjust, send_inbox, sanitize_session, remove_player, cleanup_race_sessions)
│       ├── region/              # Phase 5: nodeRole + relay_token HMAC sign/verify + beforeAuthenticateDevice relay gate
│       ├── core/admin/          # Phase 5: emit() helper for analytics_events + emitAdminAction wrapper
│       ├── missions/            # Phase 6: counter engine + subscriber + assignments + 3 RPCs + achievements
│       ├── pass/                # Phase 6: battle pass catalog + PassRecord + 4 RPCs + season close + XP engine + reward granter
│       └── catalogs/            # versioned JSON catalogs (tracks, modes, cars, upgrades, cosmetics, rewards, levels, store, seasons, ranked_config, liveops_config, missions_daily, missions_weekly, achievements, pass_s1)
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

---

## Phase 4 — matchmaking + ranked

Four new RPCs (`mm_ticket_params`, `race_session_quick_bots`,
`race_host_claim`, `ranked_get`), one matchmaker hook
(`registerMatchmakerMatched`), and the foundation for Elo-style ranked
play landed in Phase 4. Three new catalogs were loaded at boot:
`seasons`, `ranked_config`, and `liveops_config`. Twelve locked
decisions (D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12) drive
the contracts.

| Module | File | What it owns |
|---|---|---|
| `matchmaking/ticket_params.ts` | `validateTicketInput` / `buildTicket` / `buildOutput` | query + metadata for `nk.matchmakerAdd` (D1, D8, D9) |
| `matchmaking/matched_hook.ts` | `pickCandidate` / `buildRaceSessionFromCandidate` / `applyStatsEqualizationToMatchedSession` | validation + skeleton + stats clamp (D1, D12) |
| `matchmaking/rpcs.ts` | `mm_ticket_params` RPC | server-stamps version + region, returns the ticket the client sends to the matchmaker |
| `matchmaking/quick_bots.ts` | `pickBotDifficulty` / `pickBotCount` / `buildBotRoster` | bot fill formula (D3, D10) + roster shape (D4) |
| `matchmaking/host_choice.ts` | `pickHost` / `pickHostSuccession` | lowest rttMs host (D5) |
| `matchmaking/track_picker.ts` | `pickTrack` / `fnv1a` | deterministic track pick over catalog (D2) |
| `ranked/rating.ts` | `expectedScore` / `applyEloDelta` / `kFactorFor` | pure Elo math with per-human K-factor |
| `ranked/division.ts` | `divisionForRating` / `promotionBoundary` / `divisionAtBoundary` | tier helpers + boundary semantics |
| `ranked/seasons.ts` | `findActiveSeason` / `validateSeasons` | catalog loader + active-season resolution |
| `ranked/season.ts` | `lazyCloseSeason` / `daysLeftInSeason` | D7 lazy close + inbox reward distribution |
| `ranked/config.ts` | `loadRankedConfig` / `getRankedConfig` / `ratingWindowFor` | K-factor windows + division bands + grace |
| `ranked/ranked_repo.ts` | `createRankedRecord` / `readRankedRecord` / `updateRankedRecord` / `readSeasonMeta` | CAS-pattern storage helpers |
| `ranked/rpcs.ts` | `ranked_get` RPC | public cross-user read (D11), lazy close trigger, abandons surface |
| `ranked/subscriber.ts` | `subscribeRankedRewards` | RaceCompleted → rating update (idempotent, CAS-locked) |
| `liveops/mm_config.ts` | `loadLiveOpsConfig` / `getLiveOpsConfig` | read-once-at-boot with storage override |
| `liveops/abandon_tracker.ts` | `recordAbandon` / `getAbandonsLast24h` / `isBlocked` / `expireAbandons` | D6 rolling 24h window + 15-min block stamp |
| `race/stats_equalization.ts` | `loadoutStatsFor` / `computeEffectiveStats` | D12 stats clamp to class max for ranked |

### Phase 4 decisions locked

| ID | Decision | Where |
|---|---|---|
| D1 | `mm_ticket_params` server-stamps `version` + `region`; client cannot influence them | `matchmaking/rpcs.ts::resolveOptions` |
| D2 | Track picker deterministic (FNV-1a hash of `sessionId`); exclude last 2 tracks per player | `matchmaking/track_picker.ts` |
| D3 | Bot difficulty `clamp(round(avgRating/400)-1, 0, 4)` | `matchmaking/quick_bots.ts::pickBotDifficulty` |
| D4 | Bots share the host human's `classId` (consistent min-time band) | `matchmaking/quick_bots.ts::buildBotRoster` |
| D5 | Host = lowest `rttMs` human; ties broken by `userId` ASC; bots never host | `matchmaking/host_choice.ts` |
| D6 | 3 ranked abandons in 24h → 15-min matchmaking block | `liveops/abandon_tracker.ts` |
| D7 | Lazy close on `ranked_get`: distribute tier rewards, spin up next season, migrate records | `ranked/season.ts::lazyCloseSeason` |
| D8 | `mm.segmentBy` default `'none'`; liveops override at `liveops_config/current` | `liveops/mm_config.ts` |
| D9 | Rating band widens with time-since-last-rated (100→600) | `ranked/config.ts::ratingWindowFor` |
| D10 | `botCount = size - humanCount`; full lobby → 0 bots | `matchmaking/quick_bots.ts::pickBotCount` |
| D11 | Ranked record is publicly readable (perm 2); no `FORBIDDEN` cross-user path | `ranked/rpcs.ts` |
| D12 | Ranked sessions equalize every roster entry's `loadout.stats` to the car's class max | `race/stats_equalization.ts::loadoutStatsFor` |

### Phase 4 RPC quick reference

| RPC | Output shape | D-pattern |
|---|---|---|
| `mm_ticket_params` | `{ ticket: {query, metadata}, output: {mode, size, version, region, mm, constraints} }` | D1, D8, D9 — server-stamped |
| `race_session_quick_bots` | `{ sessionId, mode: 'quick_bots', trackId, size, host, startedAt, roster, botDifficulty, botCount }` | D3, D4, D5, D10 — instant-fill |
| `race_host_claim` | `{ sessionId, newHost, claimedAt }` | D5 — host succession on disconnect |
| `ranked_get` | `{ userId, seasonId, rating, peak, division, divisionProgress, racesPlayed, wins, topThree, rank, daysLeftInSeason, abandonsLast24h, blockedUntilUtc }` | D7, D11 — public cross-user, lazy close |

See [`docs/matchmaking.md`](./docs/matchmaking.md), [`docs/ranked.md`](./docs/ranked.md), and `docs/unity-api.md` §17 for the full per-RPC contract.

### Phase 4 tests

Phase 4 adds 32 e2e + many unit tests on top of the 378 from Phase 3
(688 total at the close of Phase 4). The most important e2e suites:

| Suite | Cases | Coverage |
|---|---|---|
| `tests/e2e/matchmaking_full.test.ts` | 15 | 6-client pool, mode/version/region mismatch, bot fill, host selection, server-stamped fields |
| `tests/e2e/ranked_full.test.ts` | 5 | Bronze defaults, stats equalization mixed-class, season roll, public read, rate limit |
| `tests/e2e/host_recovery.test.ts` | 7 | Happy path, succession, outsider, expired grace, idempotent re-claim, NOT_FOUND, BAD_REQUEST |
| `tests/e2e/abandon_block_full.test.ts` | 5 | 3-abandon block, expiry, bot filter, 24h rolling, per-user independence |
| `tests/e2e/race_session_quick_bots.test.ts` | 12 | Bot fill scenarios, track override, host invariants |
| `tests/e2e/race_host_claim.test.ts` | 9 | CAS race, rate limit, idempotency, outsider |
| `tests/e2e/ranked_session.test.ts` | 7 | Stats equalization across ranked rosters |
| `tests/e2e/ranked_get.test.ts` | 8 | Cross-user read, rate limit, season roll, storage perms |
| `tests/e2e/abandon_block.test.ts` | 7 | Direct storage seed → ranked_get exposure |
| `tests/unit/rating.test.ts` | 14 | Elo math, overflow, K-factor window |
| `tests/unit/division.test.ts` | 12 | Boundary semantics, top division, empty config |
| `tests/unit/season-config.test.ts` | 11 | Catalog validation, active season resolution |
| `tests/unit/track-picker.test.ts` | 9 | FNV-1a, empty intersection fallback, single-track |
| `tests/unit/host-choice.test.ts` | 9 | Lowest rtt, tie-breaker, empty input |
| `tests/unit/abandon_tracker.test.ts` | 16 | Pure filter, 3-abandon block, lazy GC, expired block, storage perms |
| `tests/unit/rating_subscriber.test.ts` | 12 | RaceCompleted → rating update, CAS race, mode gate, abandoned handling |

## Phase 5 — Operation & LiveOps

Phase 5 wraps the racing-game backend for production: remote feature
flags via LiveOps config, a per-platform min-version gate, a
maintenance flag with a careful exempt list, a per-user inbox, full
account linking (Apple / Google / email) with conflict resolution +
cascade deletion, five admin RPCs for ops, an analytics event stream
to storage + optional webhook, and a home/relay node split behind an
HMAC-signed relay token.

### Phase 5 RPCs (player-facing)

| RPC | Purpose | Gated? |
|---|---|---|
| `liveops_config_get` | splash-safe config fetch | no |
| `inbox_list` | splash-safe inbox badge | no |
| `inbox_claim` | claim an inbox reward | `liveopsGate` |
| `account_link` | attach Apple / Google / email identity | `liveopsGate` |
| `account_link_resolve_conflict` | resolve a 24h link conflict | `liveopsGate` |
| `account_delete` | GDPR right to erasure | no |
| `relay_token` | mint HMAC relay token (TTL 60min) | maintenance only (`skipForAdmin`) |

### Phase 5 RPCs (admin — `skipForAdmin`)

| RPC | Purpose |
|---|---|
| `admin_wallet_adjust` | grant / remove coins/gems for a user |
| `admin_send_inbox` | push inbox reward to N users |
| `admin_sanitize_session` | force-close a stuck race session |
| `admin_remove_player` | remove a player from a session |
| `admin_cleanup_race_sessions` | delete closed sessions older than N hours |

All admin RPCs require `body.adminKey === LiveopsConfig.adminRpcKey`
(also accepted via the `?http_key=$KEY` query for curl).

### Phase 5 maintenance gate

- **Gated** by `assertNotInMaintenance` or `liveopsGate`:
  `wallet_get`, `garage_get`, `car_buy`, `car_upgrade`, `cosmetic_equip`,
  `loadout_set`, `store_get`, `store_buy`, `lb_get`, `account_link`,
  `account_link_resolve_conflict`, `inbox_claim`, `profile_get`,
  `profile_update`, `race_session_create`, `race_session_join`,
  `race_session_start`, `race_session_quick_bots`, `race_host_claim`,
  `mm_ticket_params`, `ranked_get`.
- **NOT gated** (always callable): `liveops_config_get`, `inbox_list`,
  `account_delete` (GDPR > ops).
- **NOT gated + admin bypass**: `admin_*` and `relay_token` (clients
  need a relay URL even during maintenance splash; ops needs admin
  RPCs).

### Phase 5 decisions locked

| ID | Decision | Where |
|---|---|---|
| D1 | LiveOps config is no-cache; re-read storage on every call | `liveops/config.ts::loadLiveopsConfig` |
| D2 | Min client version enforced per platform (semver compare) | `core/liveops.ts::assertMinClientVersion` |
| D3 | `account_delete` bypasses maintenance (GDPR right to erasure) | `account/rpcs.ts::account_delete_impl` |
| D4 | 500-coin link bonus granted once per profile; gated by `accountLinkBonusClaimed` flag | `account/linking.ts::grantLinkBonus` |
| D5 | `inbox_claim` idempotent on `messageId`; reward lands on claim, not send | `liveops/inbox.ts::claimInboxMessage` |
| D6 | Inbox messages have 30-day retention; lazily GC'd on read | `liveops/inbox.ts::listInboxMessages` |
| D7 | Admin RPCs auth = `body.adminKey` matching `LiveopsConfig.adminRpcKey`; JS layer cannot see `http_key` query param | `admin/rpcs.ts` |
| D8 | Analytics destination = `analytics_events` storage + optional webhook; webhook best-effort, no retry | `core/admin/analytics.ts::emit` |
| D9 | `relay_token` TTL = 60min (`RELAY_TOKEN_TTL_SEC`) | `region/relay_token.ts` |
| D10 | Relay token = HMAC-SHA-256 over `<userId|region|expSec>` using `LiveopsConfig.relayTokenSecret` | `region/relay_token.ts::signRelayToken` |
| D11 | Home/relay split via `LiveopsConfig.nodeRole`; relay registers only `race_session_get` + `race_submit_result` | `main.ts::registerRpc` |
| D12 | Relay validates `vars.relayToken` in `beforeAuthenticateDevice`; offline HMAC verify | `region/before_auth.ts` |
| D13 | `MmPlatform` (`mobile`/`console`/`pc`) ≠ `ClientPlatform`; race/matchmaking RPCs use `assertNotInMaintenance` only | `matchmaking/rpcs.ts`, `race/rpcs.ts` |

### Phase 5 tests

Phase 5 adds 76 e2e + unit tests on top of the 688 from Phase 4 (864
total at the close of Phase 5 Chunk 9, then 873 at Chunk 10).

| Suite | Cases | Coverage |
|---|---|---|
| `tests/e2e/region_e2e.test.ts` | 9 | home/relay split, HMAC sign/verify, beforeAuthenticateDevice, maintenance skipForAdmin |
| `tests/e2e/liveops_full.test.ts` | 17 | every gated RPC returns SERVICE_UNAVAILABLE; liveops_config_get/inbox_list/account_delete/admin_*/relay_token stay OK |
| `tests/e2e/analytics_full.test.ts` | 5 | every emit() site fires; analytics_events storage rows |
| `tests/e2e/phase5-flow.test.ts` | 9 | full e2e: liveops_config_get → garage → wallet → account_link → inbox send/list → relay_token → account_delete |
| `tests/e2e/account_e2e.test.ts` | 11 | link bonus, conflict flow, delete cascade, GDPR bypass |
| `tests/e2e/inbox_e2e.test.ts` | 11 | send, list, claim, idempotency, retention |
| `tests/e2e/admin_e2e.test.ts` | 16 | 5 admin RPCs, FORBIDDEN, maintenance bypass, audit trail |
| `tests/e2e/maintenance_e2e.test.ts` | 8 | liveops_gate + min-version enforcement |
| `tests/unit/liveops_remaining_gates.test.ts` | 9 | static source-text checks that each RPC has the gate where expected |
| `tests/unit/analytics.test.ts` | 8 | emit() best-effort, webhook failure, schema |
| `tests/unit/region_token.test.ts` | 6 | HMAC sign/verify, expiry, tampered payload |
| `tests/unit/region_node_role.test.ts` | 4 | isHome/isRelay, default |

### Module additions

```
modules/src/
├── core/admin/          # emit() helper, emitAdminAction wrapper
├── region/              # nodeRole, relay_token sign/verify, beforeAuthenticateDevice
├── admin/               # admin RPCs (wallet, inbox, race)
└── account/             # account_link, account_link_resolve_conflict, account_delete cascade
```

See [`docs/liveops.md`](./docs/liveops.md),
[`docs/account-linking.md`](./docs/account-linking.md),
[`docs/admin.md`](./docs/admin.md), and `docs/unity-api.md` §18 for
the full per-RPC contract, validation, and curl examples.

## Phase 6 — Missions + Achievements + Battle Pass

Phase 6 ships the daily/weekly mission system, achievements with
attack vector progress, and a 40-level battle pass with race-driven
progression. The XP from races (with per-mode multipliers) plus the XP
declared on each mission / achievement reward flows into the pass
through `addPassXp` with `pass_xp_ledger`-backed dedupe on race
sessionIds. Three new catalogs load at boot
(`missions_daily`, `missions_weekly`, `achievements`, `pass_s1`).

| Module | File | What it owns |
|---|---|---|
| `missions/counter.ts` | 7 counter kinds + filter predicates | Pure: `matchesEvent(event, def, userId) → boolean` |
| `missions/assignment.ts` | SHA-256 deterministic assignment | `ASSIGNMENT_SALT='cv-missions-assignment-v1'` |
| `missions/missions_repo.ts` | `ensureDailyMissions/ensureWeeklyMissions/claimDaily/claimWeekly/rerollDailyMission` | CAS-pattern (3 retries) |
| `missions/achievements_repo.ts` | `ensureAchievements/claimAchievement` | D13 lazy-create on first read |
| `missions/counter_repo.ts` | storage key helpers + first-win-of-day CAS | `first_win_today/{userId}` |
| `missions/progress_writer.ts` | CAS-write of daily/weekly/achievements rows | max 3 retries; never throws |
| `missions/reward_granter.ts` | wallet.grant + garage CAS | never throws; `skippedCosmetics` array |
| `missions/rpcs.ts` | `missions_get / mission_claim / mission_reroll` | rate-limited; maintenance-gated |
| `missions/achievements_rpcs.ts` | `achievements_get / achievement_claim` | rate-limited; maintenance-gated |
| `missions/subscriber.ts` | `subscribeMissionsProgress` + `handleRaceCompletedForMissions` | RaceCompleted → counter + lazy XP + CAS writes |
| `pass/catalog.ts` | `loadPassCatalog/getPassCatalog/findLevel/xpToLevel/xpToNextLevel` | Frozen at boot |
| `pass/pass_repo.ts` | `ensurePassRecord/readPassRecord/writePassUpdate/addPassXp/isXpLedgerApplied` | D9 ledger; D13 lazy-create |
| `pass/xp_engine.ts` | `raceXPFor/missionXPFor/achievementXPFor/passXPSourceForRace` | D7 + D8 single source |
| `pass/season.ts` | `maybeCloseSeason/settleClosedSeasonRewards` | D11 lazy close |
| `pass/reward_granter.ts` | `grantPassReward` | wallet + garage CAS; never throws |
| `pass/rpcs.ts` | `pass_get / pass_claim / pass_buy_premium / admin_grant_premium` | rate-limited; maintenance-gated except admin |

### Phase 6 decisions locked

| ID | Decision | Where |
|---|---|---|
| D1 | 3 daily + 3 weekly missions assigned per (user, day/week) | `missions/assignment.ts` |
| D2 | `wins_ranked` requires `event.mode === 'ranked'` AND `position === 1` | `missions/counter.ts::matchesEvent` |
| D3 | Bots filtered FIRST in `matchesEvent`; non-human never matches | `missions/counter.ts::findHumanResult` |
| D4 | 1 free reroll/day; 50 gems after (`PAID_REROLL_COST_GEMS`) | `missions/missions_repo.ts::rerollDailyMission` |
| D5 | `unlockLevel` defaults to 3 (locked for level-1 player); UI hint only | `catalogs/missions_daily.json`, `missions_weekly.json` |
| D6 | Counter returns `0` for unknown kind (never throws — defensive) | `missions/counter.ts::matchesEvent` |
| D7 | Race XP = `Math.floor(20 × multiplier)` (quick=20, ranked=25, private=5, time_trial=10) | `pass/xp_engine.ts::raceXPFor` |
| D8 | Mission/achievement XP = `reward.xp` from catalog (positive-integer only) | `pass/xp_engine.ts::missionXPFor/achievementXPFor` |
| D9 | `pass_xp_ledger/{userId}/{source}/{sessionId}` first-call-wins dedupe | `pass/pass_repo.ts::addPassXp` |
| D10 | CAS retries = 3 for claim / buy / add (matches Phase 6 standard) | `pass/rpcs.ts`, `missions/missions_repo.ts` |
| D11 | Lazy season close on first `pass_get` post-`endUtc`; marker in `season_close/{seasonId}` | `pass/season.ts::maybeCloseSeason` |
| D12 | Best-effort reward grant (cosmetic/car catalog-missing → log + skip; never throws) | `pass/reward_granter.ts::grantPassReward`, `missions/reward_granter.ts` |
| D13 | `PassRecord` + `AchievementsRecord` lazy-created on first read RPC | `pass/pass_repo.ts`, `missions/achievements_repo.ts` |

### Phase 6 RPC quick reference

| RPC | Output shape | D-pattern |
|---|---|---|
| `missions_get` | `{ daily, weekly, rerollsLeftToday, nowUtc }` | D1, D5 — assignment + locked UI hint |
| `mission_claim` | `{ missionId, reward, kind, xpGranted, passLevel, levelUps }` | D8 — wallet + pass XP |
| `mission_reroll` | `{ newMission, costGems, rerollsLeftToday }` | D4 — free first, paid after |
| `achievements_get` | `{ achievements[], nowUtc }` | D13 — lazy-create |
| `achievement_claim` | `{ achievementId, reward, granted, xpGranted, passLevel, levelUps }` | D8, D12 — wallet + pass XP |
| `pass_get` | `{ xp, currentLevel, nextLevel, levels[], premiumPurchased, ... }` | D11, D13 — lazy close + lazy create |
| `pass_claim` | `{ level, track, reward, granted, newXp, currentLevel, nextLevel }` | D10, D7 — CAS ≥ 3 |
| `pass_buy_premium` | `{ userId, seasonId, premiumPurchased, priceGems, newGemsBalance }` | D3 (compensating-refund precedent) — wallet + CAS |
| `admin_grant_premium` | `{ userId, seasonId, premiumPurchased, viaAdmin }` | shared-secret auth; bypass maintenance |

See [`docs/missions.md`](./docs/missions.md),
[`docs/pass.md`](./docs/pass.md), and `docs/unity-api.md` §19 for
the full per-RPC contract, validation, and curl examples.

### Phase 6 tests

Phase 6 adds 51 e2e + many unit tests on top of the 873 from
Phase 5 (~1226 total at the close of Phase 6 Chunk 7).

| Suite | Cases | Coverage |
|---|---|---|
| `tests/e2e/phase6_flow.test.ts` | 13 | full lifecycle (liveops → missions → race XP → claim → pass → premium buy → maintenance gate → wire-up) |
| `tests/e2e/missions_get.test.ts` | 6 | assignment determinism, locked missions, rate limit |
| `tests/e2e/mission_progress.test.ts` | 10 | subscriber → progress, completed flag, CAS |
| `tests/e2e/mission_reroll.test.ts` | 5 | free path, paid path, insufficient funds, guard |
| `tests/e2e/mission_xp_grant.test.ts` | 3 | claim routes reward.xp → pass XP, no-XP=0, CONFLICT |
| `tests/e2e/achievements_get.test.ts` | 6 | lazy-create, locked, completed, claimed |
| `tests/e2e/achievement_claim.test.ts` | 4 | reward granter, NOT_FOUND on missing |
| `tests/e2e/achievement_xp_grant.test.ts` | 4 | claim routes reward.xp → pass XP, multi-stack |
| `tests/e2e/achievement_progress.test.ts` | 6 | subscriber → progress |
| `tests/e2e/race_xp_grant.test.ts` | 6 | per-mode XP multipliers, abandoned=0 |
| `tests/e2e/race_xp_idempotency.test.ts` | 3 | sessionId dedupe, cross-user independent |
| `tests/e2e/pass_get.test.ts` | 7 | lazy-create, premium xp/levels, season close |
| `tests/e2e/pass_claim.test.ts` | 6 | free + premium, FORBIDDEN, CONFLICT |
| `tests/e2e/pass_buy_premium.test.ts` | 5 | INSUFFICIENT_FUNDS, idempotent, CAS |
| `tests/e2e/admin_grant_premium.test.ts` | 7 | shared-secret, FORBIDDEN, idempotent, maintenance bypass |
| `tests/unit/xp_engine.test.ts` | 17 | race + mission/achievement XP math |
| `tests/unit/pass_xp_idempotency.test.ts` | 8 | ledger replay / IS same / IS different |
| `tests/unit/pass_repo.test.ts` | 15 | ensurePassRecord, addPassXp return shape |
| `tests/unit/pass_season.test.ts` | 9 | lazy close, marker idempotency, per-user settle |
| `tests/unit/pass_reward_granter.test.ts` | 7 | wallet grant, cosmetic CAS, never throws |
| `tests/unit/mission_catalog.test.ts` | 4 | catalog validation, filters |
| `tests/unit/assignment.test.ts` | 6 | SHA-256 determinism, salt changes |
| `tests/unit/counter.test.ts` | 12 | 7 kinds × filter predicates |
| `tests/unit/counter_repo.test.ts` | 8 | first_win_today CAS, dedupe |
| `tests/unit/achievements_repo.test.ts` | 6 | lazy-create, claim |
| `tests/unit/progress_writer.test.ts` | 5 | CAS retry, exhaustion |
| `tests/unit/pass_catalog.test.ts` | 5 | validation, freeze, findLevel |
| `tests/unit/event_bridge.test.ts` | 4 | firstWinOfDayFor stamp |

---

## Phase 6 status

| Chunk | Status | Description |
|---|---|---|
| Chunk 1 | ✅ `688dd80` | catalogs + types + boot (4 JSON + 2 type files + loaders + time.ts) |
| Chunk 2 | ✅ `8b75220` | counter engine (pure, 7 kinds × filter predicates) |
| Chunk 3 | ✅ `9a527b2` | `missions_get / mission_claim / mission_reroll` (3 RPCs) |
| Chunk 4 | ✅ `79623e4` | `RaceCompleted` → missions + achievements subscriber |
| Chunk 5 | ✅ `0911aac` | `achievements_get / achievement_claim` (2 RPCs) |
| Chunk 6 | ✅ `14510c8` | pass core (4 RPCs + lazy season close + reward granter) |
| Chunk 7 | ✅ `5a0a9f4` | XP engine (race + mission/achievement → pass XP) |
| Chunk 8 | ✅ (this) | wrap (e2e + docs + unity-api §19 + README) |
---

## Phase 7 — Social, Parties, Moderation

Phase 7 ships the cross-player surface: friend codes, invites, blocks,
clubs (with weekly leaderboards), chat (with multi-lang blocked words
+ leet-normalization), moderation (with auto-silence), and parties
(with matchmaker grouping). 26 RPCs + 1 fix across 9 chunks.

### Module table (Phase 7)

| Module | Source | RPCs | Hooks |
|---|---|---|---|
| Friend codes + recent rivals | `modules/src/social/{friend_code,friends_repo,recent_rivals}.ts` | 5 | `friend_added`, `friend_removed` |
| Invites + blocks | `modules/src/social/{invites,invites_repo,blocks_repo}.ts` | 6 | `invite_sent`, `invite_responded`, `block_added`, `block_removed` |
| Clubs CRUD + members + roles | `modules/src/clubs/{rpcs,roles,clubs_repo,week}.ts` | 9 | `club_*`, `club_week_rewarded` |
| Chat | `modules/src/chat/{rpcs,silenced,blocked_words,history}.ts` | 2 | `chat_sent`, `chat_silenced` |
| Moderation (player + admin) | `modules/src/moderation/{rpcs,reports_repo,silence}.ts` | 4 | `report_filed`, `chat_silenced` (auto) |
| Parties + matchmaker grouping | `modules/src/parties/{types,parties_repo,rpcs}.ts` + `modules/src/matchmaking/{matched_hook,ticket_params,rpcs}.ts` | 6 + 1 extension | `party_*` (5 events) |

### Phase 7 decision matrix

| # | Decision |
|---|---|
| D1 | Invite TTL = 24h |
| D2 | Self-invite → BAD_REQUEST |
| D3 | Either-side block → FORBIDDEN on invite + party_invite |
| D4 | Invite status transitions: `pending → accepted/declined/expired` (lazy) |
| D5 | Invite ID via `nk.uuidv4()` |
| D6 | Friend code 8 chars, 31-char alphabet, salted (`cv-friend-code-v1`) |
| D7 | Friend edges mutual (both sides stored as separate rows) |
| D8 | Per-reporter rate: 5 reports/hour |
| D9 | Auto-silence = 3 distinct reporters in 24h → 1h silence (max-of extension) |
| D10 | Reports anonymous to targets; only `admin_view_reports` exposes `reporterUserId` |
| D11 | `admin_unsilence` writes `untilUtc=0` (lazy clear, preserves audit) |
| D12 | Chat rate: 1 msg/sec + 20/min per user; 200 char cap; 7-day history TTL |
| D13 | Chat blocked words: multi-lang (es/en/pt) + leet-normalized; 3 reports in 24h → 1h chat-only silence |
| D14 | Storage-based parties (3.27 JS lacks `registerParty*` API) |
| D15 | `PARTY_MAX_SIZE = 6`, maxSize ∈ {2, 4, 6}, default 4 |
| D16 | Leader-only kick + invite; non-leader leave always OK; leader alone → disband |
| D17 | Party size honored in matchmaker grouping (rejects splits + partials) |
| D18 | `invite_respond(accept=true)` on `kind='group'` calls `joinParty`; errors do NOT undo the invite acceptance |

### Known Nakama 3.27 JS runtime gaps (4 documented)

1. **`nk.socketSend` missing** → online invite push always returns
   `delivered: 'offline'`. Clients poll `invite_list` for inbox.
2. **`registerBeforeAddGroupUsers` missing** → `checkClubJoinGate` is a
   pure helper called inside the runtime hook path. Not enforced at
   the runtime layer today.
3. **`registerLeaderboardReset` missing** → club weekly reset is lazy on
   the first `club_get`/`club_search` after Monday. A
   `clubs_week_reset` global marker prevents double-send across
   multi-club fan-out.
4. **`registerBeforeSendChannelMessage` missing** → `validateChatSend`
   is called synchronously from the `chat_send` RPC. Blocked-word +
   rate + silence checks fire before the chat_history write.

### Phase 7 status

| Chunk | Status | Commit | Description |
|---|---|---|---|
| Chunk 1 | ✅ | `165758b` | friend codes + recent rivals (5 RPCs) |
| Chunk 2 | ✅ | `b9190a0` | invites + blocks (6 RPCs + 2 hook stubs) |
| Chunk 3 | ✅ | `3b5b0a0` | clubs CRUD + catalog (3 RPCs) |
| Chunk 4 | ✅ | `b47270f` | club_update + members + roles (6 RPCs) |
| Chunk 5 | ✅ | `f5e3809` | club week leaderboard + weekly reward (0 RPCs + 2 subscribers) |
| Chunk 6 | ✅ | `acbe67b` | chat (2 RPCs + before_send + blocked_words + silenced) |
| Chunk 7 | ✅ | `4b19b5e` | moderation (4 RPCs + auto-silence + admin) |
| Chunk 8 | ✅ | `747e230` | parties + matchmaker partyId (5 RPCs) |
| Chunk 9 | ✅ (this) | wrap (party_join fix + phase7_flow + docs + unity-api §20 + README) |

---

## Phase 8 — Tournaments, Events, Anti-cheat, Admin Dashboard

Phase 8 ships four cross-cutting operator features: live competitive
tournaments, time-bounded live events, server-side anti-cheat with
human review, and an admin dashboard for live-ops.

### Module table

| Concern | File | Phase 8 Chunks |
|---|---|---|
| Tournament catalog (tournaments.json) | `modules/src/catalogs/tournaments.json` | 1 |
| Tournament types + state machine | `modules/src/tournaments/types.ts`, `catalog.ts` | 1, 6 |
| Tournament repo + entries + leaderboard | `modules/src/tournaments/{repo,leaderboard}.ts` | 1, 5, 6 |
| Tournament RPCs (list / get / join) | `modules/src/tournaments/rpcs.ts` | 5 |
| Tournament scanner + prize close | `modules/src/tournaments/scanner.ts` | 6 |
| Tournament admin RPCs (6) | `modules/src/tournaments/admin.ts` | 7 |
| Event catalog (events.json) | `modules/src/catalogs/events.json` | 1 |
| Active events runtime | `modules/src/core/active_events.ts` | 1, 8 |
| Event subscriber + event_list RPC | `modules/src/events/{subscriber,scanner}.ts` | 8 |
| Special-offer integration with store_get | `modules/src/store/` | 8 |
| Anti-cheat detection helpers (pure) | `modules/src/anti_cheat/detection.ts` | 2 |
| Anti-cheat marks aggregate + stats | `modules/src/anti_cheat/{marks,stats}.ts` | 3 |
| Anti-cheat subscriber | `modules/src/anti_cheat/subscriber.ts` | 4 |
| Anti-cheat admin RPCs (6) | `modules/src/anti_cheat/rpcs.ts` | 4 |
| Admin dashboard RPCs (6) | `modules/src/admin/{dashboard,cache,stats}.ts` | 9 |
| Admin auth + audit + cache | `modules/src/admin/{auth,index,cache}.ts` | 5, 9 |

### Phase 8 RPC quick reference (end-user)

| RPC | Caller | Description |
|---|---|---|
| `tournament_list` | any | Open + closing tournaments |
| `tournament_get` | any | Full detail (template + state) |
| `tournament_join` | any | Spend entry fee, create entry |
| `event_list` | any | Active + upcoming events with `isActive` flags |

### Phase 8 RPC quick reference (operator)

| RPC | Description |
|---|---|
| `admin_tournament_list` | List ALL instances (any state) |
| `admin_tournament_get` | Full detail + leaderboard + prizes |
| `admin_tournament_release_prizes` | Re-distribute prizes (idempotent) |
| `admin_tournament_void_refund` | Refund all entry fees |
| `admin_tournament_cancel` | Cancel without refund |
| `admin_tournament_extend` | Extend `endsAtUtc` |
| `admin_marks_list` | Filter anti-cheat marks (user/kind/severity/status) |
| `admin_partials_view` | Read partials for a user or race |
| `admin_marks_confirm` | Flip `confirmed: true` |
| `admin_marks_dismiss` | Flip `dismissed: true` (requires `reason`) |
| `admin_marks_sanction` | Apply / clear a temporary sanction |
| `admin_anti_cheat_stats_get` | Date-range stats (max 366d) |
| `admin_overview_get` | Dashboard overview (60s cache) |
| `admin_tournaments_stats_get` | Per-day tournament stats (zero-filled) |
| `admin_events_stats_get` | Per-day event activations + coinsGranted |
| `admin_players_search` | Case-insensitive player search (1..200) |
| `admin_wallet_grant` | Grant with whitelisted reasons + 100k cap |
| `admin_anti_cheat_dashboard_get` | Live anti-cheat snapshot (60s cache) |

### Phase 8 decisions locked (D19-D60)

- **D19-D23** (chunk 1): catalogs (6 tournaments + 12 events +
  mark_thresholds); `tracks.minSectionTimeMs` (1500-3000ms per track).
- **D24-D27** (chunk 2): anti-cheat detection helpers pure; 4
  server-only storage rows (marks / stats / sanctions / partials).
- **D28-D32** (chunk 3): marks aggregate + per-day stats +
  leaderboard_filter for human review.
- **D33-D35** (chunk 4): anti-cheat subscriber best-effort never-throws;
  quorum = `low-conf + position-gap ≥3`; `admin_marks_sanction.durationHours=0`
  clears the existing sanction.
- **D36-D40** (chunk 5): `TOURNAMENT_LOOKAHEAD_MS=7d`; state rule
  `closing=last 1h`; 1-join-per-user CONFLICT; `paidEntryFee` stored
  for void refund.
- **D41-D45** (chunk 6): tournament scanner 60s; top-100 leaderboard;
  first-write-wins `RosterEntry.tournamentId`; bundle-injected
  `setInterval` for the goja VM sandbox.
- **D46-D50** (chunk 7): void_refund = `wallet.grant(system→user)`;
  tournament_join rejects cancelled/voided (D47); use `BAD_REQUEST`
  not `INVALID_ARGUMENT` (D49); bundle boot materialises 2 catalog
  tournaments.
- **D51-D55** (chunk 8): bus event name is `RaceCompleted` (capital R);
  XP bonus paid as coins via `wallet.grant(reason='event')`; race-tied
  idempotency `event_xp:{raceId}:{userId}`; scanner 5min tick writes
  `profile.activeSpecialOffers` (cap 10); `store_get` decorates with
  `basePrice/finalPrice/activeSpecialOfferId?`.
- **D56-D60** (chunk 9): 60s in-memory TTL cache per admin RPC;
  manual mutations invalidate specific prefixes (D56); whitelisted
  `admin_wallet_grant` reasons (D57); 100k cap per call (D58);
  player search 1..200 (D59); `admin_anti_cheat_dashboard_get` is the
  live snapshot (D60).

### Phase 8 status

| Chunk | Status | Commit | Description |
|---|---|---|---|
| Chunk 1 | ✅ | `068a091` | catalogs (tournaments + events + thresholds) + types + boot |
| Chunk 2 | ✅ | `c137aee` | anti-cheat detection helpers (pure) |
| Chunk 3 | ✅ | `676914a` | marks aggregate + stats + leaderboard_filter |
| Chunk 4 | ✅ | `ad34211` | anti-cheat subscriber + 6 admin RPCs |
| Chunk 5 | ✅ | `857c119` | tournaments lazy creation + 3 RPCs (list/get/join) |
| Chunk 6 | ✅ | `da11482` | tournament subscriber + state machine + prize close |
| Chunk 7 | ✅ | `e610e58` | 6 admin tournament RPCs |
| Chunk 8 | ✅ | `8fd58cf` | events subscriber + event_list + scanner + store |
| Chunk 9 | ✅ | `9278cee` | 6 admin dashboard RPCs (overview/stats/search/grant) |
| Chunk 10 | ✅ (this) | wrap (5 mission_progress fixes + phase8-flow + docs + unity-api §21 + README) |

### Phase 8 documentation

- [`docs/tournaments.md`](docs/tournaments.md) — lifecycle, catalog, RPCs, gotchas.
- [`docs/events.md`](docs/events.md) — kinds, subscriber, store discount, scanner.
- [`docs/anti-cheat.md`](docs/anti-cheat.md) — detection, storage, review RPCs, gotchas.
- [`docs/admin.md`](docs/admin.md) §10-12 — Phase 8 admin RPCs (chunks 4, 7, 9).
- [`docs/unity-api.md`](docs/unity-api.md) §21 — client integration recipe.
