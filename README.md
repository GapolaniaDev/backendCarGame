# CarVideoGameBackend

Nakama 3.27 backend for the racing game. Implements the 9-phase plan in [`specs/`](./specs/).

**Phase 1 in progress**: race session creation, joins, start, result reporting, quorum, close-on-all-reported, and `RaceCompleted` event emission. Everything else (economy, matchmaking, ranked, leaderboards rebuild, social, tournaments, missions, pass, real-money IAP) is out of scope for this phase.

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
│       └── catalogs/            # versioned JSON catalogs (tracks, modes)
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

- `RaceCompleted` — published on the `EventBus` exactly once per session (CAS-guarded). Default subscriber in `main.ts` logs the event with sid/mode/track/size/results count/needsReview. Future phases will register leaderboard, economy, and analytics subscribers.

## Future work

- Phases 2–9 per `specs/Checklist de desarrollo por fases — Juego de carreras con Nakama.pdf`
- Authoritative match relay rewrite (currently relay-pure per Phase 1)
- `CLOSE_GRACE_MS` timer so non-reporting humans are marked `abandoned` automatically (currently close fires only when `allSubmitted`)
- Analytics event emission from server (Phase 5)

See [`/Users/gustavo/.claude/plans/graceful-mapping-clarke.md`](file:///Users/gustavo/.claude/plans/graceful-mapping-clarke.md) for the full Phase 1 implementation plan, and [`docs/race-protocol-ops.md`](./docs/race-protocol-ops.md) for the operational protocol codes the client uses.