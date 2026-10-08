# Tournaments — CarVideoGameBackend

Time-bounded competitive events. Players pay an entry fee (coins), submit
race times on a designated track within the tournament window, and the top
N finishers receive prize coins after the window closes.

**Phase**: 8 (Chunks 5, 6, 7)
**Source**: `modules/src/tournaments/`

---

## 1. Lifecycle

A tournament moves through three states:

| State | Meaning | When |
|---|---|---|
| `open` | Accepting joins + race submissions | Created → window start → `endsAtUtc - 1h` |
| `closing` | Last hour; no new joins, race submissions still accepted | Last 1h of window |
| `closed` | Prizes distributed (or voided / cancelled) | After `endsAtUtc`, scanner tick has run |

A tournament is `voided` (refund all entry fees, no prizes) or `cancelled`
(no prizes, no refund). Either flag forces `state === 'closed'` for admin
listings but tournament_join rejects both.

### State derivation (catalog vs persisted)

`state`/`cancelled`/`voided`/`closedAt` are OPTIONAL fields on a
`Tournament` instance. The state computation falls back to time-based
inference when absent:

```ts
function tournamentState(t: Tournament, nowUtc: number): 'open' | 'closing' | 'closed' {
  if (t.cancelled === true || t.voided === true) return 'closed';
  if (t.state !== undefined) return t.state;
  if (nowUtc < startsAtUtc) return 'open';
  if (nowUtc < endsAtUtc - 3_600_000) return 'open';
  if (nowUtc < endsAtUtc) return 'closing';
  return 'closed';
}
```

The chunk-5 lazy-create path persists instances without these fields;
the chunk-6 scanner writes them when it transitions `open → closing →
closed`.

---

## 2. Catalog

`tournaments` collection (system-owned), key = tournament instance id.
Bundled fixtures live in `modules/src/catalogs/tournaments.json` (6
template tournaments). At boot, the bundle materialises all instances
inside the `TOURNAMENT_LOOKAHEAD_MS` window (7 days by default), so
roughly 2 instances are alive on any given day.

Each template has: `id`, `trackId`, `entryFee`, `minLevel`, `maxAttempts`,
`prizeTable: [{rankMin, rankMax, coins}]`, `windowStart`, `windowEnd`
(the chunk-5 scanner uses `windowStart`/`windowEnd` for materialisation).

---

## 3. RPC inventory

| RPC | Caller | Maintenance | Description |
|---|---|---|---|
| `tournament_list` | any | enforced | list open + closing tournaments |
| `tournament_get` | any | enforced | get full detail (template + state) |
| `tournament_join` | any | enforced | spend entry fee, create entry |
| `admin_tournament_list` | admin | bypass | list ALL instances (any state) |
| `admin_tournament_get` | admin | bypass | full detail + leaderboard + prizes |
| `admin_tournament_release_prizes` | admin | bypass | re-distribute prizes (idempotent) |
| `admin_tournament_void_refund` | admin | bypass | refund all entry fees |
| `admin_tournament_cancel` | admin | bypass | cancel without refund |
| `admin_tournament_extend` | admin | bypass | extend `endsAtUtc` |

`assertNotInMaintenance` runs for the user-facing trio; the admin six
bypass it (precedent: `account_delete`).

---

## 4. `tournament_list` / `tournament_get`

```http
POST /v2/rpc/tournament_list
Authorization: Basic <session-token:b64>
Content-Type: application/json

{
  "callerUserId": "<uuid>",
  "status": "open" | "closing" | "all",
  "limit": 50
}
```

`status` is OPTIONAL (default `'open'`). Pagination via
`nk.storageList` cursor.

`admin_tournament_list` adds `{state, kind, limit, cursor}` and returns
expired / closed instances too (operator view).

---

## 5. `tournament_join`

```http
POST /v2/rpc/tournament_join
{
  "callerUserId": "<uuid>",
  "tournamentId": "<tid>"
}
```

**Side effects** (single RPC):

1. Spend `entryFee` coins (idempotency key `tournament_join:{tid}:{uid}`).
2. Write `tournament_entries/{tid}/{uid}` row with `paidEntryFee` (preserved
   for void refund).
3. Write an inbox message `tournament_joined`.

**Errors**:
- `FORBIDDEN` — cancelled or voided (D47).
- `CONFLICT` — user already joined (1-join-per-user; D40).
- `BAD_REQUEST` — `entryFee` insufficient or `minLevel` not met.
- `NOT_FOUND` — tournament id not in catalog or window expired.

