# Battle Pass — server-side contract

The Battle Pass module is the per-player progression overlay on top of
the race/leaderboard/economy loop. Players earn pass XP from races
(quick / ranked / private / time_trial), from claiming missions, and
from claiming achievements; that XP unlocks levels on a 40-tier
catalogue where every level has a **free** reward (always available)
and a **premium** reward (gated by a one-time 800-gem purchase).

> Related: [`docs/missions.md`](./missions.md) (the source of mission/achievement XP), [`docs/economy.md`](./economy.md) (the wallet that receives pass-level rewards), [`docs/unity-api.md §19`](./unity-api.md#19-phase-6-rpcs--missions-achievements-battle-pass).

---

## 1. Catalog

The pass catalog is a JSON file loaded at boot:

- `modules/src/catalogs/pass_s1.json` — Season 1 (default; 40 levels, 800 gems premium).

Schema:

```ts
interface PassCatalog {
  version: 1;
  seasonId: string;          // e.g. 's1'
  startUtc: string;          // ISO timestamp (informational; lazy close uses endUtc)
  endUtc: string;            // ISO timestamp — after this, pass_get writes the global close marker
  maxLevel: number;          // must equal levels.length (40 today)
  levels: PassLevel[];
  premiumPriceGems: number; // 800
}

interface PassLevel {
  level: number;             // 1..maxLevel; monotonic with xpRequired
  xpRequired: number;        // cumulative XP to unlock this level
  freeReward: PassLevelReward;
  premiumReward: PassLevelReward;
}

interface PassLevelReward {
  coins?: number;
  gems?: number;
  cosmeticId?: string;       // optional — added to garage.cosmeticsBag
  carId?: string;            // optional — added to garage.cars
}
```

The XP curve is monotonic: `xpRequired[1] = 0` and
`xpRequired[n] > xpRequired[n-1]` for every n > 1. The default
catalogue uses **100 XP per level** past 1, so a player who finishes
~2 quick races per day (40 + 5 races) crosses ~5 levels per week.

### Idempotency invariants
- The catalog is frozen at boot; `loadPassCatalog` throws on invalid
  shapes (Phase 6 Chunk 1 contract).
- Per-player PassRecord is **lazy-created on first `pass_get`** — a
  player who has never opened the pass has no row in `pass` storage.
- The lazy-create works under the same `SERVER_OWNED_READ=1` /
  `SERVER_OWNED_WRITE=1` permission bits as the rest of the
  server-owned collections.

---

## 2. Storage

| Collection | Key | Owner | Perms | Schema version | Notes |
|---|---|---|---|---|---|
| `pass` | `userId` | `userId` | 1/1 | 1 | One per player. Lazy-created. Stores xp, claimed lists, premium flag, seasonClosed. |
| `pass_xp_ledger` | `${userId}/${source}/${dedupeId}` | `userId` | 1/1 | 1 | Per-grant dedupe marker. Source ∈ `PASS_XP_SOURCES`. |
| `season_close` | `passSeasonId` | `SYSTEM_USER_ID` | 1/1 | 1 | Global close marker for the pass season. |

`PassRecord`:

```ts
interface PassRecord {
  schemaVersion: 1;
  userId: string;
  seasonId: string;          // matches current catalog seasonId
  xp: number;                // cumulative pass XP (NOT profile XP)
  claimedFree: number[];     // levels where free reward has been claimed
  claimedPremium: number[];  // levels where premium reward has been claimed
  premiumPurchased: boolean; // one-way flag (never reverts)
  seasonClosed: boolean;     // flipped by lazy close on first pass_get past endUtc
}
```

The `pass_xp_ledger` row shape:

```ts
interface PassXpLedgerRow {
  schemaVersion: 1;
  userId: string;
  source: PassXPSource;       // 'race_quick' | 'race_ranked' | ... | 'achievement_claim'
  dedupeKey: string;          // opaque per-grant id (race sessionId, mission id, etc.)
  amount: number;
  ts: number;                 // server epoch-ms
}
```

---

## 3. XP sources

Every XP grant goes through `addPassXp(nk, logger, userId, delta, dedupeKey?)` which:

1. **Validates** `delta` is a non-negative integer; rejects otherwise.
2. **Idempotency check** (when `dedupeKey` is provided): if the
   `pass_xp_ledger/{userId}/{source}/{dedupeId}` row already exists,
   the function short-circuits and returns `{applied:false}`.
3. **Reads** the player's PassRecord (or lazy-creates it if absent).
4. **CAS-writes** the bumped XP (3 retries on conflict).
5. **Writes** the dedupe row when `dedupeKey` is provided.
6. **Returns** `{record, levelUps, newLevel, applied}`.

The `PASS_XP_SOURCES` table enumerates every source:

| Source | Multiplier (per race) | Dedupe key | Where |
|---|---|---|---|
| `race_quick` | × 1.0 | `sessionId` | `missions/subscriber.ts::RaceCompleted` |
| `race_ranked` | × 1.25 | `sessionId` | same |
| `race_private` | × 0.25 | `sessionId` | same |
| `race_time_trial` | × 0.5 | `sessionId` | same |
| `mission_claim` | n/a (catalog `reward.xp`) | none (claim itself is CAS-protected) | `missions/rpcs.ts::mission_claim` |
| `achievement_claim` | n/a (catalog `reward.xp`) | none | `missions/achievements_rpcs.ts::achievement_claim` |

Race XP math: `raceXPFor(mode) = Math.floor(RACE_XP_BASE * multiplier)`
with `RACE_XP_BASE = 20`:

| Mode | Multiplier | XP granted |
|---|---|---|
| `quick` | 1.0 | 20 |
| `ranked` | 1.25 | 25 |
| `private` | 0.25 | 5 |
| `time_trial` | 0.5 | 10 |

Mission/achievement XP = `reward.xp` from the catalogue (positive
integers only — fractional or non-integer values are rejected as 0).

`addPassXp` is **never** called from a path that doesn't already have
a write-capable context. The subscriber runs on the `RaceCompleted`
event bus; `mission_claim` and `achievement_claim` are RPC handlers
(also under the per-RPC rate limit). All three callers share the same
contract: `applied:false` is non-fatal — the caller's analytics emit
skips the XP row and the log carries a warn-level line.

---

## 4. XP idempotency

The same race can fire `RaceCompleted` twice (network retry, dup
event bus publish, replay). The `pass_xp_ledger` row prevents
double-granting:

```ts
// pass_xp_ledger/${userId}/race_quick/${sessionId}
```

Mission/achievement claims don't need the ledger because the claim
itself is a CAS-protected operation: the second claim returns
`CONFLICT` before `addPassXp` is reached.

| Caller | `dedupeKey.source` | `dedupeKey.id` | Behaviour on retry |
|---|---|---|---|
| Race subscriber | `race_quick` / `race_ranked` / ... | race `sessionId` | Second fire returns `{applied:false}`, no XP delta, no level up |
| `mission_claim` | (omitted) | — | Second claim returns `CONFLICT`, claim path never re-runs |
| `achievement_claim` | (omitted) | — | Same as mission |

---

## 5. Season close (D11)

The pass has its own season metadata independent from `ranked`
seasons. The catalogue carries `endUtc`; the lazy close fires when
`pass_get` (or `pass_claim`) runs after `Date.parse(endUtc) <= now`.

```
maybeCloseSeason(nk, logger, now, seasonId)
  ├── now < endUtc                    → {closed: false}, no-op
  ├── season_close marker present     → {closed: false}, no-op
  └── first caller post-endUtc
       ├── nk.storageWrite(season_close/{seasonId})
       └── {closed: true, seasonId, endUtc}
```

After the lazy close, every `pass_get` also calls
`settleClosedSeasonRewards` which CAS-flips the per-player
`seasonClosed` flag (3 retries). Once `seasonClosed: true`, every
`pass_claim` returns `CONFLICT: 'pass season is closed'` even when the
player has the XP.

**Reward migration across seasons**: there is **no** end-of-season
reward distribution for the pass. Players pick up their track by
level as they go via `pass_claim`; the `seasonClosed` flag is the only
signal that the season is over. (Ranked seasons, by contrast, dump
tier rewards to the inbox — see [`docs/ranked.md`](./ranked.md).)

**Storage ownership**: `season_close` lives under `SYSTEM_USER_ID` so
the marker is visible to every player's `pass_get` without writing N
per-player rows.

---

## 6. RPCs

The module exposes **4 RPCs** (3 player-facing + 1 admin):

| RPC | Purpose | Gated by | Idempotent? |
|---|---|---|---|
| `pass_get` | Lazy-create PassRecord, lazy-close season, return level cards | `assertNotInMaintenance` | yes (lazy-create safe; closes existing claim silently if `claimedFree` already includes the level) |
| `pass_claim` | Claim a level's free or premium reward | `assertNotInMaintenance` | yes (`CONFLICT` if already claimed) |
| `pass_buy_premium` | Spend `premiumPriceGems`, unlock the premium track | `assertNotInMaintenance` | yes (returns 200-style payload without re-charging) |
| `admin_grant_premium` | Shared-secret grant (no gem charge) | none (admin) | yes |

Rate limits:

| RPC | Window |
|---|---|
| `pass_get` | 60 calls / 60s per caller |
| `pass_claim` | 30 calls / 60s |
| `pass_buy_premium` | 10 calls / 60s |
| `admin_grant_premium` | 30 calls / 60s per target user |

### `pass_get` response

```ts
interface PassGetOutput {
  userId: string;
  seasonId: string;
  seasonClosed: boolean;
  endUtc: string;
  xp: number;
  currentLevel: number;          // xpToLevel(catalog, xp)
  nextLevel: number | null;      // null when currentLevel === maxLevel
  xpRequired: number;             // threshold for nextLevel (0 if nextLevel === null)
  xpRemaining: number;           // xpRequired - xp (0 if nextLevel === null)
  premiumPurchased: boolean;
  levels: PassLevelOutput[];     // 40 cards, freeClaimed + premiumClaimed per level
  premiumPriceGems: number;
}

interface PassLevelOutput {
  level: number;
  xpRequired: number;
  freeReward: PassLevelReward;
  premiumReward: PassLevelReward;
  freeClaimed: boolean;
  premiumClaimed: boolean;
}
```

### `pass_claim` errors

| Error | When |
|---|---|
| `BAD_REQUEST` | `level` not a positive integer; `track` not `free` or `premium`; `level` out of catalogue range |
| `NOT_FOUND` | PassRecord missing after lazy-create (theoretical — lazy-create always succeeds) |
| `INVALID_RESULT` | Player XP < level threshold |
| `FORBIDDEN` | `track === 'premium'` and `premiumPurchased: false` |
| `CONFLICT` | Already claimed (idempotent); season closed; CAS retries exhausted |

### `pass_buy_premium` errors

| Error | When |
|---|---|
| `INSUFFICIENT_FUNDS` | Wallet gems < `premiumPriceGems` |
| `CONFLICT` | Season closed; CAS retries exhausted |

### `admin_grant_premium` errors

| Error | When |
|---|---|
| `FORBIDDEN` | `adminKey` missing or mismatched |
| `BAD_REQUEST` | `userId` missing |
| `SERVICE_UNAVAILABLE` | `LiveopsConfig.adminRpcKey` not configured |
| `CONFLICT` | CAS retries exhausted |

---

## 7. Maintenance gate

All player-facing pass RPCs go through `assertNotInMaintenance`. When
`LiveopsConfig.flags.maintenance === true`:

- `pass_get`, `pass_claim`, `pass_buy_premium` return `SERVICE_UNAVAILABLE`.
- `admin_grant_premium` is **NOT** gated (admin surface).

This matches the pattern from Phase 5 (`inbox_claim`,
`account_link`, etc.) — see [`docs/liveops.md`](./liveops.md) §3.

---

## 8. Decisions

| ID | Decision | Where |
|---|---|---|
| D7 | Race XP = `Math.floor(20 × mode-multiplier)` | `pass/xp_engine.ts::raceXPFor` |
| D8 | Mission/achievement XP = `reward.xp` from catalogue | `pass/xp_engine.ts::missionXPFor` / `achievementXPFor` |
| D9 | `pass_xp_ledger` dedupe keyed by `(user, source, session)` — first-call-wins | `pass/pass_repo.ts::addPassXp` |
| D10 | `pass_claim` CAS retries = 3 (matches Phase 4 / Phase 6 standard) | `pass/rpcs.ts::pass_claim` |
| D11 | Lazy season close on first `pass_get` post-`endUtc`; marker in `season_close/{seasonId}` | `pass/season.ts::maybeCloseSeason` |
| D12 | Pass-level cosmetic delta from `pass_claim` is best-effort (never throws) | `pass/reward_granter.ts::grantPassReward` |
| D13 | `addPassXp` returns null when pass catalogue not loaded (best-effort, never crashes subscriber) | `pass/pass_repo.ts::addPassXp` |

---

## 9. Subtle gotchas

1. **`addPassXp` runs BEFORE the mission-storage null-check** in the
   `RaceCompleted` subscriber. Brand-new players (no daily/weekly/
   achievements storage yet) STILL receive pass XP for races.
   Important for first-time player onboarding.

2. **`xp_engine.missionXPFor({xp: 1.5})` returns 0** — only positive
   integers are accepted. Fractional values were a Phase 6 Chunk 7
   trap that resulted in `Math.floor` returning the wrong answer
   (silent under-credit). The integer check now rejects them entirely.

3. **`addPassXp` with `delta === 0`** short-circuits without a CAS
   write — the PassRecord is read once and returned with
   `levelUps: []`. No ledger row is written (would otherwise create
   noise from the subscriber's no-op path).

4. **`pass_buy_premium` does NOT use `spend()`'s pre-check path** —
   the wallet helper would race. Instead the RPC calls
   `walletSpend` directly, surfaces `INSUFFICIENT_FUNDS` on the
   wallet error code, then CAS-updates the flag. The compensating-refund
   pattern (Phase 3 D3) does NOT apply because there's no parallel
   multi-update — wallet and pass storage are sequential writes.

5. **`pass_claim` rewards go through `grantPassReward` which NEVER
   throws** (matches `mirrors/reward_granter.ts`). Catalog-missing
   cosmetics / cars are logged + skipped; the response payload
   carries `skippedCosmetics` / `skippedCars` arrays so the client
   can surface what didn't land.

6. **Lazy close is opt-in** — only fires on `pass_get` access. A
   `pass_claim` against a long-closed season returns `CONFLICT` (the
   per-player `seasonClosed` is only flipped when a Pre-RPC access
   reads the close marker). This is benign because clients are expected
   to refresh `pass_get` on every pass-tab mount.

---

## 10. Future work

- Cron-triggered lazy close so the per-player flag flips even when
  no one's online.
- Cross-season reward migration (today: players lose unclaimed
  premium levels at season end; future: maybe an inbox dump).
- Multiple concurrent seasons (s1, s2, ...) with a `seasonSelector`
  field — the catalog loader today accepts a single season.
- Pruning for `pass_xp_ledger` once a season is closed (no
  dedupe-key collisions across seasons today because `source.id`
  is opaque — but the ledger will grow forever).
- Re-roll / preview pass cards on `pass_get` to reduce round-trips.