# Matchmaking & bot fill

Phase 4 server-side matchmaking for `quick` and `ranked` modes. The
matchmaker itself is owned by the Nakama runtime (`nk.matchmakerAdd`),
but every contract the client and the runtime depend on is implemented
here:

- **`mm_ticket_params`** — RPC that turns a player request into the
  matchmaker query + metadata the client then passes to
  `nk.matchmakerAdd`.
- **`matchmakerMatched`** — registered hook (`registerMatchmakerMatched`)
  that validates a candidate set, builds a `RaceSession` skeleton, and
  decides to accept or drop the suggestion.
- **`race_session_quick_bots`** — instant-fill RPC for solo players or
  small parties that don't want to wait; creates a `quick` session
  with human + bot roster, deterministic track pick, and starts the
  race immediately.
- **`race_host_claim`** — host succession on disconnect; the next human
  in `hostSuccession` promotes themselves to host within a 20-second
  grace window.
- **`track_picker`** — pure helper; deterministic FNV-1a pick over the
  track catalog.

This doc covers the wire contract and the locked decisions. For the
client integration shape, see `docs/unity-api.md` §17. For ranked
specifics (rating formula, divisions, seasons, abandon policy), see
`docs/ranked.md`.

---

## Locked decisions

| ID | Decision | Where enforced |
|---|---|---|
| D1 | `mm_ticket_params` server-stamps `version` + `region`; client cannot influence them | `matchmaking/rpcs.ts::resolveOptions` |
| D2 | Track picker excludes the player's last 2 tracks; deterministic FNV-1a seed | `matchmaking/track_picker.ts` |
| D3 | Bot difficulty derived from average human rating: `clamp(round(avgRating/400)-1, 0, 4)` | `matchmaking/quick_bots.ts::pickBotDifficulty` |
| D4 | Bot entries share the host human's `classId` (consistent min-time band) | `matchmaking/quick_bots.ts::buildBotRoster` |
| D5 | Host succession: lowest rttMs human, ties broken by `userId` ASC | `matchmaking/host_choice.ts` |
| D8 | `mm.segmentBy` defaults to `none`; liveops override at `liveops_config/current` | `liveops/mm_config.ts` |
| D9 | Rating band per ticket: tightest window for fresh ratings, widening over time | `ranked/config.ts::ratingWindowFor` |
| D10 | `botCount = size - humanCount`; full lobby → 0 bots | `matchmaking/quick_bots.ts::pickBotCount` |
| D12 | Ranked sessions equalize every roster entry's `loadout.stats` to its car's class max | `race/stats_equalization.ts::loadoutStatsFor` |

---

## `mm_ticket_params` (D1, D8, D9)

The RPC does NOT call `nk.matchmakerAdd` itself. It validates the
player's request, stamps the server-controlled fields, and returns the
query + metadata the client then passes to the matchmaker.

### Input

```ts
{
  mode?: 'quick' | 'ranked' | 'private' | 'time_trial';  // default 'quick'
  size?: 2 | 4 | 6;                                     // default 4 (time_trial ignores)
  platform?: 'mobile' | 'console' | 'pc';
  input?: Record<string, string>;                       // free-form, server doesn't read
  callerUserId?: string;                                // required on HTTP gateway
}
```

### Output

```ts
{
  ticket: {
    query:    { mode, size, version, region, segmentBy, ratingBand? };
    metadata: { mode, size, version, region, segmentBy };
  };
  output: {
    mode: 'quick' | 'ranked' | 'private' | 'time_trial';
    size: 2 | 4 | 6;
    version: string;   // server-stamped; client cannot influence
    region: string;    // server-stamped; client cannot influence
    mm: { segmentBy: 'none' | 'rating' };
    constraints: { excludeTrackIds: string[] };  // currently empty (D2 future)
  };
}
```

### Query keys

- `mode`, `size` — straight equality; different values never match.
- `version`, `region` — server-stamped; mismatched clients never
  match (forces clean upgrade paths).
