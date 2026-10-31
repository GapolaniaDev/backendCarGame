# Store module (`modules/src/store/`)

Phase 3 commerce. The store reads the catalog, applies the player's
filters, returns sections the client can render, and processes
purchases in one wallet transaction (charge + delivery, plan T-11).

## File layout

```
modules/src/store/
├── catalog.ts      # loadStoreCatalog — validates and freezes the catalog
├── rotation.ts     # daily rotation: FNV-1a hash, deterministic per UTC day
├── filter.ts       # pure: ownershipFromGarage, filterOffersForSection, filterCatalog
├── packs.ts        # PACK_TABLE — one-time entitlements (4 packs shipped)
├── types.ts        # StoreCatalog, StoreSection, StoreOffer
└── rpcs.ts         # store_get + store_buy
```

## Catalog shape

```ts
interface StoreCatalog {
  version: 1;
  dailyRotationPoolSize: number;        // e.g. 3 — top N daily offers per day
  sections: ReadonlyArray<StoreSection>;
}

interface StoreSection {
  id: 'permanent' | 'daily' | 'level_gated';
  displayName: string;
  offers: ReadonlyArray<StoreOffer>;
}

interface StoreOffer {
  offerId: string;            // unique within the catalog (e.g. lg_civic_r)
  kind: 'car' | 'cosmetic' | 'pack';
  refId: string;              // carId / cosmeticId / packRefId — points into the source catalog
  displayName: string;
  priceCoins?: number;        // optional priceCoins for cost coverage
  priceGems?: number;         // optional priceGems for cost coverage
  requiredLevel?: number;     // for player; level check
  expiresAt?: number | null;   // epoch-ms for expiry; null = permanent
}
```

Each section and offer also carries `displayNameKey` (`store_section.<id>.name` / `store_offer.<offerId>.name`), the Unity Localization key of its `displayName`, which stays the English fallback (T-11, D-11).

The catalog is loaded at `InitModule` via `loadStoreCatalog(...)`
which validates via `validateStoreCatalog` and freezes the result
with `Object.freeze`. Catalog failures panic with `CATALOG_INVALID`.

## Daily rotation — deterministic per UTC day

`withDailyRotation(catalog, nowMs)` rewrites the `daily` section
based on `dayIndexUtc(nowMs)`:

1. Compute `dayIndex = floor(nowMs / 86400000)`.
2. For each offer in the source daily pool, compute `fnv1a(${offerId}:${dayIndex})`.
3. Sort descending by hash, take top `dailyRotationPoolSize`.
4. Replace the `daily` section's offers with the rotated list.

Result: every player in the world sees the same daily offers at the
same UTC instant. The `dailySeed` returned in the response is
`dayKeyUtc(nowMs)` — base36 of the day index — for any client badge
(`Día #12345`).

### Why FNV-1a

- Single function, no cryptographic dependency.
- 32-bit unsigned output; perfect hash distribution across offerIds.
- O(N) over the daily pool (~6 entries in seed data) — negligible.
- Deterministic across platforms (no locale issues with `Date` arithmetic
  — `Date.UTC(...)` already gives a UTC-anchored epoch ms).

## Filters applied to `store_get`

`filterCatalog(catalog, ctx)` produces a list of `{ section, visible }`
where `visible` contains the offers the player can actually buy:

| Reason | When |
|---|---|
| `expired` | `nowMs >= offer.expiresAt` |
| `level_low` | `playerLevel < offer.requiredLevel` |
| `already_owned` | `car ∈ garage.cars` OR `cosmetic ∈ garage.cosmeticsBag` OR `pack ∈ garage.purchasedPacks` |

The `daily` section's offers are tagged `isDailyOffer: true` so the
client can render them with a "Solo hoy" badge.

## Pack table — `packs.ts`

`PACK_TABLE` ships 4 packs in Phase 3:

| Pack id | Display name | Coins | Gems | Price (coins) |
|---|---|---|---|---|
| `starter_pack` | Pack inicial | +5000 | +50 | 2500 |
| `coin_sack` | Bolsa de monedas | +2500 | — | 2000 |
| `coin_sack_small` | Bolsa monedas pequeña | +1000 | — | 800 |
| `coin_sack_large` | Bolsa monedas grande | +5000 | — | 3500 |

Pack contents are a second move of the purchase's wallet transaction:
if the garage CAS write fails, neither the price nor the contents move.

