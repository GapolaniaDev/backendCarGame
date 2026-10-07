# Missions + Achievements — server-side contract

The Missions module is the server-authoritative daily/weekly mission
and achievement system. Races (`RaceCompleted` event) drive progress;
the player surfaces them through three read RPCs (`missions_get`,
`achievements_get`) and three claim RPCs (`mission_claim`,
`mission_reroll`, `achievement_claim`). XP and wallet/garage rewards
land automatically when the player claims.

> Related: [`docs/pass.md`](./pass.md) (XP routes here), [`docs/economy.md`](./economy.md) (mission wallet rewards), [`docs/unity-api.md §19`](./unity-api.md#19-phase-6-rpcs--missions-achievements-battle-pass).

---

## 1. Overview

The system has three moving parts:

```
            ┌────────────────────────────────────────────────────────┐
            │                  RaceCompleted event                    │
            │           (subscribes from main.ts: bus.subscribe)       │
            └────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────────────┐
            ▼                       ▼                               ▼
   counter.ts (pure)        assignment.ts                 progress_writer.ts
   (matchesEvent)          (sha256-seeded pick)          (CAS-write per-user)
            │
            ▼
   subscriber.ts → addPassXp (pass) + emit analytics + CAS-write daily/weekly/achievements
            │
            ▼
   mission_claim / achievement_claim → wallet.grant + garage cosmetic + addPassXp
```

The assignment is **deterministic** per player per UTC day — the same
`userId` always gets the same 3 daily missions on the same day, so a
client that refreshes `missions_get` mid-session sees the same cards.

---

## 2. Counter engine

`modules/src/missions/counter.ts` is a pure function:
`matchesEvent(event, def, userId) → boolean`. Seven `MissionKind`s
cover every metric the catalog exposes today:

| Kind | Predicate (all of these AND bots-filtered) |
|---|---|
| `race_count` | `result.finishedRace === true` |
| `race_position` | `result.finishedRace === true` AND `result.position <= filters.maxPosition` |
| `race_track` | `result.finishedRace === true` AND `event.trackId === filters.trackId` AND (`filters.maxPosition` undefined OR position ≤ it) |
| `race_class` | `result.finishedRace === true` AND `result.classId === filters.classId` |
| `wins_quick` | `event.mode === 'quick'` AND `finishedRace === true` AND `position === 1` |
| `wins_ranked` | `event.mode === 'ranked'` AND `finishedRace === true` AND `position === 1` |
| `race_no_abandon` | `result.finishedRace === true` AND `event.abandonedCount === 0` |

Mode/size/track/class filters apply to **every** kind above (they're
not per-kind). `requireFirstWinOfDay` is a hard filter that only
passes when the subscriber has stamped `firstWinOfDayFor[userId] ===
true` on the event (see `event_bridge.ts`).

**Defensive defaults:**
- **Bots filtered FIRST** — non-human `userId` returns `false` (NEVER
  matches).
- **`filters: {}` matches every event** (no narrowing applied).
- **Unknown kind → `false`** — the switch has no default branch that
  throws, so a malformed catalog row never crashes the subscriber.
- **`def` is NEVER mutated**, frozen or not.

The engine returns `0` or `1` (or for the `race_count` fast path, the
same). It does **NOT** carry storage writes — those live in
`progress_writer.ts` and the subscriber CAS-protects them.

---

## 3. Catalogs

Three JSON catalogs load at boot:

| File | Rows | Where loaded |
|---|---|---|
| `modules/src/catalogs/missions_daily.json` | 22 daily missions | `modules/src/main.ts::InitModule` → `loadMissionsDailyCatalog` |
| `modules/src/catalogs/missions_weekly.json` | 10 weekly missions | `loadMissionsWeeklyCatalog` |
| `modules/src/catalogs/achievements.json` | 22 achievements | `loadAchievementsCatalog` |

Daily/weekly missions carry `unlockLevel` — players below that level
see the mission in the RPC response with `locked: true` (UI hint), but
the subscriber still writes progress (so a level-1 player who grinds
to level 5 finds progress waiting). Achievements carry no
`unlockLevel` today (the field is reserved for future extensions).

Each mission/achievement carries:

```ts
interface MissionDefinition {
  id: string;
  title: string;
  description: string;
  kind: MissionKind;
  filters: MissionFilter;     // see Counter engine
  target: number;             // progress threshold for completion
  reward: MissionReward;
  unlockLevel: number;
}

interface MissionReward {
  coins?: number;
  xp?: number;                // routed to battle pass via addPassXp
  gems?: number;
  cosmeticId?: string;        // routed to garage.cosmeticsBag
}

interface AchievementDefinition {
  // Same as MissionDefinition but no `unlockLevel`.
}
```

---

## 4. Assignment algorithm

When `missions_get` is called for a player with no daily/weekly
assignment row, the storage layer materialises one via
`assignment.ts`. The algorithm is **deterministic** per
`(userId, dateUtc)`:

```
hashInput = `${ASSIGNMENT_SALT}:daily:${userId}:${dateUtc}`
sha = sha256(hashInput)
i  = first 8 hex digits of sha, parsed as uint32
missions = catalog[22 entries]
pick1 = missions[i % 22]
pick2 = missions[(i >>> 8) % 22]
pick3 = missions[(i >>> 16) % 22]
// all three must differ — if a collision occurs, advance the salt
```

`ASSIGNMENT_SALT = 'cv-missions-assignment-v1'`. The salt is a literal
in `assignment.ts`; changing it would re-randomise every player's
daily mission pool (a deploy-time decision, NOT per-user).

The algorithm guarantees:
- The same user always gets the same 3 daily missions on the same UTC day.
- Different users get different assignments with high probability
  (the 8-hex-digit hash space has 4 billion seeds, and the catalog has
  only 22 entries — collisions are vanishingly rare).
- The algorithm is pure / testable: `unit/assignment.test.ts` covers
  determinism, salt changes, catalog-empty edge case.

Weekly assignment uses `weekUtc` (`'YYYY-Www'`, ISO week number) and
the same algorithm with `ASSIGNMENT_SALT:'cv-missions-assignment-v1'`
+ `'weekly'` prefix.

---

## 5. Storage

| Collection | Key | Owner | Perms | Schema | Notes |
|---|---|---|---|---|---|
| `missions_daily` | `${userId}/${dateUtc}` | `userId` | 1/1 | 1 | Per-user per-day row. 3 assigned missions. |
| `missions_weekly` | `${userId}/${weekUtc}` | `userId` | 1/1 | 1 | Per-user per-week row. 3 assigned missions. |
| `achievements` | `userId` | `userId` | 1/1 | 1 | Single per-user achievements progress. |
| `first_win_today` | `userId` | `userId` | 1/1 | 1 | Stamped on first win of UTC day; CAS-guarded. |

`DailyMissions`:

```ts
interface DailyMissions {
  schemaVersion: 1;
  userId: string;
  dateUtc: string;                  // 'YYYY-MM-DD'
  assignedAt: number;               // ms
  rerollsLeftToday: number;         // 1 by default (D3)
  lastRerollAt?: number;            // ms (for analytics)
  missions: MissionInstance[];      // length === 3
}

interface MissionInstance {
  instanceId: string;               // `daily:<missionId>@<dateUtc>`
  missionId: string;
  progress: number;                 // 0..target
  completed: boolean;               // derived `progress >= target`
  claimed: boolean;
}
```

`WeeklyMissions` mirrors the above with `weekUtc` instead of `dateUtc`.

`AchievementsRecord`:

```ts
interface AchievementsRecord {
  schemaVersion: 1;
  userId: string;
  progress: Record<achievementId, number>;
  claimed: Record<achievementId, boolean>;
}
```

The achievements row is **lazy-created on first `achievements_get`**
(D13 — analog of the pass lazy-create). Same pattern as
`PassRecord`.

---

## 6. RPCs

| RPC | Purpose | Gated by | Idempotent? |
|---|---|---|---|
| `missions_get` | Materialise today's daily + weekly assignments + progress | `assertNotInMaintenance` | yes (re-materialise is no-op when row exists) |
| `mission_claim` | Claim reward for a single completed mission | `assertNotInMaintenance` | yes (CONFLICT on second claim) |
| `mission_reroll` | Re-roll one daily mission (1 free/day, 50 gems after) | `assertNotInMaintenance` | no (state change every call) |
| `achievements_get` | Lazy-create + return all 22 cards with progress | `assertNotInMaintenance` | yes |
| `achievement_claim` | Claim reward for a single completed achievement | `assertNotInMaintenance` | yes (CONFLICT) |

Rate limits:

| RPC | Window |
|---|---|
| `missions_get` | 60 calls / 60s per caller |
| `mission_claim` | 30 / 60s |
| `mission_reroll` | 10 / 60s |
| `achievements_get` | 60 / 60s |
| `achievement_claim` | 30 / 60s |

### `missions_get` response

```ts
interface MissionsGetOutput {
  daily: MissionAssignmentOutput;
  weekly: MissionAssignmentOutput;
  rerollsLeftToday: number;       // max of the two at the moment
  nowUtc: string;                 // ISO timestamp
}

interface MissionAssignmentOutput {
  dateUtc?: string;               // present on daily
  weekUtc?: string;               // present on weekly
  assignedAt: number;
  rerollsLeftToday: number;
  missions: MissionCardOutput[];
}

interface MissionCardOutput {
  instanceId: string;
  missionId: string;
  title: string;
  description: string;
  kind: MissionKind;
  filters: MissionFilter;
  target: number;
  reward: MissionReward;
  progress: number;
  completed: boolean;
  claimed: boolean;
  locked: boolean;                // `definition.unlockLevel > playerLevel`
}
```

### `mission_claim` errors

| Error | When |
|---|---|
| `BAD_REQUEST` | `missionId` missing or empty; `kind` not `daily` or `weekly` |
| `NOT_FOUND` | `missionId` not in catalog; not in the user's current row |
| `INVALID_RESULT` | Mission not yet completed (progress < target) |
| `CONFLICT` | Already claimed |
| `RATE_LIMITED` | Per-caller window exceeded |

### `mission_reroll` errors

| Error | When |
|---|---|
| `BAD_REQUEST` | `missionId` missing/empty |
| `NOT_FOUND` | Mission not in catalog |
| `INSUFFICIENT_FUNDS` | `useGems: true` and wallet < 50 gems |
| `RATE_LIMITED` | Per-caller window exceeded |

The free reroll (default `useGems: undefined`) decrements
`rerollsLeftToday` from 1 to 0 and never charges gems. A second reroll
in the same UTC day is rejected unless the caller opts in to pay 50
gems.

### `achievements_get` response

```ts
interface AchievementsGetOutput {
  achievements: AchievementCardOutput[];
  nowUtc: string;
}

interface AchievementCardOutput {
  achievementId: string;
  title: string;
  description: string;
  kind: MissionKind;
  target: number;
  reward: MissionReward;
  progress: number;
  completed: boolean;              // `progress >= target`
  claimed: boolean;
  locked: boolean;                // reserved — no `unlockLevel` in catalog today
}
```

### `achievement_claim` errors

| Error | When |
|---|---|
| `BAD_REQUEST` | `achievementId` missing/empty |
| `NOT_FOUND` | Unknown achievement or not in user's row |
| `CONFLICT` | Already claimed |
| `RATE_LIMITED` | Per-caller window exceeded |

---

## 7. Subscriber (`RaceCompleted` → progress)

`modules/src/missions/subscriber.ts` is registered at `InitModule` via
`subscribeMissionsProgress({ logger, nk, bus })`. The flow:

1. **`extractHumanResults(event)`** — drops bots (defensive even
   though `matchesEvent` also drops them).
2. **For each human**, in declaration order:
   1. **Grant pass XP FIRST** (Chunk 7). Brand-new players (no
      mission/achievement storage yet) still receive pass XP for the
      race. `addPassXp` carries the `sessionId` as `dedupeKey.id` so a
      replay doesn't double-apply.
   2. **Read** the user's daily/weekly/achievements rows (or `null`
      for brand-new players).
   3. **If all three rows are null** → log + skip (lazy creation is the
      RPC's job, not the subscriber's). Push a `dailyWritten: false,
      weeklyWritten: false, achievementsWritten: false` outcome so the
      subscriber return shape stays uniform.
   4. **Compute deltas** via `computeDeltas(event, userId, row, defs)`
      — calls `evaluateIncrement` per definition, returns a Map of
      `missionId → delta`.
   5. **Apply increments**, mark completed, write back via CAS.
   6. **Emit analytics** for every newly-completed mission /
      achievement (`mission_completed`, `achievement_unlocked`) and
      for every `pass_xp_gained` (already emitted by Chunk 7's
      `addPassXp` path).
