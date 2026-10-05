# Leaderboards — taxonomy, confidence rules, operations

> Phase 2 spec for the racing-game leaderboard tables, the writer pipeline that populates them from `RaceCompleted`, and the reader surface (`lb_get`). Source: `modules/src/leaderboards/*` and the catalog at `modules/src/catalogs/leaderboards.json`.

## TL;DR

91 tables, three classes (`wins_week`, `tt_*`, `lap_*`). The server is the only writer. Clients read through `lb_get` and never write directly. Every server-written record carries a `__server_token__` metadata stamp and the session id of the race that produced it.

## Taxonomy

### `wins_week` — weekly wins

```
id:           wins_week
operator:     incr
sortOrder:    desc
resetSchedule: 0 0 * * 1        # Monday 00:00 UTC
```

| Aspect | Value |
|---|---|
| Counter | number of wins |
| Modes that increment it | `quick`, `ranked` (no time_trial, no private, no bots) |
| Subject | the rank-1 finisher of each closed session |

### `_weekly` time / lap tables — `{track}_{class}_week`

```
tt_{track}_{class}_week
  operator: best, sortOrder: asc, resetSchedule: 0 0 * * 1
lap_{track}_{class}_week
  operator: best, sortOrder: asc, resetSchedule: 0 0 * * 1
```

These are the user-visible "this week on Track X in class Y" rankings. They reset every Monday and only carry the best score per user.

### `_all` time / lap tables — `{track}_{class}_all`

```
tt_{track}_{class}_all
  operator: best, sortOrder: asc, resetSchedule: ""
lap_{track}_{class}_all
  operator: best, sortOrder: asc, resetSchedule: ""
```

All-time best per (track, class). Never reset.

### Expansion shape

| Axis | Values | Count |
|---|---|---|
| tracks | `neon_blvd`, `reef_run`, `mountain_pass`, `canyon_drift`, `harbor_sprint`, `factory_loop` | 6 |
| classes | `D`, `C`, `B`, `A`, `S` | 5 |
| patterns | `tt_all`, `tt_week`, `lap_all` (lap has no `_week` pattern) | 3 |

Tables: `1 (wins_week) + 6 × 5 × 3 = 91`.

### Deprecated

`race_score` (the Phase 1 single-table thing) is marked deprecated in the catalog — clients no longer write to it. The historical rows are not migrated.

## Write pipeline

Source: `modules/src/leaderboards/subscriber.ts`. The pipeline is a single `EventBus` subscriber on `RaceCompleted`, registered in `main.ts` after `loadLeaderboardsCatalog` succeeds.

```
RaceCompleted
   ↓ (EventBus publish, fire-and-forget)
subscribeLeaderboardWriter(bus)
   ↓
applyRaceCompletedToLeaderboards(event)
   ↓
   ├─ for every human finisher:
   │     for each tt_/lap_ table matching the trackId + entry.classId:
   │        leaderboardRecordWrite(id, ownerId, score, subscore, metadata)
   │
   └─ for rank-1 finisher in QUICK_MODES ∪ RANKED_MODES:
         leaderboardRecordWrite('wins_week', ownerId, +1, …)
```

### Confidence rules

Confidence is computed by `computeQuorum(reports)` in `race/ordering.ts`:

| Rule | Result |
|---|---|
| `humanResults.length === 0` (all bots) | `'server'` |
| `!event.flags.needsReview` | `'quorum'` |
| otherwise (humans disagree or reports incomplete) | `'client'` |

### What gets written per confidence