- `segmentBy` — `none` (default) or `rating` (liveops override).
- `ratingBand` — `low-high` for `ranked`; literal `unrated` for
  other modes (so quick and ranked pools don't accidentally intersect).

### Errors

| Code | When |
|---|---|
| `BAD_REQUEST` | unknown mode / size / platform; malformed JSON |
| `INTERNAL` | uncaught |

Rate limit: 30 calls / 60 s per caller.

---

## `matchmakerMatched` hook (registered, not RPC)

The hook is registered at `InitModule` via
`initializer.registerMatchmakerMatched(matchmakerMatchedImpl)`. The
runtime calls it whenever a matchmaker suggestion is ready. The hook:

1. Walks every candidate in the envelope.
2. For each, validates ticket metadata (mode, version, region match
   across all tickets) and the matched-count / size alignment.
3. Returns `{ matched: true }` for the first valid candidate, or
   `{ matched: false, reason: string }` when no candidate qualifies.

### Validation rules (D1, D3, D10)

- All tickets in a candidate must agree on `mode`, `version`, and
  `region`.
- Matched count must be in `{2, 4, 6}` and equal to the metadata `size`.
- The metadata `mode` must be one of `quick | ranked | private |
  time_trial`.

When a candidate is rejected, the runtime re-evaluates the
matchmaker pool — the tickets stay queued for a future match.

### `pickCandidate` API

```ts
function pickCandidate(envelope: IMatchmakerMatchedEnvelope):
  | { matched: true; candidateIndex: number }
  | { matched: false; reason: string }
```

Pure function. The e2e suite
(`tests/e2e/matchmaking_full.test.ts`) drives the full integration.

### Building the `RaceSession`

On accept, the hook returns `{ matched: true }`. The relay (or a
subscriber) is expected to use the matched candidates to populate the
session roster. The roster is sorted by ascending `vars.rtt`; the
first entry becomes the `host` and the full list is mirrored in
`hostSuccession`.

> **Note:** Today the hook only validates; the actual
> `RaceSession` creation lives in the relay-side glue. Stats
> equalization (D12) is applied either in `race_session_create` /
> `race_session_join` (non-matched path) or in
> `applyStatsEqualizationToMatchedSession` for the matched path.

---

## `race_session_quick_bots` (D3, D4, D10)

Solo or small-party fill: build a `quick` session with humans + bots,
pick a track deterministically, and start the race immediately. The
client doesn't have to wait for a matchmaker round.

### Input

```ts
{
  size: 2 | 4 | 6;                       // required
  hostLoadout: { classId, bodyId, liveryId? };  // host's loadout
  humanRoster?: Array<{                  // default: [{ userId: caller, rttMs: 50, rating: 1000 }]
    userId: string;
    rttMs?: number;
    rating?: number;
  }>;
  trackId?: string;                      // explicit track override
  callerUserId?: string;                 // required on HTTP
  callerRating?: number;                 // default 1000
  callerRttMs?: number;                  // default 50
}
```

### Behavior

1. **Caller authz** — `callerUserId` must match `ctx.userId` when set;
   on mismatch → `FORBIDDEN`.
2. **Roster composition** — the caller is forced to the first
   `humanRoster` slot (`FORBIDDEN` if they supplied a roster that
   starts with someone else — bots can never host). Duplicate
   `userId`s → `BAD_REQUEST`. Empty `userId` → `BAD_REQUEST`.
3. **Bot fill** — `botCount = size - humanCount` (D10). Bot ids are
   `bot_qb_d{0..4}_{n}`; bot loadouts share the host's `classId`
   (D4).
4. **Host selection** — lowest `rttMs` human wins; ties broken by
   lexicographic `userId` (D5). Bots are never host.
5. **Bot difficulty** — `clamp(round(avgRating/400) - 1, 0, 4)` (D3).
   Defaults to the supplied `callerRating` when no other human
   supplies one.
6. **Track pick** — `pickTrack(allowedForQuick, excludeTrackIds, seed)`
   where `seed = sessionId` (D2). `excludeTrackIds` defaults to
   `[]` (Chunk 4 wired the per-player recent-tracks read; today
   the input is empty).
7. **Session write** — `race_sessions/{sessionId}` with
   `state='started'`, `startedAt = Date.now()`, `host = lowest-rtt
   human`. The host's `loadout` is the supplied `hostLoadout`.

### Output

```ts
{
  sessionId: string;
  mode: 'quick_bots';
  trackId: string;
  size: 2 | 4 | 6;
  host: string;             // userId of the lowest-rtt human
  startedAt: number;        // server-stamped
  roster: Array<{
    userId: string;
    isBot: boolean;
    rttMs?: number;
    botDifficulty?: number; // bots only
    loadout: { classId, bodyId, liveryId? };
  }>;
  botDifficulty: 0 | 1 | 2 | 3 | 4;
  botCount: number;
}
```

### Errors

| Code | When |
|---|---|
| `BAD_REQUEST` | invalid size, duplicate userId, empty userId, or too many humans for the size |
| `FORBIDDEN` | caller's `userId` is not first in `humanRoster` (host is always the caller) |
| `NOT_FOUND` | explicit `trackId` not in catalog |
| `RATE_LIMITED` | 6 calls / 60 s per caller |

### Bot roster shape

Bots carry `isBot: true`, no `rttMs` (the human's rtt is what matters
for host selection), and a synthetic `bodyId` of `bot-body-{difficulty}`.
Their class is the host human's `classId` so the min-time band
(`track.minTimeMsByClass[classId]`) is consistent across the field.

---

## `race_host_claim` (D5)

When the host's socket disconnects, the relay stamps
`disconnectReportedAt` on the host's roster entry. Any other human
in the roster may call `race_host_claim` to promote themselves to
host within the 20-second grace window (`ranked_config.graceSeconds`,
plus 5s of tolerance).

### Input

```ts
{
  sessionId: string;
  callerUserId?: string;   // required on HTTP
}
```

### Behavior

1. **Caller membership** — caller must be in `session.roster`
   (FORBIDDEN otherwise).
2. **Session state** — must be `started` (NOT `created`).
   Re-claim from `created` → BAD_REQUEST.
3. **Disconnect stamp** — current host must have
   `disconnectReportedAt`. Missing → BAD_REQUEST.
4. **Succession order** — caller must be the first human in
   `hostSuccession` AFTER the current host. Skipping ahead → BAD_REQUEST.
5. **Grace window** — `Date.now() - disconnectReportedAt ≤ graceSeconds + 5s`.
   Expired → BAD_REQUEST.
6. **Idempotency** — if the caller is already the recorded host
   (from a prior successful claim), the same `claimedAt` is echoed
   without a CAS write.
7. **Atomic write** — CAS over `session.version` to flip `host`
   and stamp `claimedAt`.

### Output

```ts
{
  sessionId: string;
  newHost: string;     // userId of the caller
  claimedAt: number;   // server-stamped
}
```

### Errors

| Code | When |
|---|---|
| `NOT_FOUND` | session doesn't exist |
| `FORBIDDEN` | caller not in roster |
| `BAD_REQUEST` | state not `started`; no disconnect stamp; not next in succession; grace expired |
| `CONFLICT` | CAS race lost (another caller claimed first) |
| `RATE_LIMITED` | 3 calls / 60 s per caller |

> **Note:** The `CONFLICT` branch is exercised by the unit + e2e
> suites but the production runtime rejects the stale write under
> CAS. The stub's `FakeNakama.storageWrite` doesn't model version
> races, so the e2e test for "second claim by another caller after
> the first moved host" relies on the succession being properly
> updated.

---

## `track_picker` (D2)

Pure helper. Given the set of allowed tracks for the mode and the
player's `excludeTrackIds` (typically empty until Chunk 4 wires the
per-player recent-tracks read), pick a deterministic track.