3. **`progress_writer.ts`** does the CAS with **3 retries**; on
   exhaustion it logs and skips the write (never throws — subscribers
   must never crash the race-close path).

The subscriber's outcome:

```ts
interface MissionsSubscriberOutcome {
  humans: {
    userId: string;
    dailyWritten: boolean;
    weeklyWritten: boolean;
    achievementsWritten: boolean;
    dailyCompletedIds: string[];
    weeklyCompletedIds: string[];
    achievementCompletedIds: string[];
  }[];
}
```

The subscriber is **never** called from a path that doesn't already
have a write-capable context. The `RaceCompleted` event fires inside
the race-close path, which already has `nk` and `logger`.

### First-win-of-day (D3)

The `race_no_abandon` and `daily_first_win` missions require
`requireFirstWinOfDay: true`. The subscriber stamps
`firstWinOfDayFor[userId]` via a CAS-write to `first_win_today` (the
first of the UTC day wins, subsequent wins are no-ops).

---

## 8. Reward routing

Claim RPCs route the catalog `reward` to the wallet/garage/pass:

```
mission_claim:
  grant(wallet, {coins, gems}, reason='mission')
  addPassXp(...)          // missionXPFor(reward)
  emit('mission_claimed', ...)
  emit('pass_xp_gained', ...)  // when xpGranted > 0

achievement_claim:
  grantAchievementReward(wallet + garage CAS)
  addPassXp(...)          // achievementXPFor(reward)
  emit('achievement_claimed', ...)
  emit('pass_xp_gained', ...)
```

