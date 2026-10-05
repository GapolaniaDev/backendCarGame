# CarVideoGameBackend

Nakama 3.27 backend for the racing game. Implements the 9-phase plan in [`specs/`](./specs/).

**Phase 1 in progress**: race session creation, joins, start, result reporting, quorum, and `RaceCompleted` event emission. Everything else (economy, matchmaking, ranked, leaderboards rebuild, social, tournaments, missions, pass, real-money IAP) is out of scope for this phase.

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
│       ├── main.ts              # InitModule — wires core, registers RPCs
│       ├── core/                 # envelope, errors, logger, event bus, rate limit, idempotency, storage, catalog, time
│       ├── race/                 # race session RPCs + validation + ordering + state machine
│       └── catalogs/             # versioned JSON catalogs (tracks, modes)
├── tests/                        # Vitest unit + e2e tests
├── specs/                        # Phase plan + checklist PDFs (Spanish)
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

The compose entrypoint runs `nakama migrate up` and starts Nakama with `--runtime.js_entrypoint=index.js`. **Do not change the entrypoint** — the YAML key `runtime.javascript.entrypoint` is ignored in 3.27; only the CLI flag works.

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
| `FORBIDDEN` | caller is not host / not on roster |
| `NOT_FOUND` | sessionId absent in storage |
| `CONFLICT` | state transition not allowed (e.g. start when not `created`, join when full) |
| `RATE_LIMITED` | userId hit the per-RPC window |
| `INVALID_RESULT` | report failed step-2 plausibility (clock, min time, lap sum) |
| `INTERNAL` | uncaught; the envelope is still returned |
| `CATALOG_INVALID` | fatal at boot — Nakama exits non-zero |

## Phase 1 RPCs

| RPC | Inputs | Errors |
|---|---|---|
| `config_get` | `{}` | `INTERNAL` |
| `race_session_create` | `{ matchId, mode, trackId, size, hostLoadout }` | `BAD_REQUEST`, `CONFLICT`, `NOT_FOUND` |
| `race_session_join` | `{ sessionId, userId, loadout }` | `FORBIDDEN`, `NOT_FOUND`, `CONFLICT` |
| `race_session_start` | `{ sessionId }` | `FORBIDDEN`, `CONFLICT`, `NOT_FOUND` |
| `race_session_get` | `{ sessionId? }` (omit → caller's live session) | `NOT_FOUND` |
| `race_submit_result` | `{ sessionId, report }` | `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_RESULT` |

## Future work

- Phases 2–9 per `specs/Checklist de desarrollo por fases — Juego de carreras con Nakama.pdf`
- Authoritative match relay rewrite (currently relay-pure per Phase 1)
- Analytics event emission from server (Phase 5)

See [`/Users/gustavo/.claude/plans/graceful-mapping-clarke.md`](file:///Users/gustavo/.claude/plans/graceful-mapping-clarke.md) for the full Phase 1 implementation plan.