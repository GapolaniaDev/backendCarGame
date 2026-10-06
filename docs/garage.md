# Garage module (`modules/src/garage/`)

Phase 3 garage + car ownership + cosmetics + loadout. Per-user garage
record at storage key `garage/{userId}` (collection `garage`,
owner = userId, perms 0/0).

## File layout

```
modules/src/garage/
├── catalog.ts      # cars, upgrades, cosmetics catalog loaders + validators
├── stats.ts        # computeStats + ranked variant — used after every upgrade
├── storage.ts      # read/write/mutation helpers; addCarToGarage, applyUpgrade, etc.
├── types.ts        # Garage, OwnedCar, Loadout, CosmeticSlot, UpgradeLine
├── after_auth.ts   # registerGarageAutoCreate — seeds starter garage on first auth
└── rpcs.ts         # garage_get, car_buy, car_upgrade, cosmetic_equip, loadout_set
```

## Garage record shape

```ts
interface Garage {
  schemaVersion: 1;
  userId: string;
  cars: OwnedCar[];
  cosmeticsBag: string[];          // cosmetic ids the player owns (Phase 3.4+)
  purchasedPacks: string[];        // one-time entitlement redemption ledger (Phase 3.4+)
  loadout: Loadout | null;
  lastDailyWin: number;            // epoch-ms; null for "never won"
  dailyPrivateCount: number;       // private rooms finished today (server-enforced daily cap)
  dailyResetAt: number;            // epoch-ms at the next reset
}

interface OwnedCar {
  carId: string;
  classId: 'D' | 'C' | 'B' | 'A' | 'S';
  upgrades: { engine: number; tires: number; nitro: number; handling: number };
  cosmetics: Partial<Record<CosmeticSlot, string>>;
  computedStats: { speed: number; acceleration: number; handling: number; nitro: number };
}

interface Loadout {
  activeCarId: string;
  equipped: Partial<Record<CosmeticSlot, string>>;
  stats: { speed: number; acceleration: number; handling: number; nitro: number };
}
```

## After-auth channels covered

The `after_auth.ts` hook is registered into the four Nakama
authentication channels that the runtime exposes in 3.27:

| Channel | registerAfter() |
|---|---|
| Device | `registerAfterAuthenticateDevice` |
| Email  | `registerAfterAuthenticateEmail` |
| Custom | `registerAfterAuthenticateCustom` |
| Apple  | `registerAfterAuthenticateApple` |

Other channels (Facebook, Google, Game Center) rely on the first
`garage_get` call to auto-create — same code path, lazy.

## Decision 3 — compensating-refund (storage + wallet)

`car_buy`, `car_upgrade`, and `cosmetic_equip`/`store_buy`-with-money
all combine wallet mutation with garage CAS. Nakama 3.27 JS runtime
does not support wallet ops inside `nk.multiUpdate`, so the
compensating-refund pattern is used (see [[carvideogamebackend-phase3-chunk7]]
and §D3 in `docs/economy.md`).

## Decision 2 — full garage in one call

`garage_get` returns the entire garage — no pagination, no per-car
fetches. The client never needs a `get_car(carId)` RPC because the
server-side `computeStats` snapshot is included in `OwnedCar.computedStats`.

## Decision 4 — cosmetic compatibility Strict

`cosmetic_equip` validates ALL of:

1. Car is owned (`garage.cars.some(c => c.carId === carId)`).
2. Cosmetic is in the bag (`garage.cosmeticsBag.includes(cosmeticId)`).
3. Cosmetic's `type` matches the slot:
   `paint | decal | wheels | trail` ↔ `paint | decal | wheels | trail`.
4. Cosmetic's `compatibleClasses` includes the car's `classId`.

Failing any one → `FORBIDDEN` (cosmetics the player can't legally equip
are a client-side bug, not a server-side data hazard, but the server
defends anyway).

## Decision 5 — loadout publicly readable

The loadout IS publicly readable, but only via future `player_get`
(which is not yet implemented). For now, `garage_get` enforces
owner-only: `callerUserId === ctx.userId`. A different player inspecting
your loadout is a Phase 7 social RPC.

## Stats snapshot — `computeStats`

`computeStats(carCatalog, upgradesCatalog, levels)` returns the same
shape as `OwnedCar.computedStats`:

```
baseStats[classId] + levelSum * deltaStats[line][classId] * levelWeight
```

Equalized-to-class-cap: each class is bound to the same stat ceiling
so an A-class car at level 0 is not faster than an S-class car at
level 0. The cap is enforced in `computeStats` and checked again in
the `ranked` variant (used by matchmaking for fairness scoring).

The ranked variant (`computeStatsRanked`) factors in the player's
upgrade levels against the match's `mode`-weighted target.

## D3 caveat — same as `docs/economy.md`

Storage + wallet atomicity is **compensating-refund**, not truly
atomic. The user-visible semantics are:

| Order | What happens |
|---|---|
| spend → CAS success | spend applies, item delivered |
| spend → CAS conflict | spend is refunded via grant() with `:refund` suffix, item NOT delivered, response = `CONFLICT` |
| spend → CAS conflict → retry | second spend hits the same idempotency key and skips the debit; CAS now succeeds, item delivered |
| spend → server crash mid-flow | spend is half-applied (post-mortem audit reveals) — no refund issued, but the player can contact support with the idempotency key for manual reversal |

The 4th case is rare (server crash between `nk.walletUpdate` and
`nk.storageWrite`) and is the reason we keep ledger entries — ops
can correlate `(sessionId, sourceId)` for manual review.

## Tests

| Suite | Cases |
|---|---|
| `tests/unit/garage-catalog.test.ts` | cars/upgrades/cosmetics validators |
| `tests/unit/garage-storage.test.ts` | mutation helpers (addCarToGarage, applyUpgrade, equipCosmetic, setActiveCar, addCosmeticToBag, markPackPurchased, etc.) |
| `tests/unit/stats.test.ts` | computeStats + ranked variant |
| `tests/e2e/garage.test.ts` | first-auth auto-create, garage_get round-trip |
| `tests/e2e/garage-mutations.test.ts` | car_buy / car_upgrade / cosmetic_equip / loadout_set (15 cases) |
| `tests/e2e/phase3-flow.test.ts` | new-user lifecycle end-to-end |
| `tests/e2e/refund-safety.test.ts` | forced CAS failure → spend refunded |

## Future (not in scope)

- `player_get` for cross-player garage inspection (Phase 7 social)
- Cosmetic preview before purchase (Phase 5 UI)
- Car trade / gifting (deferred)
- Tuning / visual upgrades (paint respray shop) — Phase 6 store expansion