`missionXPFor({coins?, xp?, gems?, cosmeticId?})` and the achievement
counterpart return `reward.xp` only when it's a positive integer
(fractional or non-integer → 0, never `Math.floor`'d silently). The
`reward_granter.ts` (`reward_granter`) handles the wallet/garage CAS,
logs + returns `swallowedCosmetics` for catalog-missing cosmetic IDs.

The `LedgerReason` union is extended with `'mission'|'achievement'|'store'`
already in Phase 6 Chunk 1 (Ledger metadata carries `reason` as a
short string for analytics). The wallet idempotency key for a mission
claim is `mission:${kind}:${missionId}:${userId}` — second claim hits
the cache and returns `applied:true` no-op.

---

## 9. Decisions

| ID | Decision | Where |
|---|---|---|
| D1 | 3 daily missions assigned per player per UTC day | `missions/assignment.ts` |
| D2 | 3 weekly missions assigned per player per ISO week | same |
| D3 | 1 free reroll/day; 50 gems after; decrement via `useGems: false` first, `useGems: true` second | `missions/missions_repo.ts::rerollDailyMission` |
| D4 | `PAID_REROLL_COST_GEMS = 50` (locked default) | `missions/missions_repo.ts` |
| D5 | Mission `unlockLevel` defaults to 3 (locked) | `catalogs/missions_daily.json`, `missions_weekly.json` |
| D6 | Counter returns `0` for unknown kind (never throws) | `missions/counter.ts::matchesEvent` |
| D7 | Bots filtered FIRST in `matchesEvent` | `missions/counter.ts::findHumanResult` |
| D8 | Assignment salt = `'cv-missions-assignment-v1'` | `missions/assignment.ts` |
| D9 | Subscriber never throws; analytics best-effort | `missions/subscriber.ts` |
| D10 | Claim CAS retries = 3 (matches Phase 6 Chunk 6 pass_claim) | `missions/missions_repo.ts::claimDailyMission` |
| D11 | `first_win_today` CAS-guarded; first-write-wins | `missions/subscriber.ts` |
| D12 | Achievement `unlockLevel` reserved field (no current lock) | `catalogs/achievements.json` |
| D13 | Achievements row lazy-created on first `achievements_get` | `missions/achievements_repo.ts::ensureAchievements` |

---

## 10. Subtle gotchas

1. **`extractHumanResults` filters bots BEFORE** `matchesEvent` —
   the subscriber enforces this twice (defense in depth), so a race
   with 6 bots and 0 humans returns `{humans: []}` without touching
   storage.

2. **`requireFirstWinOfDay` only matches when the subscriber has
   stamped the flag** — when `firstWinOfDayFor` is missing, the
   counter returns `0` and the mission never progresses. The flag is
   stamped via CAS to `first_win_today/{userId}` so a network blip that
   races two wins still only credits one.

3. **`first_win_today` storage is per-user** but the stamp key uses
   the UTC day (CAS version includes `dateUtc`). This means a player
   who plays across midnight UTC gets the stamp reset automatically.

4. **The subscriber's "skip brand-new player" path** (when all three
   rows are null) doesn't create them — that's the RPC's job. So a
   fresh account that finishes a race before ever opening the missions
   tab receives pass XP (Chunk 7 ordering) but no mission progress.

