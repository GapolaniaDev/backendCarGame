# Admin RPCs — CarVideoGameBackend

Five RPCs reserved for ops / support / live tuning. Each requires an
`adminKey` field in the body whose value matches the liveops config
`adminRpcKey`. The key is also accepted via the `?http_key=$KEY` query
parameter on the HTTP gateway (server-side defense in depth — see §1).

**Phase**: 5 (Chunks 6, 7)
**Source**: `modules/src/admin/`

---

## 1. Authentication — defense in depth

Three layers; the request passes when ANY of them succeeds.

1. **HTTP gateway query string** — `?http_key=$KEY`. The Nakama
   runtime injects the configured `runtime.http_key` (from
   `NAKAMA_RUNTIME_HTTP_KEY` in `.env`) as `http_key`. This is the
   path the curl examples below use.
2. **`body.adminKey`** — the JSON body contains `"adminKey": "..."`.
   The value MUST equal `LiveopsConfig.adminRpcKey`.
3. **`LiveopsConfig.adminRpcKey`** — the shared secret set via
   `liveops_config_override` (see `docs/liveops.md` §5).

If NONE of the three layers holds, the RPC returns
`FORBIDDEN: admin key required`. The `admin_*` RPCs **bypass
maintenance** (`assertNotInMaintenance(..., { skipForAdmin: true })`)
so wallet grants and inbox sends still work during a maintenance
window.

> **D7 (amended):** The JS runtime CANNOT see the `http_key` query
> parameter on inbound requests (the Go runtime consumes it before
> the JS handler runs). Therefore the canonical auth path is
> `body.adminKey`. The `http_key` query param still works for
> ad-hoc curl tests but the JS-side check is the source of truth.

---

## 2. RPC inventory

| RPC | Purpose | Maintenance bypass |
|---|---|---|
| `admin_wallet_adjust` | Grant or remove coins/gems for a single user | yes |
| `admin_send_inbox` | Push a reward inbox message to N user IDs | yes |
| `admin_sanitize_session` | Force-close a single race session, mark bots DNF | yes |
| `admin_remove_player` | Remove a player from a single race session | yes |
| `admin_cleanup_race_sessions` | Delete closed race sessions older than N hours | yes |
| `admin_tournament_list` (chunk 7) | List ALL tournament instances (any state) | yes |
| `admin_tournament_get` (chunk 7) | Get full tournament detail + leaderboard + prizes | yes |
| `admin_tournament_release_prizes` (chunk 7) | Re-distribute prizes (idempotent) | yes |
| `admin_tournament_void_refund` (chunk 7) | Refund all entry fees (cancel + pay back) | yes |
| `admin_tournament_cancel` (chunk 7) | Cancel without refund | yes |
| `admin_tournament_extend` (chunk 7) | Extend the tournament window | yes |
| `admin_marks_list` (chunk 4) | Filter anti-cheat marks (user/kind/severity/status) | yes |
| `admin_partials_view` (chunk 4) | Read partials for a user or race | yes |
| `admin_marks_confirm` (chunk 4) | Flip `confirmed: true` on a mark | yes |
| `admin_marks_dismiss` (chunk 4) | Flip `dismissed: true` (requires `reason`) | yes |
| `admin_marks_sanction` (chunk 4) | Apply / clear a temporary sanction | yes |
| `admin_anti_cheat_stats_get` (chunk 4) | Date-range stats (`startDate`/`endDate`, max 366d) | yes |
| `admin_overview_get` (chunk 9) | Dashboard overview (totals + uptime) | yes |
| `admin_tournaments_stats_get` (chunk 9) | Per-day tournament stats (zero-filled) | yes |
| `admin_events_stats_get` (chunk 9) | Per-day event activations + coinsGranted | yes |
| `admin_players_search` (chunk 9) | Case-insensitive player search (1..200 results) | yes |
| `admin_wallet_grant` (chunk 9) | Grant coins/gems with whitelisted reasons | yes |
| `admin_anti_cheat_dashboard_get` (chunk 9) | Live anti-cheat snapshot (60s cache) | yes |

Each call also writes an `admin_action` row to `analytics_events`
(via `emitAdminAction` in `core/admin/analytics.ts`).

---

## 3. `admin_wallet_adjust`

```http
POST /v2/rpc/admin_wallet_adjust?http_key=$HTTP_KEY
Authorization: Basic <server-key:b64>
Content-Type: application/json

{
  "adminKey":  "<from LiveopsConfig.adminRpcKey>",
  "userId":    "<uuid>",
  "coins":     1000,        // optional; sign-aware: + grants, - removes
  "gems":      25,          // optional
  "reason":    "support ticket #4823 — wrong deduction",
  "idempotencyKey": "<uuid>" // optional; protects against retry storms
}
```

**Output**:

```json
{
  "ok": true,
  "data": {
    "userId": "...",
    "oldBalance": { "coins": 100, "gems": 0 },
    "newBalance": { "coins": 1100, "gems": 25 },
    "idempotent": false
  }
}
```

**Errors**:

