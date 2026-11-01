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

## Decision 3 — charge and delivery in one transaction (storage + wallet)

`car_buy`, `car_upgrade` and `store_buy` combine a wallet movement with
the garage CAS write. Since plan T-11 both go in the same
`nk.multiUpdate` (the 3.27 JS binding takes wallet updates in its 4th
argument): `moveWallet(…, { extraWrites: [garageWrite(next, version)] })`.
See "One transaction per movement" in `docs/economy.md`.

## Decision 2 — full garage in one call

`garage_get` returns the entire garage — no pagination, no per-car
fetches. The client never needs a `get_car(carId)` RPC because the
server computes `OwnedCar.computedStats` when it builds the response (D-03).

## Decision 4 — cosmetic compatibility Strict

`cosmetic_equip` validates ALL of:

1. Car is owned (`garage.cars.some(c => c.carId === carId)`).
2. Cosmetic is in the bag (`garage.cosmeticsBag.includes(cosmeticId)`).
3. Cosmetic's `type` matches the slot:
   `paint | wheels | decal | trail | horn` ↔ the same five slots.
4. Cosmetic's `compatibleClasses` includes the car's `classId`.

Failing any one → `FORBIDDEN` (cosmetics the player can't legally equip
are a client-side bug, not a server-side data hazard, but the server
defends anyway).

### Removing a cosmetic

`cosmetic_equip` with `cosmeticId` `null`, `""` or absent removes the cosmetic
from the slot (`unequipCosmetic`): the slot key is deleted from `cars[].cosmetics`
and, when the car is the active one, from `loadout.equipped`. Validation: slot
(`BAD_REQUEST`), car in the catalog (`NOT_FOUND`), car owned (`FORBIDDEN`).
Removing from an empty slot is idempotent (`ok`). No separate RPC.

### Automatic garage

`car_buy`, `car_upgrade`, `cosmetic_equip` and `loadout_set` create the default
garage when it is missing (`readOrCreateGarageObject`), so none of them asks the
client to call `garage_get` first. If the creation write fails, the call answers
`INTERNAL`.

## Decision 5 — loadout publicly readable

The loadout IS publicly readable, but only via future `player_get`
(which is not yet implemented). For now, `garage_get` enforces
owner-only: `callerUserId === ctx.userId`. A different player inspecting
your loadout is a Phase 7 social RPC.

## Stats — `computeStats`

`computeStats(car, upgradesCatalog, levels)` returns the same shape as
`OwnedCar.computedStats`. The `delta` of each upgrade level is an
**increment** (D-01), not an accumulated bonus. For each stat of a line:

```
stat(level n) = min(baseStats[stat] + Σ_{k=1..n} delta_k, maxStats[stat])
```

Level 0 is `baseStats`. The stat is clamped to the car's `maxStats`. The
values are recomputed when a response is built, from the current table (D-03).

Delta table (D-02): the four lines of each class use the same vector, and its
sum is the smallest stat margin of that class, so every car in `cars.json` rises
at each level 0→5 without being clamped.

| Class | Deltas per level 1..5 | Sum |
|---|---|---|
| D | 2, 3, 4, 5, 6 | 20 |
| C | 2, 3, 4, 6, 7 | 22 |
| B | 2, 4, 5, 6, 6 | 23 |
| A | 2, 3, 5, 6, 6 | 22 |
| S | 2, 3, 4, 5, 6 | 20 |

Costs are not part of this table (see `upgrades.json`). The test
`tests/unit/upgrades_progression.test.ts` checks that each car rises strictly
at every level and that `validateUpgrades` requires the `delta` key of its line's stat.

The ranked variant (`computeStatsForRanked`) ignores upgrades and returns the
car's `maxStats`, so ranked races compete on driver skill.

## D3 — what the player sees

| Order | What happens |
|---|---|
| charge + CAS in one transaction, success | charged once, item delivered |
| the garage changed since the read (CAS lost) | nothing charged, nothing delivered, response = `CONFLICT`; the retry charges normally |
| short balance | `INSUFFICIENT_FUNDS`, nothing written |
| server crash mid-call | the transaction either committed or not; a retry replays (durable key) |

## Tests

| Suite | Cases |
|---|---|
| `tests/unit/garage-catalog.test.ts` | cars/upgrades/cosmetics validators |
| `tests/unit/garage-storage.test.ts` | mutation helpers (addCarToGarage, applyUpgrade, equipCosmetic, setActiveCar, addCosmeticToBag, markPackPurchased, etc.) |
| `tests/unit/stats.test.ts` | computeStats + ranked variant |
| `tests/e2e/garage.test.ts` | first-auth auto-create, garage_get round-trip |
| `tests/e2e/garage-mutations.test.ts` | car_buy / car_upgrade / cosmetic_equip / loadout_set (15 cases) |
| `tests/e2e/phase3-flow.test.ts` | new-user lifecycle end-to-end |
| `tests/e2e/refund-safety.test.ts` | lost garage CAS → nothing charged; the retry charges once |

## Future (not in scope)

- `player_get` for cross-player garage inspection (Phase 7 social)
- Cosmetic preview before purchase (Phase 5 UI)
- Car trade / gifting (deferred)
- Tuning / visual upgrades (paint respray shop) — Phase 6 store expansion