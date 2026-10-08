# Events — CarVideoGameBackend

Time-bounded live events that modify gameplay (XP boost, featured
track highlight, special offer discount). Three kinds: `xp_double`,
`featured_track`, `special_offer`.

**Phase**: 8 (Chunk 8)
**Source**: `modules/src/events/`, `modules/src/core/active_events.ts`

---

## 1. Catalog

`events` collection (system-owned), `modules/src/catalogs/events.json`
(12 bundled events). Schema:

```ts
{
  schemaVersion: 1,
  events: [{
    id: 'evt_xxx',
    kind: 'xp_double' | 'featured_track' | 'special_offer',
    startsAtUtc: '<iso>',
    endsAtUtc:   '<iso>',
    payload: { /* kind-specific */ }
  }]
}
```

### Payloads

- `xp_double`: `{ multiplier: 2 }` — applied to XP earned from race
  results AND converted to a coin grant at `raceXPFor(mode) * (multiplier - 1)`
  (D51 — the bonus is paid in **coins**, not XP, so the wallet ledger
  shows the event credit).
- `featured_track`: `{ trackId: 'neon_blvd' }` — the track picker
  biases toward this track during the window.
- `special_offer`: `{ sku: 'gem_pack_500_50off', discountPct: 50 }` —
  the `store_get` RPC discounts matching SKUs.

---

## 2. RPC

### `event_list`

```http
POST /v2/rpc/event_list
{ "callerUserId": "<uuid>" }
```

Returns `{events: [{id, kind, startsAtUtc, endsAtUtc, isActive, payload}], now}`.
Sorted by `startsAtUtc` ascending. `isActive` is true iff `now ∈ [startsAtUtc, endsAtUtc)`.

`UNAUTHENTICATED` when `callerUserId` is missing (HTTP gateway path).

---

## 3. Subscriber (race.completed → event grants)

`modules/src/events/subscriber.ts` subscribes to the in-process
`RaceCompleted` event. For every human finisher:

1. Find all currently-active `xp_double` events (cached at module scope).
2. For each event, grant a coin bonus via `wallet.grant(reason='event', sourceId='event_xp_double:{sid}', idempotencyKey='event_xp:{raceId}:{userId}')`.
3. The idempotency key is `raceId` + `userId` (NOT sessionId) — a
   single race is processed once per user regardless of how many events
   the race coincided with.

### Idempotency gotcha

The bus event name is `RaceCompleted` (capital R — D51). Multiple
publishers might fire the same race; the idempotency key prevents
double-grants.

### Wallet grant vs XP grant

The `xp_double` event grants **coins**, not XP. The race's base XP
(`raceXPFor(mode)`) is unaffected; the event pays a coin bonus equal to
the XP amount × the multiplier delta. This keeps the pass XP curve
predictable while still rewarding the player for racing during the
event window.

---

## 4. Active special offers + `store_get`

`modules/src/core/active_events.ts` exports the `active_events`
runtime cache. The 5-minute scanner (chunk 8):

1. Walks all `events` with `kind === 'special_offer'`.
2. For each active offer, finds users whose profile is missing the
   offer id.
3. CAS-appends to `profile.activeSpecialOffers` (cap 10, sorted by
   `endsAtUtc` ascending, oldest dropped first when over cap; D54).

`store_get` (chunk 8) reads `profile.activeSpecialOffers` and decorates
matching offers with `basePrice` (catalog) and `finalPrice` (after
`discountPct`). Match key: `event.payload.sku === offer.offerId`.

The decorated shape:

```json
{
  "offer": { "offerId": "gem_pack_500_50off", "priceCoins": 1000, ... },
  "basePrice":  { "coins": 1000, "gems": 0 },
  "finalPrice": { "coins": 500,  "gems": 0 },
  "activeSpecialOfferId": "evt_offer_gem_pack_50off"
}
```

When no offer is active, `basePrice === finalPrice` and
`activeSpecialOfferId` is absent.

---

## 5. Scanner

`runEventScannerTick` runs every 5 minutes. Returns
`{updated: number, removed: number}` (number of profiles whose
`activeSpecialOffers` was mutated). Safe to call from the cron path
OR the unit tests (no `setInterval` involvement).

The scanner is **idempotent across ticks** — a profile that already
has the offer id is a no-op. A profile that has an offer whose event
has expired has the id removed (and the offer is no longer
discounted on the next `store_get`).

---

## 6. Storage

| Collection | Owner | Schema |
|---|---|---|
| `events` | system | `{schemaVersion, events: [{id, kind, startsAtUtc, endsAtUtc, payload}]}` |
| `profile.activeSpecialOffers` (embedded) | user | `string[]` (max 10, sorted by endsAtUtc asc) |

There is NO `event_grants` collection — the grant lives in the wallet
ledger with `reason: 'event:event_xp_double:{sid}'`. Operators query
the ledger (chunk 9 `admin_events_stats_get`).

---

## 7. Gotchas

- **Bus event name is `RaceCompleted` (capital R)** — D51. Lowercase
  `race_completed` does not fire the subscriber.
- **`activeSpecialOffers` cap is 10** — when an 11th offer activates,
  the oldest (by `endsAtUtc`) is evicted (D54).
- **Scanner only mutates `profile.activeSpecialOffers`** — the actual
  discount happens lazily in `store_get`. The scanner does NOT pre-write
  the `finalPrice` to the offer row.
- **The race XP bonus is paid in coins, not XP** — D51. The `wallet.grant`
  call uses `reason: 'event:event_xp_double:{sessionId}'`.
- **Scanner is safe to call from `setInterval`** — `runEventScannerTick`
  is synchronous and returns a count, so a stuck tick doesn't block the
  next one. (The actual scheduling is via the bundle-injected
  `setInterval`; see tournaments.md §9 for the goja VM gotcha.)
- **Idempotency key is `event_xp:{raceId}:{userId}`** — a single race
  grants at most once per user, even when multiple `xp_double` events
  overlap. The grants accumulate per-event via the `sourceId`, not the
  idempotency key.
