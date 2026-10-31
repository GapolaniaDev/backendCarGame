# Leaderboards — taxonomy, confidence rules, operations

> Phase 2 spec for the racing-game leaderboard tables, the writer pipeline that populates them from `RaceCompleted`, and the reader surface (`lb_get`). Source: `modules/src/leaderboards/*` and the catalog at `modules/src/catalogs/leaderboards.json`.

## TL;DR

137 tables, four groups (`wins_week`, `club_week`, `tt_*`, `lap_*`), plus one ranked rating table per season (`ranked_{seasonId}`, see `docs/ranked.md`). The server is the only writer. Clients read through `lb_get` (or Nakama's native `ListLeaderboardRecords`, which the Unity client uses for `wins_week`) and never write directly. Every server-written record carries a `__server_token__` metadata stamp, the session id of the race that produced it and the owner's account username.

## Table order (plan T-13)

The sort order and operator of every table come from `leaderboards.json`: `wins_week` and `ranked_{season}` (`seasonScoped.ranked`) are `desc`, the time and lap tables `asc`. `nk.leaderboardCreate` never changes an existing table, so at boot `ensureLeaderboards` reads every catalog table (and the active season's ranked table) with `leaderboardsGetId` and **deletes and creates again** any table whose order or operator differs. That drops its records (plan R-02, accepted: no real players yet) and logs at warn level:

```
leaderboard <id> recreated: found sortOrder=<n> operator=<op>, catalog wants <order>/<op>; its records are dropped (plan R-02)
```

Outside boot (the ranked subscriber creating a new season's table) a mismatch is only logged, never dropped.

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

### `club_week` — weekly club points

```
id:           club_week
operator:     incr
sortOrder:    desc
resetSchedule: 0 0 * * 1        # Monday 00:00 UTC
ownerKind:    club              # owner is the club id
```

Points from finished races: win 3, podium 2, finish 1 (no bots, no abandons). Read it with `lb_get` (see Read pipeline).

### `_weekly` time tables — `{track}_{class}_week`

```
tt_{track}_{class}_week
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
| tracks | `neon_blvd`, `reef_run`, `mountain_pass`, `canyon_drift`, `harbor_sprint`, `factory_loop`, `stadium_today`, `desert_circuit`, `arctic_circuit` | 9 |
| classes | `D`, `C`, `B`, `A`, `S` | 5 |
| patterns | `tt_all`, `tt_week`, `lap_all` (lap has no `_week` pattern) | 3 |

Tables: `1 (wins_week) + 1 (club_week) + 9 × 5 × 2 (tt_*_all, tt_*_week) + 9 × 5 (lap_*_all) = 137`.

`tt_*` tables only take time-trial runs; `lap_*` takes the best lap of any mode.

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
| `lap_*_all` | ✅ | ✅ | ✅ in every mode |
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

Source: `modules/src/leaderboards/lb_get.ts`. Single RPC, three views, one profile-enrichment pass. Order and `rank` are Nakama's, i.e. each table's own sort order (until plan T-13 the handler re-sorted every table ascending, so `wins_week` listed the fewest wins first).

```
global      → leaderboardRecordsList(limit, cursor)   → ownerRecord = aroundUserId's row
around_me   → leaderboardRecordsHaystack(limit)       → ownerRecord = aroundUserId's row
friends     → caller + friends_edge friends            → ownerRecord = aroundUserId's row
```

### View semantics in detail

| View | Selection | Cursor |
|---|---|---|
| `global` | the page in table order | Nakama's `nextCursor` / `prevCursor` |
| `around_me` | Nakama's haystack around `aroundUserId` (default the caller) | Nakama's; a cursor continues as a plain page |
| `around_me` (no record) | falls back to the top page — **NOT a 404**; the leaderboard exists, the user is just missing | as `global` |
| `friends` | the caller and every `friends_edge` friend that has a record, in table order, with their **global** ranks | offset cursor `friends:<n>` |

Input `cursor` (optional) is the `nextCursor` / `prevCursor` of a previous page of the same view; a malformed one is `BAD_REQUEST`. Output adds `nextCursor`, `prevCursor` (null at either end) and `records[].username`; `totalCount` is the number of ranked records in the whole table. A `ranked_{seasonId}` id is accepted; while that table does not exist the answer is an empty board.

**Club tables** (`club_week`, `ownerKind: club`): `global` and `around_me` only; `friends` → `BAD_REQUEST`. `around_me` centers on `aroundClubId` (default the caller's club). Each record's `username` is the club name; `clubs` maps the page's club ids and `ownerRecord` to `{clubId, name, emblemId, memberCount}`. `ownerRecord` is `null` without club points. A deleted club comes out as `username: ""` without a `clubs` entry. Player tables answer as before, plus `"ownerKind": "user"` and `"clubs": {}`.

### Clamping

- `limit` defaults to **20** and is clamped to `[1, 100]`. Out-of-range values return the default; `0`, `NaN`, negative → default 20.

### Profile enrichment

`lb_get` reads `profiles/{userId}` storage objects in a single batch (one `storageRead` per response). Missing profiles fall back to `{ userId, displayName: <username>, avatarUrl: null }` (the raw user id only when the account has no username). The fallback is intentional: `lb_get` works for users who haven't customized one yet.

### Usernames (HT-65)

Writers pass the owner's account username (`leaderboards/usernames.ts`, one `usersGetId` per race) on every `leaderboardRecordWrite`; before plan T-13 they passed `''`, which Nakama stores as NULL, so the native `ListLeaderboardRecords` showed no names. Records written before the fix get the name on their next write (Nakama keeps the stored name when it receives an empty one); `lb_get` fills them from the account meanwhile.

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
- [ ] Confirm 137 tables are registered on first boot (`tests/e2e/leaderboards-boot.test.ts` checks this).
- [ ] Confirm `__server_token__ === 'phase2'` is present on every record written post-Phase 2.
- [ ] Confirm `lb_get` `around_me` does not 404 when the caller has no record (it returns the leading slice).
- [ ] Confirm the `catalogs/profiles.json` blocked-words list is reviewed on each release (the catalog is shipped in the bundle, not hot-reloaded).
- [ ] Confirm `FakeInitializer.afterAuthenticates` is exercised in `profiles.test.ts` after-auth test before merging any change that touches the profile module.

## Future work

- **Tournaments** — Phase 6+ likely wants a per-tournament leaderboard (`t_{tournamentId}_time`, `incr desc`). The catalog expansion pattern (`pattern.template` × tracks × classes) extends naturally; add a top-level table entry alongside `wins_week`.
- **Anti-cheat** — the `__server_token__` marker is the server's stamp. The `beforeLeaderboardRecordWrite` hook is the place to add per-mode score sanity checks (currently unused; the writer-side validation in `race_submit_result` is the only guard).