5. **`mission_claim` is reachable even for `locked: true` missions**
   because the lock is a UI hint (`definition.unlockLevel > playerLevel`)
   — the claim itself gates on `instance.completed`. A level-1 player
   who somehow completes a level-7 mission (via XP boost or admin
   grant) can claim its reward.

6. **`mission_claim` returns `NOT_FOUND`** when the player's row
   doesn't exist. The first-call pattern is `missions_get` →
   `mission_claim`; the row always exists. The error code surfaces only
   in pathological cases (admin manipulation, parallel RPCs).

7. **`mission_reroll` doesn't refund the gems** on CAS failure — the
   reroll is a single CAS-write of `missions_daily` (no wallet write
   in the same operation), so a CAS conflict is just a retry.

8. **Achievements don't have `dailyWritten` style per-mission rows**;
   the whole achievements state is one row (`per-record`) with a
   `Record<achievementId, progress>` map. This makes the lazy-create
   pattern much simpler (D13).

---

## 11. Future work

- **First-claim bonus** for daily/weekly completion (XP boost or
  cosmetic token — none locked).
- **Server-side reroll of a quest** when a player buys out of "stuck on
  a hard one". Today the player pays 50 gems per reroll after the
  first free one.
- **Mission chains** — a weekly mission that unlocks a sub-set of
  daily missions (no chain support in the JSON catalog).
- **Bots-included** missions for tutorials (today bots always filter
  out — see Gotcha #1).
- **Achievement progress celebration** — emit a `achievement_unlocked`
  analytics event when the achievement crosses the threshold but
  BEFORE the player claims (today: only on claim). The subscriber emits
  `achievement_unlocked` on completion in Chunk 4.