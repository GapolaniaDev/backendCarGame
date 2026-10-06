# Ranked

Phase 4 server-side ranked mode: Elo-style rating, divisions, seasons,
abandon policy, and the `ranked_get` RPC. The matchmaker ticket
contract lives in [`docs/matchmaking.md`](./matchmaking.md); this doc
covers everything that happens AFTER a ranked race is matched and
closed.

---

## Locked decisions

| ID | Decision | Where enforced |
|---|---|---|
| D6 | 3 ranked abandons in 24h → 15-min matchmaking block (configurable) | `liveops/abandon_tracker.ts` |
| D7 | Lazy close on `ranked_get`: when the active season's `endsAt` is past, close it, distribute tier rewards via the inbox, spin up a new season, and migrate records | `ranked/season.ts::lazyCloseSeason` |
| D11 | Ranked record is publicly readable (owner-read perm 2) — anyone can call `ranked_get` for any user; no FORBIDDEN cross-user path | `ranked/rpcs.ts` |
| D12 | Stats equalization in ranked: every roster entry's `loadout.stats` clamped UP to the car's `maxStats` so skill determines outcome, not wallet | `race/stats_equalization.ts` |

---

## Storage

| Collection key | Owner | Perms | Schema version | Notes |
|---|---|---|---|---|
| `ranked/{userId}` | `userId` | 2/1 (public read, owner write) | 1 | Publicly readable. D11. |
| `ranked_seasons_meta/{seasonId}` | `SYSTEM_USER_ID` | 0/0 | 1 | Server-owned. One per season. |
| `ranked_{seasonId}` leaderboard | server | n/a | n/a | One per season; asc by rating. |
| `abandons/{userId}` | `userId` | 0/0 (server-managed) | 1 | Abandon counter + block stamp. D6. |
| `inbox/{rewardId}` | `userId` | 0/0 (server-managed) | 1 | Season rewards + future give-backs. |

The `RankedRecord` is migrated to the new season on lazy close:
`rating` carries over, `racesPlayed / wins / topThree` reset to 0,
`peak` resets to the carried rating.

---

## Rating formula (Elo with K-factor windows)

```
expectedScore = 1 / (1 + 10^((opponentRating - selfRating) / 400))
newRating    = selfRating + kFactor * (actualScore - expectedScore)
```

`actualScore` is `1` for first, `0.5/N` for each tied rank, `0` for
last (multi-player average). The K-factor is per-human:

- **First 10 ranked races** (`racesPlayed < 10`) → `kFactorInitial`
- **After 10 races** → `kFactorNormal`

The bundled `ranked_config.json` ships `kFactorInitial=40`,
`kFactorNormal=20`. The per-human kFactor is snapshotted from
`racesPlayed` at the start of the subscriber so a player crossing
the threshold mid-race uses the higher factor for that race.

### Rating window (D9)

The matchmaker uses a per-ticket `ratingBand` whose width depends on
how long since the player last finished a rated race:

| Time since last rated | Window |
|---|---|
| 0–30 s | ±100 |
| 30 s – 5 min | ±200 |
| 5 min – 30 min | ±400 |
| > 30 min | ±600 |

The bundled `ranked_config.json::ratingWindowBySeconds` is the source
of truth. The matchmaker applies equality on the `ratingBand` range;
tickets outside the band stay queued.

### Initial rating

`ranked_config.initialRating = 1000`. New accounts are stamped with
this on their first `ranked_get` call.

---

## Divisions

Five bands in the bundled catalog:

| Id | Display name | Range |
|---|---|---|
| `bronce` | Bronce | 0–999 |
| `plata` | Plata | 1000–1199 |
| `oro` | Oro | 1200–1399 |
| `platino` | Platino | 1400–1599 |
| `diamante` | Diamante | 1600+ |

> **Naming note:** The bundled config uses Spanish division ids
> (`bronce`, `plata`, `oro`, `platino`, `diamante`). These are the
> canonical ids on the wire; the client maps them to localized
> display names.

`divisionForRating(config, rating)` returns the band whose
`[minRating, maxRating]` contains the rating. Ratings below the
lowest band snap to the lowest band; ratings above the highest snap
to the highest.

`divisionProgress` is the position inside the band:
`(rating - band.minRating) / (band.maxRating - band.minRating)`,
clamped to `[0, 1]`. `0.0` is the bottom of the band; `1.0` is
one win from promotion.

---

## Seasons (D7)

The bundled `seasons.json` ships two seasons; `season_2` is the
active one (Oct 2025 → Dec 2028) and `season_3` is the rollover
target. The catalog is static across the close — the season's
declared `endsAt` documents the planned window, but the meta is what
drives the lazy close.

### Lazy close flow

Triggered on every `ranked_get` call:

1. Read `ranked_seasons_meta/{seasonId}`. If missing → no-op.
2. If `status === 'closed'` → no-op.
3. If `now < endsAt` → no-op.
4. Otherwise:
   a. Read final standings from `ranked_{seasonId}` leaderboard.
   b. Compute tier rewards via `computeSeasonRewards` (gold / silver
      / bronze tiers by final rank).
   c. Send every grant via `sendReward` to `inbox/{rewardId}`.
   d. CAS-update the meta to `{ status: 'closed',
      rewardsDistributed: true }`.
   e. Create the next season's meta with `nextSeasonId = season_N+1`,
      `startedAt = now`, `endsAt = now + DEFAULT_SEASON_LENGTH_MS`.

