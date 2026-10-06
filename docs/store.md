# Store module (`modules/src/store/`)

Phase 3 commerce. The store reads the catalog, applies the player's
filters, returns sections the client can render, and processes
purchases via the compensating-refund pattern.

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

Pack contents are granted in the same spend as the offer price; if the
CAS garage write fails, the pack grant is reversed (see D3 caveat).

Adding a new pack = (a) entry in `PACK_TABLE`, (b) entry in
`store.json` catalog with `kind: 'pack'`, `refId` matching the pack id.

## `store_get` RPC

Returns `{ dailySeed, sections }`. Auto-creates the garage on first
call so a fresh player can browse the store before opening the garage
tab. See §16.7 of `docs/unity-api.md`.

## `store_buy` RPC

The compensating-refund pattern in detail for `store_buy`:

1. Look up offer in catalog (`NOT_FOUND` if absent).
2. Check expiry (`BAD_REQUEST` if expired).
3. Auto-create garage if absent (`INTERNAL` on write failure).
4. Ownership check (`CONFLICT` if already).
6. Level check (`FORBIDDEN` if below).
7. **Spend** via `spend(nk, userId, { coins: offer.priceCoins, gems: offer.priceGems }, { reason: 'store', sourceId: offer.offerId }, 'store:buy:{kind}:{userId}:{refId}')`.
9. **Pack content grant** (if applicable): `grant(nk, userId, pack.changeset, ..., ':pack')`.
10. **CAS write** the garage.
12. On CAS conflict: refund the spend via `:refund` + reverse the pack grant via `:pack:reverse`. Response = `CONFLICT`.
13. Return `{ delivery, newBalance }`.

| Error | When |
|---|---|
| `NOT_FOUND` | offer not in catalog |
| `BAD_REQUEST` | offer expired |
| `CONFLICT` | car/cosmetic/pack already owned OR CAS conflict (refund issued — retry safely) |
| `INSUFFICIENT_FUNDS` | wallet balance < offer price |
| `FORBIDDEN` | player level below `requiredLevel` |

See §16.8 of `docs/unity-api.md`.

## D3 caveat — same as `docs/economy.md`

The wallet + storage combination uses spend-first / CAS-second /
refund-on-conflict. The window where a player could be charged without
receiving the item is the duration of one CAS write (sub-millisecond
in normal load, but it can spike under storage back-pressure).
Operators monitor this via the `:refund`-suffixed ledger entries —
a sudden uptick indicates a storage write latency regression.

## Tests

| Suite | Cases |
|---|---|
| `tests/unit/store-catalog.test.ts` | validator + load + freeze |
| `tests/unit/store-rotation-filter.test.ts` | daily rotation determinism, filter cases (car/cosmetic/pack owned), expiry, level_low, isDailyOffer flag (16 cases) |
| `tests/e2e/store.test.ts` | store_get filters owned + level-gated; store_buy success paths for car/cosmetic/pack + INSUFFICIENT_FUNDS + CONFLICT + FORBIDDEN + NOT_FOUND (14 cases) |
| `tests/e2e/phase3-flow.test.ts` | end-to-end integration |
| `tests/e2e/refund-safety.test.ts` | CAS failure → spend refunded + pack grant reversed |

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