| | `quorum` | `server` (all-bot) | `client` (review pending) |
|---|---|---|---|
| `tt_*_all` / `tt_*_week` | ✅ | ✅ | ✅ only when `mode === 'time_trial'` |
| `lap_*_all` | ✅ | ✅ | ✅ only when `mode === 'time_trial'` |
| `wins_week` | ✅ +1 for rank-1 in `quick`/`ranked` | ❌ (bots don't win) | ❌ |

`time_trial` mode bypasses the `client` gate because the soloist's run is self-evidenced — there's no second client to disagree with.

### Metadata stamp

Every server-written record carries:

```jsonc
{
  "__server_token__": "phase2",     // presence = server-wrote, client cannot forge
  "sessionId": "<uuid>",            // the closed race session
  "mode": "quick" | "ranked" | "private" | "time_trial",
  "confidence": "quorum" | "client" | "server",
  "isBot": false,                    // true if the entry was a bot (wins_week never set true)
  "car": "<bodyId>"                  // from the entry's loadout
}
```

Optional (when the client supplies them in the report):

```
"platform": "<ios|android|...>",
"control":  "<touch|gamepad|...>",
"clientVersion": "<semver>"
```

The `__server_token__` field is the only authoritative marker. Client writers that try to land a record without it are rejected at the leaderboard-runtime boundary.

### Idempotency

`leaderboardRecordWrite` with `operator: 'best'` is naturally idempotent — a worse score never replaces a better one. `wins_week` uses `incr` and accumulates; duplicate reports from the same session for the same player would double-count, so the writer checks `event.sessionId` is not already present on the record before incrementing (test: `leaderboards-subscriber.test.ts` → `stamps every record with the server token`).

## Read pipeline

Source: `modules/src/leaderboards/lb_get.ts`. Single RPC, three views, one profile-enrichment pass.

```
global      → sorted slice of [0, limit)         → ownerRecord = caller's own row
around_me   → band of limit/2 on each side       → ownerRecord = caller's own row
friends     → stub: just the caller              → ownerRecord = caller's own row
```

### View semantics in detail

| View | Selection | Owner record |
|---|---|---|
| `global` | top-N by `score asc, subscore asc` | caller's row in the full table (or `null`) |
| `around_me` | `slice(max(0, idx - limit/2), min(len, idx + limit/2))` around the caller's rank | caller's row |
| `around_me` (no record) | falls back to `slice(0, limit)` — **NOT a 404**; the leaderboard exists, the user is just missing | `null` |
| `friends` | stub: filter to the caller's row only | caller's row |

### Clamping

- `limit` defaults to **20** and is clamped to `[1, 100]`. Out-of-range values return the default; `0`, `NaN`, negative → default 20.

### Profile enrichment

`lb_get` reads `profiles/{userId}` storage objects in a single batch (one `storageRead` per response). Missing profiles fall back to `{ userId, displayName: userId, avatarUrl: null }`. The fallback is intentional: `lb_get` works for users who haven't customized one yet.

## Reset / clear path

`nk.leaderboardReset(id)` (exposed by the Go runtime, mirrored in `FakeNakamaCore`) clears every record on the named table. The leaderboard **definition** stays — only the records go. Callers are expected to:

1. Reset only the specific table they care about (`tt_neon_blvd_B_week`, not "all weekly tables").
2. Verify the table actually exists — `leaderboardReset` throws on an unknown id (same contract as the Go runtime).

Production resets are scheduled by Nakama's cron resolver on `resetSchedule`. Tests that need to simulate one call `env.nak.leaderboardReset('tt_neon_blvd_B_week')` directly.

Tests covering the reset behavior live in `tests/e2e/leaderboards-reset.test.ts`:

- The week table is cleared, the all-time table is intact.
- The leaderboard definition remains — a new race after the reset writes fresh records.
- Resetting an unknown id throws.
- Resetting one table does not affect sibling tables (e.g. `wins_week` is untouched when resetting `tt_*_week`).

## Catalog cache

`loadLeaderboardsCatalog(logger, raw, nk)` serializes the resolved table list to `nk.localcachePut(LEADERBOARD_CATALOG_CACHE_KEY, …, 7 * 24 * 60 * 60)`. Hot reads (`getLeaderboardTable`, `getTtAllTables`, …) consult localcache before re-walking the JSON. Tests clear via `_resetLeaderboardsForTests()`.

## Operations checklist

- [ ] Confirm `wins_week` reset schedule is `0 0 * * 1` (Monday 00:00 UTC) on production deploys.
- [ ] Confirm 91 tables are registered on first boot (`tests/e2e/leaderboards-boot.test.ts` checks this).
- [ ] Confirm `__server_token__ === 'phase2'` is present on every record written post-Phase 2.
- [ ] Confirm `lb_get` `around_me` does not 404 when the caller has no record (it returns the leading slice).
- [ ] Confirm the `catalogs/profiles.json` blocked-words list is reviewed on each release (the catalog is shipped in the bundle, not hot-reloaded).
- [ ] Confirm `FakeInitializer.afterAuthenticates` is exercised in `profiles.test.ts` after-auth test before merging any change that touches the profile module.

## Future work

- **Friends graph** — when the friends module lands, swap `friends` view from "just the caller" to a real `storageList(['follows/caller/{friendId}'])`.
- **Tournaments** — Phase 6+ likely wants a per-tournament leaderboard (`t_{tournamentId}_time`, `incr desc`). The catalog expansion pattern (`pattern.template` × tracks × classes) extends naturally; add a top-level table entry alongside `wins_week`.
- **Page tokens** — currently `limit` caps at 100 and clients page linearly. If a leaderboard grows past that we'll need a real cursor (Nakama's `cursor` field on `leaderboardRecordsList`).
- **Anti-cheat** — the `__server_token__` marker is the server's stamp. The `beforeLeaderboardRecordWrite` hook is the place to add per-mode score sanity checks (currently unused; the writer-side validation in `race_submit_result` is the only guard).