---

## 6. Race → leaderboard

`tournaments/scanner.ts` runs a 60s `setInterval` tick. On every tick
the scanner:

1. Lists all tournament instances in the catalog window.
2. Computes state for each (transitions `open → closing → closed`).
3. For newly-closed tournaments, reads the leaderboard and distributes
   prizes via `distributePrizes(t, lb, now)` (top-N per `prizeTable`).
4. For each row, calls `grantTournamentPrize(nk, tid, row, now)`:
   - `wallet.grant(reason='tournament_prize', idempotencyKey='tournament_prize:{tid}:{uid}:{rank}')`
   - `inbox.sendReward(type='tournament_prize', idempotencyKey matches)`.

Players can submit races via the normal `race_submit_result` with an
optional `tournamentId` field. The race subscriber (chunk-6) updates
`bestTimeMs` and the leaderboard entry.

---

## 7. Admin operations

### `admin_tournament_release_prizes`

Re-runs the prize distribution path. Idempotent — the
`tournament_prize:{tid}:{uid}:{rank}` key prevents double-grants.

- `state === 'closed' && !force` → `CONFLICT` (re-distribute requires `force: true`).
- `state === 'open' || 'closing'` → succeeds with `distributed: 0` (no leaderboard yet).

### `admin_tournament_void_refund`

```http
POST /v2/rpc/admin_tournament_void_refund
{
  "adminKey":  "<from LiveopsConfig.adminRpcKey>",
  "tournamentId": "<tid>",
  "reason":    "match abandoned due to track bug"
}
```

For each entry: `wallet.grant(reason='admin', sourceId='tournament_void:{tid}:{uid}', idempotencyKey='tournament_void_refund:{tid}:{uid}')`.
Inbox message `tournament_voided` per player. CAS-update the tournament
row with `{voided: true, state: 'closed', closedAt: now}`.

- `state === 'closed' && voided` → `CONFLICT` (idempotent re-run is a no-op via idempotencyKey).
- `reason` empty → `BAD_REQUEST` (D49 — use BAD_REQUEST, NOT INVALID_ARGUMENT).
- `tournamentId` not found → `NOT_FOUND`.

### `admin_tournament_cancel`

Sets `cancelled: true, state: 'closed', closedAt: now`. No prizes, no
refund. Reject when already `closed && !cancelled && !voided`.

### `admin_tournament_extend`

CAS-update `endsAtUtc`. Reject when state is `closed`. Reject when
`newEndsAt < nowUtc` or `reason` empty.

---

## 8. Storage

| Collection | Owner | Schema |
|---|---|---|
| `tournaments` | system | `{schemaVersion, id, trackId, entryFee, minLevel, maxAttempts, prizeTable, windowStart, windowEnd, state?, cancelled?, voided?, closedAt?}` |
| `tournament_entries` | user | `{schemaVersion, tournamentId, userId, paidEntryFee, joinedAt, attempts}` |
| `tournament_leaderboard` | system (chunk-6) | `{schemaVersion, tournamentId, entries: [{userId, bestTimeMs, attempts}]}` |

`paidEntryFee` is the only field that survives a tournament's full
lifecycle; everything else can be derived from the catalog + the
leaderboard.

---

## 9. Gotchas

- **`INVALID_ARGUMENT` is NOT a valid `ErrorCode`** — use `BAD_REQUEST` (D49).
- **`void_refund` uses `wallet.grant` (system → user), not `spend`**. The
  refund flow credits coins; the original entry was a `spend` at join time.
- **Bundle boot materialises ~2 instances per day** (LOOKAHEAD=7d ÷ 6
  template slots). Tests that assert "0 tournaments" should target
  filters that exclude the bundled fixtures.
- **`storageList` 1-arg gotcha**: `nk.storageList({collection: 'tournament_entries'})`
  with NO userId filter walks ALL entries (across all tournaments).
  Always filter by `tournamentId` AFTER listing.
- **`setInterval` is not in the goja VM sandbox by default** — the bundle
  injects it via the post-build unwrapper. The chunk-6 scanner tests
  patched 3 e2e files to inject `setInterval` into the VM context
  before loading the bundle.
- **CAS retries**: `writeDailyMissionsCAS` (and friends) retry 3 times
  on version conflict before giving up. The scanner handles this silently.