Adding a new pack = (a) entry in `PACK_TABLE`, (b) entry in
`store.json` catalog with `kind: 'pack'`, `refId` matching the pack id.

## `store_get` RPC

Returns `{ dailySeed, sections }`. Auto-creates the garage on first
call so a fresh player can browse the store before opening the garage
tab. See §16.7 of `docs/unity-api.md`. Maintenance-gated
(`SERVICE_UNAVAILABLE`); the min-version gate is not applied because the
Unity client sends no `clientVersion` (T-14 owns the version gate).

Each listed offer is `{ offer, isDailyOffer, basePrice, finalPrice,
activeSpecialOfferId?, owned }`. Prices are `{coins, gems}`.
`finalPrice` is what `store_buy` charges right now (plan T-12):
`store/pricing.ts` computes it for both RPCs from the player's
`activeSpecialOffers` and the **server** clock. `owned` is additive;
owned offers are not listed, so a listed one says `false`.

### Special offers

A `special_offer` event (`events.json`) discounts the offer whose
`offerId` is its `payload.sku` by `payload.discountPct` (a charged
currency never drops to 0). When the events catalog loads, a
`special_offer` whose SKU is not a store offer id is dropped with a
single `special_offer dropped, sku is not a store offer: …` warning per load (HT-80). The four bundled special
offers name SKUs that are not store offers, so today none applies.

## `store_buy` RPC

One transaction per purchase (plan T-11, `docs/economy.md`):

1. Look up offer in catalog (`NOT_FOUND` if absent).
2. Check expiry with the server clock (`BAD_REQUEST` if expired).
   `nowMs` in the request is ignored.
3. Auto-create garage if absent (`INTERNAL` on write failure).
4. Ownership check (`CONFLICT` if already).
5. Level check (`FORBIDDEN` if below).
6. Assemble the delivery (new garage; catalog drift → `INTERNAL`, nothing charged).
7. Price = `finalPrice` (same function as `store_get`).
8. `moveWallet(…, 'store:buy:{kind}:{userId}:{refId}', [−price, +pack contents], { extraWrites: [garage CAS write] })`.
9. Return `{ delivery, newBalance, pricePaid }` (`pricePaid` additive).

A lost garage CAS or a short balance changes nothing, so a retry (or a
rebuy) charges normally; concurrent calls for the same offer charge once
and answer what the winner delivered.

| Error | When |
|---|---|
| `NOT_FOUND` | offer not in catalog |
| `BAD_REQUEST` | offer expired |
| `CONFLICT` | car/cosmetic/pack already owned OR concurrent garage update (nothing charged — retry) |
| `INSUFFICIENT_FUNDS` | wallet balance < price |
| `FORBIDDEN` | player level below `requiredLevel` |
| `SERVICE_UNAVAILABLE` | maintenance |

See §16.8 of `docs/unity-api.md`.

## Tests

| Suite | Cases |
|---|---|
| `tests/unit/store-catalog.test.ts` | validator + load + freeze |
| `tests/unit/store-rotation-filter.test.ts` | daily rotation determinism, filter cases (car/cosmetic/pack owned), expiry, level_low, isDailyOffer flag (16 cases) |
| `tests/unit/store_pricing.test.ts` | charged = shown with an active special offer, unknown SKUs dropped, `owned`, client `nowMs` ignored, maintenance gate |
| `tests/e2e/store.test.ts` | store_get filters owned + level-gated; store_buy success paths for car/cosmetic/pack + INSUFFICIENT_FUNDS + CONFLICT + FORBIDDEN + NOT_FOUND (14 cases) |
| `tests/e2e/phase3-flow.test.ts` | end-to-end integration |
| `tests/e2e/refund-safety.test.ts` | lost garage CAS → nothing charged, pack not kept, rebuy charges; 10 racing buys charge once |

## Future (not in scope)

- Limited-time events (Phase 6) — `expiresAt` already supports this;
  need a UI countdown + banner.
- Receipt verification / IAP (Phase 9) — `store_buy` becomes
  receipt-driven; the current `offerId` path stays for soft-currency
  sales.
- Bundles / cross-catalog packs (Phase 6+) — bundle = one entry that
  delivers multiple `car` + `cosmetic` references; needs extension on
  `StoreOffer.kind`.
- Store discovery / pagination — sections are short enough not to
  need it today.