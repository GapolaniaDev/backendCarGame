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

## 4. One event source: `events.json` (plan T-23)

Events have ONE source, the bundled `catalogs/events.json` calendar,
loaded per VM by `core/active_events.ts`. Everything that needs "what is
live now" asks it with the server clock:

- `event_list` returns the whole calendar with `isActive`;
- `liveops_config_get.calendar` is the events that have not ended
  (`type: 'event'`, plus `kind`, additive) and the maintenance windows of
  the liveops config; the config's own `event` / `tournament` entries are
  ignored (they were a second, always-empty schedule);
- the store pricing applies the live `special_offer` events
  (`resolveActiveSpecialOfferIds(now)`).

`store_get` decorates matching offers with `basePrice` (catalog) and
`finalPrice` (after `discountPct`). Match key:
`event.payload.sku === offer.offerId`.

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

## 5. Service-ticker job

`runEventScannerTick` runs every 5 minutes from the service ticker and is
read-only: it reports the number of live events and the live special
offers (`events=live=N/offers=M` in the tick line). It used to rewrite
EVERY profile to cache the live offers in `profile.activeSpecialOffers`
(a stale second copy of the calendar that also rebuilt each profile from
a fixed field list); nothing reads that field any more.

---

## 6. Storage

| Collection | Owner | Schema |
|---|---|---|
| `events` | system | `{schemaVersion, events: [{id, kind, startsAtUtc, endsAtUtc, payload}]}` |
| `profile.activeSpecialOffers` (embedded, legacy) | user | no longer written or read (plan T-23) |

There is NO `event_grants` collection — the grant lives in the wallet
ledger with `reason: 'event:event_xp_double:{sid}'`. Operators query
the ledger (chunk 9 `admin_events_stats_get`).

---

## 7. Gotchas

- **Bus event name is `RaceCompleted` (capital R)** — D51. Lowercase
  `race_completed` does not fire the subscriber.
- **At most 10 live special offers apply at once** — the soonest-ending
  ones (D54).
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