The CAS on step (d) makes the close safe under concurrent callers.
If the CAS fails, the next request will retry from step 1.

### Rewards tiers

| Tier | Ranks (1-indexed) | Grant |
|---|---|---|
| `season_gold` | 1 | 1000 coins + gold cosmetic |
| `season_silver` | 2–3 | 500 coins + silver cosmetic |
| `season_bronze` | 4–10 | 200 coins |

`computeSeasonRewards` reads the `ranked_{seasonId}` leaderboard
records and emits one grant per row in the tier. The cosmetics list
lives in `liveops_config.json` (admin-overridable).

### Migration

A player's record migrates lazily on the first `ranked_get` for the
new season:

- `rating` — carried over from the old record (or `initialRating`
  for new players)
- `peak` — reset to the carried rating
- `racesPlayed / wins / topThree` — reset to 0
- `recentAbandons` — reset to 0
- `lastRatedAt` — preserved
- `divisionId` — recomputed from the new rating via
  `divisionForRating`

---

## Abandon policy (D6)

The bundled `liveops_config.json` ships:

```json
{
  "matchmaking": {
    "abandonBlockThreshold": 3,
    "abandonBlockMinutes": 15,
    "graceSeconds": 20
  }
}
```

A ranked abandon is recorded by the `RaceCompleted` subscriber when
the human was in the roster but did NOT submit a result within the
grace window. Bots are filtered out — they cannot abandon. The
recording uses CAS on `abandons/{userId}.version`.

### Rolling window

- `getAbandonsLast24h(nk, userId, nowMs)` returns the count of
  entries with `0 <= nowMs - e.at <= MS_PER_DAY` (24h inclusive).
- Past-the-window entries are lazy-GC'd on every read.
- `filterFreshEntries` is the pure helper; `keep age===0` (a freshly
  stamped entry), drop `age<0` (future), drop `age>MS_PER_DAY`.

### Block stamp

When the rolling count crosses `abandonBlockThreshold` AND there's
no existing active block, `recordAbandon` stamps
`blockedUntilUtc = nowMs + abandonBlockMinutes * 60_000`. The block
is only restamped when the existing block has expired — a fourth
abandon WHILE blocked does NOT extend the block.

`isBlocked(nk, userId, nowMs)` returns the active block or `null` if
the block is expired (and lazy-GCs the expiry).

### `ranked_get` exposure

`RankedGetOutput` includes:

- `abandonsLast24h: number` — count of entries in the rolling window
- `blockedUntilUtc: number | null` — expiry or `null`

The client uses these to render a "you'll be blocked soon" banner
when `abandonsLast24h >= 2` and a "blocked until HH:MM" message
when `blockedUntilUtc !== null`.

### Matchmaking filter

The matchmaker itself doesn't yet reject blocked users (the runtime
doesn't expose a `matchmakerAdd` filter on storage state). The block
is enforced at the social layer — when the player tries to join a
queue, the client should check `ranked_get` first. The runtime
filter is a future task.

---

## `ranked_get` (D11, D7)

The only public ranked RPC. Returns the public ranked summary for
`targetUserId` (defaults to caller). Cross-user reads always allowed
— never `FORBIDDEN`.

### Input

```ts
{
  userId?: string;       // defaults to caller
  callerUserId: string;  // required on HTTP
}
```

### Output

```ts
{
  userId: string;
  seasonId: string;
  rating: number;
  peak: number;
  division: 'bronce' | 'plata' | 'oro' | 'platino' | 'diamante';
  divisionProgress: number;       // 0..1
  racesPlayed: number;
  wins: number;
  topThree: number;
  recentAbandons: number;          // informational, not the D6 counter
  rank: number | null;             // global rank in season, null if no record
  daysLeftInSeason: number;
  abandonsLast24h: number;         // D6
  blockedUntilUtc: number | null;  // D6
}
```

### Errors

| Code | When |
|---|---|
| `UNAUTHENTICATED` | no caller identity |
| `FORBIDDEN` | `callerUserId` mismatch on socket |
| `NOT_FOUND` | no active season in the catalog |
| `RATE_LIMITED` | 30 calls / 60 s per caller |
| `BAD_REQUEST` | malformed JSON |

### Storage record

`ranked/{userId}` is written with `permissionRead = 2` (public) and
`permissionWrite = 1` (owner only). Clients cannot forge
`__server_token__` server stamps on the leaderboard record (see §2 of
`docs/leaderboards.md`).

---

## End-to-end coverage

`tests/e2e/ranked_full.test.ts` drives 5 cases:

- 4 fresh humans on ranked → `ranked_get` returns bronze defaults
  for each (rating 1000, division plata, 0 races)
- Stats equalization: ranked session with mixed classes (D, C, B, A)
  has every roster entry's `loadout.stats` clamped to its class max
- Season roll: lazy-close fires, new season created, `racesPlayed=0`,
  `rating=1000` carried, old meta flipped to `closed` +
  `rewardsDistributed`, new meta `active`
- Public read: storage record is `permissionRead=2`
- Rate limit: 31 calls in a window → `RATE_LIMITED` on 31st

`tests/e2e/abandon_block_full.test.ts` drives 5 cases for the
abandon block lifecycle (3 abandons → blocked; expiry; bot filter;
24h rolling window; per-user independence). `tests/unit/rating.test.ts`,
`tests/unit/division.test.ts`, and `tests/unit/season-config.test.ts`
cover the pure helpers.
