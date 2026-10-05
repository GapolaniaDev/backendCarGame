# Race protocol — operational codes

This document enumerates the wire-level codes the server uses for the race
protocol. It is the canonical reference for client and ops folks who need
to translate what the server returns into actionable behaviour.

> Source of truth: the TS types in [`modules/src/race/types.ts`](../modules/src/race/types.ts)
> and the error envelope in [`modules/src/core/errors.ts`](../modules/src/core/errors.ts).
> When they disagree, this document is wrong; fix it in a follow-up commit.

## 1. Response envelope

Every RPC returns a JSON-stringified envelope. Clients branch on `ok`:

```jsonc
// success
{ "ok": true, "data": { /* RPC-specific payload */ } }

// failure
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "only the host can start the session",
    "details": { /* optional, error-specific */ }
  }
}
```

Nakama's gRPC status is always `OK` — the domain-level error rides inside
the envelope. This is by design: v3.27's JS runtime does not let us set a
custom gRPC code.

## 2. Error code reference

| Code | When | HTTP-ish mapping |
|---|---|---|
| `BAD_REQUEST` | malformed payload, missing field, wrong type | 400 |
| `UNAUTHENTICATED` | no userId on the runtime context — should be unreachable behind Nakama | 401 |
| `FORBIDDEN` | caller is not host / not on roster / not the bot's host | 403 |
| `NOT_FOUND` | sessionId absent in storage, or caller not in roster | 404 |
| `CONFLICT` | state transition not allowed, duplicate report, race lost | 409 |
| `RATE_LIMITED` | userId hit the per-RPC window | 429 |
| `INVALID_RESULT` | report failed step-1 or step-2 plausibility | 422 |
| `INTERNAL` | uncaught; the envelope is still returned | 500 |
| `CATALOG_INVALID` | fatal at boot — Nakama exits non-zero | n/a |

## 3. `CONFLICT` reasons (`details.reason`)

When `code: CONFLICT`, the `details.reason` distinguishes the failure:

| `details.reason` | Triggered by | Recovery |
|---|---|---|
| `BAD_STATE` | `race_submit_result` against a session not in `started`/`closing`; `race_session_start` against a session not in `created`; `race_session_join` against a non-`created` session | re-fetch via `race_session_get` and decide |
| `ALREADY_REPORTED` | `race_submit_result` for a player whose roster entry already has `reportedAt` set | no recovery — server considers the submission done |
| `ROSTER_FULL` | `race_session_join` when the roster is at `session.size` | wait for the next session |
| `DUPLICATE_JOIN` | `race_session_join` when the caller is already on the roster | no-op |
| `MODE_SIZE_MISMATCH` | `race_session_create` when the size is not allowed for the chosen mode (e.g. `time_trial` only allows 1) | pick a different size or mode |

## 4. `INVALID_RESULT` reasons (`details.reason`)

When `code: INVALID_RESULT`, the `details.reason` distinguishes the
plausibility check that fired:

| `details.reason` | Step | Triggered by |
|---|---|---|
| `NOT_IN_ROSTER` | step-1 | `report.userId` is not a roster entry |
| `CLOCK_UNSET` | step-2 | session was never transitioned to `started` |
| `TIME_EXCEEDS_CLOCK` | step-2 | `report.totalMs` exceeds the elapsed wall clock by more than `CLOCK_SKEW_TOLERANCE_MS` (500 ms) |
| `BELOW_MIN_TIME` | step-2 | `report.totalMs` is less than `laps × track.minTimeMsByClass[classId]` |
| `LAP_COUNT_MISMATCH` | step-2 | `report.laps.length` does not match the track's expected lap count for the mode |
| `LAP_SUM_MISMATCH` | step-2 | `sum(report.laps) !== report.totalMs` |

## 5. `FORBIDDEN` triggers

- `race_session_start` — caller is not `session.host`
- `race_session_join` — `callerUserId` does not match `ctx.userId` (socket) or `userId` (HTTP gateway)
- `race_submit_result` — human report whose `callerUserId` does not match `report.userId`
- `race_submit_result` — `isBotReport=true` but caller is not `session.host`
- `race_session_get` — caller is not in the session roster (surfaced as `NOT_FOUND` to avoid leaking roster membership)

## 6. Race state machine

```
created ── start ──▶ started ── allSubmitted ──▶ closing ──▶ closed
                                                            │
                                                            └──▶ RaceCompleted fires once
```

The session moves to `closing` (then `closed`) inside the same atomic
write as the report that completes the roster. Concurrent submitters are
serialised by the CAS on `session.version`; only the winner closes, the
loser retries (or gets the cached response via idempotency).

## 7. Confidence / review flags

The `race_submit_result` response carries a `confidence` outcome and
matching `flags`:

| Confidence | Cause | `flags.needsReview` | `flags.reviewReason` |
|---|---|---|---|
| `quorum` | every roster human reported | `false` | absent |
| `server` | zero humans reported (pure bot race) | `false` | absent |
| `client` | not every roster human reported | `true` | `incomplete_reports` |

When `confidence=client`, the server has still persisted an
`officialResults[]` so the client can render provisional standings. The
client UI must surface a flag for the player to confirm or correct.

## 8. Storage layout (for ops)

All race-related objects live in the `race_sessions` collection,
owned by the system user (`00000000-0000-0000-0000-000000000000`)
with perms `0/0`:

| Key shape | Purpose | Owner |
|---|---|---|
| `race_sessions/{sid}` | session document (state, roster, results, flags, version) | system |
| `race_sessions/{sid}/reports/{userId}` | per-user submission (userId, totalMs, laps, isBotReport, schemaVersion) | the reporting user |
| `race_sessions/last_closed/{userId}` | index `→ { sessionId, closedAt }` for `race_session_get` without sessionId | system |

All writes use `nk.multiUpdate` for atomicity. Bumping `session.version`
is the optimistic-concurrency token; a CAS mismatch on any write rolls
back the whole `multiUpdate`.

## 10. Smoke-test commands

The HTTP gateway requires `Authorization: Basic base64(SERVER_KEY:)` and
the runtime `http_key` in the query string. RPC payloads are JSON
strings (not JSON objects):

```bash
# 1. get a real userId from /v2/account/authenticate/device
TOKEN=$(curl -s -X POST \
  "http://localhost:8081/v2/account/authenticate/device?http_key=$NAKAMA_RUNTIME_HTTP_KEY" \
  -H "Authorization: Basic $(printf '%s:' "$NAKAMA_SERVER_KEY" | base64)" \
  -H 'Content-Type: application/json' \
  -d '{"id":"smoke-test-device-id"}' | jq -r .token)
USER=$(printf '%s' "$TOKEN" | cut -d. -f2 | base64 -d | jq -r .uid)

# 2. fetch the config (catalogs + server time)
curl -s -X POST \
  "http://localhost:8081/v2/rpc/config_get?http_key=$NAKAMA_RUNTIME_HTTP_KEY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}'

# 3. create a session
curl -s -X POST \
  "http://localhost:8081/v2/rpc/race_session_create?http_key=$NAKAMA_RUNTIME_HTTP_KEY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(printf '{"matchId":"m1","mode":"time_trial","trackId":"neon_blvd","size":1,"hostLoadout":{"classId":"C","bodyId":"coupe"},"hostUserId":"%s"}' "$USER")"
```

Live demo scripts live in `scripts/` (e.g. `scripts/smoke-race.sh`).