| Code | Cause |
|---|---|
| `FORBIDDEN` | admin key mismatch |
| `BAD_REQUEST` | neither `coins` nor `gems` provided, OR amount below floor / above ceiling |
| `INSUFFICIENT_FUNDS` | attempting to remove more than the player has (defensive) |
| `NOT_FOUND` | userId unknown |

---

## 4. `admin_send_inbox`

Push a structured inbox message to a list of users. Each call is
atomic — either every target receives it, or none do.

```json
{
  "adminKey": "<key>",
  "userIds":  ["uuid-1", "uuid-2", "uuid-3"],
  "message": {
    "kind":   "reward",
    "title":  "Welcome to Season 3",
    "body":   "Free 500 coins for the launch!",
    "reward": { "coins": 500 }
  },
  "idempotencyKey": "<uuid>"
}
```

**Output**: `{ delivered: N, skipped: M, idempotent: bool }`. Users
without an inbox message that exist are skipped (logged at warn).

The `message.reward` is granted on `inbox_claim`, not at send-time —
so cancelled deliveries don't leak rewards.

---

## 5. `admin_sanitize_session`

Force-close a single race session — useful when a session is stuck in
`pending` because one player never submitted.

```json
{
  "adminKey":   "<key>",
  "sessionId":  "<uuid>",
  "reason":     "stuck in pending for 30min"
}
```

**Output**: `{ sessionId, closedAt, results: [{userId, position, dnf}] }`.

Marks every unsubmitted roster entry as DNF, fires the
`race_completed` analytics event, grants no rewards, and writes the
session state. `RaceCompleted` subscribers see the synthesized
closure.

---

## 6. `admin_remove_player`

Remove a single player from a single session (without closing the
session — useful when a player accidentally joined the wrong game).

```json
{
  "adminKey": "<key>",
  "sessionId": "<uuid>",
  "userId":   "<uuid>",
  "reason":   "wrong lobby"
}
```

**Output**: `{ sessionId, userId, abandoned: boolean }`. The player is
marked abandoned so the close-time accounting treats them as DNF.

---

## 7. `admin_cleanup_race_sessions`

Delete closed race sessions older than `olderThanHours`. Default cap
per call: 1000 records.

```json
{
  "adminKey":       "<key>",
  "olderThanHours": 24,
  "limit":          500,
  "dryRun":         false
}
```

**Output**: `{ deleted: number, scanned: number, dryRun: bool }`.

`dryRun: true` scans but does not delete — useful for pre-flight
checks. The RPC enforces `limit <= 1000` to bound runtime.

---

## 8. Curl examples

Replace `$HTTP_KEY`, `$SERVER_KEY`, `$ADMIN_KEY`, and `<USER_ID>`
before running.

### Wallet grant (1000 coins)

```bash
HTTP_KEY=$(grep ^NAKAMA_RUNTIME_HTTP_KEY .env | cut -d= -f2)
SERVER_KEY=$(grep ^NAKAMA_SERVER_KEY .env | cut -d= -f2)
B64=$(printf "%s:" "$SERVER_KEY" | base64)

curl -s -X POST "http://localhost:8081/v2/rpc/admin_wallet_adjust?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"'"$ADMIN_KEY"'","userId":"<USER_ID>","coins":1000,"reason":"manual top-up"}'
```

### Inbox broadcast (5 users)

```bash
curl -s -X POST "http://localhost:8081/v2/rpc/admin_send_inbox?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"'"$ADMIN_KEY"'","userIds":["u1","u2","u3","u4","u5"],
       "message":{"kind":"reward","title":"Welcome","body":"free coins","reward":{"coins":100}}}'
```

### Close a stuck session

```bash
curl -s -X POST "http://localhost:8081/v2/rpc/admin_sanitize_session?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"'"$ADMIN_KEY"'","sessionId":"<SESSION_ID>","reason":"stuck"}'
```

### Cleanup old sessions (dry run)

```bash
curl -s -X POST "http://localhost:8081/v2/rpc/admin_cleanup_race_sessions?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"'"$ADMIN_KEY"'","olderThanHours":24,"dryRun":true,"limit":500}'
```

### Remove one player from one session

```bash
curl -s -X POST "http://localhost:8081/v2/rpc/admin_remove_player?http_key=$HTTP_KEY" \
  -H "Authorization: Basic $B64" \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"'"$ADMIN_KEY"'","sessionId":"<S>","userId":"<U>","reason":"wrong lobby"}'
```

---

## 9. Audit trail

Every successful admin RPC fires `emitAdminAction(nk, logger, rpcName,
props)`, which writes an `admin_action` row to `analytics_events`
with `props` containing `rpcName, userId, reason, ...`. The row is
public-read (permissionRead=2) so ops dashboards can chart it without
service tokens.

```ts
// Example row
{
  schemaVersion: 1,
  id: "<uuid>",
  ts: 1762512000000,
  name: "admin_action",
  props: {
    rpcName: "admin_wallet_adjust",
    userId: "<uuid>",
    coinsDelta: 1000,
    gemsDelta: 0,
    reason: "manual top-up"
  }
}
```