```ts
function pickTrack(
  allowedTrackIds: ReadonlyArray<string>,
  excludeTrackIds: ReadonlyArray<string>,
  seed: string,
): string;
```

The picker hashes `seed` with FNV-1a (`fnv1a`) and indexes into the
intersection. When the intersection is empty (every allowed track is
in the exclude set), it falls back to the full `allowedTrackIds` so
the caller never sees an empty result — at the cost of potentially
repeating a recent pick.

> **Determinism:** FNV-1a 32-bit; identical seeds produce identical
> picks. Used by `race_session_quick_bots` with `seed = sessionId`.
> The `fnv1a` export is exposed for tests.

---

## End-to-end coverage

`tests/e2e/matchmaking_full.test.ts` drives 15 cases:

- 6-client quick pool → identical query keys, `segmentBy='none'`,
  `ratingBand='unrated'`
- 5-client quick size=4 → ticket params valid (1 stays in queue at
  the runtime level)
- Solo ranked queue → `ratingBand` is `low-high` (not `unrated`)
- Invalid mode / size → BAD_REQUEST
- Hook accepts 6-human candidate
- Hook rejects mismatched mode / version / region
- Hook rejects empty candidate list
- Bot fill: 2 humans / size 4 → 2 humans + 2 bots
- Bot fill: 4 humans / size 4 → 0 bots (full lobby)
- Bot fill: host = lowest-rtt human regardless of order in
  `humanRoster`
- Bot fill session is persisted in `started` state
- Server-stamped version + region are identical across calls

`tests/e2e/host_recovery.test.ts` drives 7 cases for the host-claim
path; `tests/e2e/ranked_session.test.ts` covers the matched-session
stats equalization (D12) for ranked rosters.