If `analyticsWebhook` is configured in liveops, a best-effort POST
is fired with the same payload. Webhook failures are logged at warn
and do NOT fail the admin RPC. See `docs/liveops.md` §6 for the
outbound contract.

---

## 10. Phase 8 — tournament admin RPCs (chunk 7)

Six RPCs for live-ops control over the tournament lifecycle. See
`docs/tournaments.md` for the full lifecycle. All six follow the
`assertAdminKey` + bypass-maintenance + `emitAdminAction` pattern.

```http
POST /v2/rpc/admin_tournament_release_prizes
{
  "adminKey":     "<admin>",
  "tournamentId": "<tid>",
  "force":        false   // optional; required to re-distribute on a closed tournament
}
```

Returns `{distributed, skipped, errors}`. Idempotency keys match the
scanner's (`tournament_prize:{tid}:{uid}:{rank}`), so re-runs are
no-ops on the wallet grant.

```http
POST /v2/rpc/admin_tournament_void_refund
{
  "adminKey":     "<admin>",
  "tournamentId": "<tid>",
  "reason":       "match abandoned"
}
```

Refunds every entry via `wallet.grant(reason='admin', sourceId='tournament_void:{tid}:{uid}')`.
Sends `tournament_voided` inbox message per user. Idempotency key
`tournament_void_refund:{tid}:{uid}` prevents double-refund.

Errors:
- `state === 'closed' && voided` → `CONFLICT` (idempotent re-run via key).
- `reason` empty → `BAD_REQUEST` (D49 — use `BAD_REQUEST`, **not** `INVALID_ARGUMENT`).
- `tournamentId` not found → `NOT_FOUND`.

`admin_tournament_cancel` is the same shape but performs no refund.
`admin_tournament_extend` CAS-updates `endsAtUtc`; reject when
`newEndsAt < nowUtc` or the tournament is already closed.

---

## 11. Phase 8 — anti-cheat admin RPCs (chunk 4)

Six RPCs for the review + action pipeline. See `docs/anti-cheat.md`
for the detection rules. Highlights:

- `admin_marks_list({userId?, kind?, severity?, status?, limit?, cursor?})` —
  paginated operator view of all marks (NOT scoped to one user).
- `admin_marks_confirm({userId, markId})` — flips `confirmed: true` and
  invalidates the dashboard cache. Idempotent.
- `admin_marks_dismiss({userId, markId, reason})` — requires a non-empty
  `reason` (free text, audit-friendly). Idempotent.
- `admin_marks_sanction({userId, durationHours, markIds?})` —
  `durationHours: 0` clears the existing sanction (D35).
- `admin_anti_cheat_stats_get({startDate, endDate})` — date-range, max
  366 days, zero-filled per day.

All six write `admin_action` analytics with `{userId, markId, reason}`.

---

## 12. Phase 8 — admin dashboard RPCs (chunk 9)

Six RPCs powering the operator dashboard. All use a 60s in-memory TTL
cache; manual mutations invalidate the relevant prefixes.

| RPC | Cache prefix | Invalidated by |
|---|---|---|
| `admin_overview_get` | `overview:` | `admin_marks_confirm/dismiss/sanction`, `admin_wallet_grant`, `admin_tournament_void_refund` |
| `admin_tournaments_stats_get` | `tournament_stats:` | `admin_tournament_release_prizes`, `admin_tournament_void_refund` |
| `admin_events_stats_get` | `events_stats:` | (none — events are read-only) |
| `admin_players_search` | `players_search:` | (none — search re-walks profiles) |
| `admin_wallet_grant` | (writes only) | invalidates `overview:` |
| `admin_anti_cheat_dashboard_get` | `anti_cheat_dashboard:` | `admin_marks_confirm/dismiss/sanction` |

`admin_wallet_grant` accepts only these `reason` values (D57):

| Reason | Use case |
|---|---|
| `admin_grant` | Manual top-up (customer support, promo) |
| `admin_compensation` | Lost-progress compensation |
| `admin_tournament_refund` | Tournament refund outside the void_refund RPC |
| `admin_event_compensation` | Event-failure compensation |
| `admin_other` | Catch-all (audit will catch typos) |

`coins` and `gems` are both capped at `WALLET_GRANT_MAX_PER_CALL` (100,000) per
call (D58). The cap prevents accidental fat-finger grants; multiple
calls are allowed when needed.

`admin_players_search` is in-memory (no index, cap 1000 reads per call;
D59). Sort: `createdAt` desc, then `userId` asc as tiebreaker. Limit
1..200 (default 20).

`admin_overview_get` returns `serverUptimeMs` = `Date.now() - oldest
analytics timestamp` (or `Date.now()` if no analytics rows exist yet).

---

## 13. Files

| Concern | File |
|---|---|
| Wire types + RPCs | `modules/src/admin/rpcs.ts` |
| Admin-only inbox path | `modules/src/admin/inbox_admin.ts` |
| Race cleanup | `modules/src/admin/race_admin.ts` |
| Audit emit | `modules/src/core/admin/analytics.ts` (`emitAdminAction`) |