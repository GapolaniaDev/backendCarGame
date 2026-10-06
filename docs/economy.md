# Economy module (`modules/src/economy/`)

Phase 3 closes the wallet + rewards loop. The economy module owns:

- `wallet.ts` — `grant` / `spend` / `walletGet` / `applyLedger` helpers + ledger metadata packing
- `rewards.ts` — position-aware reward computation (coins/gems/XP per race result)
- `subscriber.ts` — `subscribeEconomyRewards` / `subscribeProgressionRewards` — wired into the `RaceCompleted` event bus
- `rpcs.ts` — `wallet_get` RPC (read-only wallet viewer)

The wallet itself is Nakama-native (`coins`, `gems` currencies stored
in `nk.accountGetId(...).wallet`). We never mirror the balance in
storage; the runtime is authoritative.

## Currencies

| Key | Source | Use |
|---|---|---|
| `coins` | soft currency | car upgrades, cosmetics, packs |
| `gems` | premium currency | packs, future season pass |

Anything with a `priceGems` field is treated as a real-money offer.
Pack contents grant `coins` and/or `gems` from the catalog table.

## Helpers in `wallet.ts`

| Helper | Purpose |
|---|---|
| `walletGet(nk, userId)` | read current `{ coins, gems }`; missing currencies coerced to 0 |
| `grant(nk, userId, changeset, metadata, idempotencyKey)` | credit (positive amounts only); idempotent on `(userId, key)` for 7 days |
| `spend(nk, userId, changeset, metadata, idempotencyKey)` | debit (positive amounts internally negated); idempotent; pre-check for `INSUFFICIENT_FUNDS` |
| `applyLedger(nk, userId, metadata, idempotencyKey)` | write a ledger marker without changing the balance (e.g. first-win-of-day stamps) |
| `formatLedgerMetadata(meta)` / `parseLedgerMetadata(s)` | compact `reason:sourceId[;k=v,...]` packing (≤ 200 bytes) |

### Idempotency

Every wallet mutation carries an idempotency key of the form
`<scope>:<userId>:<refId>:<suffix>`. The 7-day TTL is enforced via
`nk.localcachePut` (per-process, resets on restart — intentional: a
restart must not leave grants half-applied).

Common patterns:

| RPC | Spend key | Refund key | Pack grant key | Pack reverse |
|---|---|---|---|---|
| `car_buy` | `garage:buy:{userId}:{carId}` | `garage:buy:refund:{userId}:{carId}` | — | — |
| `car_upgrade` | `garage:upgrade:{userId}:{carId}:{line}:{newLevel}` | `garage:upgrade:refund:...` | — | — |
| `store_buy` (car/cosmetic) | `store:buy:{kind}:{userId}:{refId}` | `store:buy:{kind}:{userId}:{refId}:refund` | — | — |
| `store_buy` (pack) | `store:buy:pack:{userId}:{refId}` | `store:buy:pack:{userId}:{refId}:refund` | `store:buy:pack:{userId}:{refId}:pack` | `store:buy:pack:{userId}:{refId}:pack:reverse` |

### Ledger format

`nk.walletLedgerUpdate(userId, changeset, { reason: 'reward:race_123;sessionId=abc,confidence=quorum' }, idempotencyKey)`

The `reason` field is packed as `reason:sourceId[;k=v,key2=value2,...]`
extras (kept searchable in ops). Source IDs:

| Reason | Source ID examples |
|---|---|
| `race` | `race_abc123` |
| `mission` | `mission_first_win_of_day` |
| `store` | `lg_civic_r`, `perm_paint_matte_black`, `perm_starter_pack` |
| `level` | `level_5_reward` |
| `admin` | `admin_grant_2026_10_06` |

Extras (optional, separated by `;`): `sessionId=`, `confidence=quorum|client|server`, `mode=quick|ranked|private|time_trial`.

### D3 caveat — atomic-ish wallet + storage

Nakama 3.27 JS runtime does NOT expose wallet operations inside
`nk.multiUpdate` (see [[nakama-js-runtime-leaderboards]] §17).
Therefore every RPC combining the two uses the **compensating-refund
pattern**:

1. **Spend** via `spend(nk, userId, ...)` — idempotency key claimed, balance mutated, ledger entry written.
2. **CAS write** the garage / storage object with the version captured before the spend.
3. **On conflict**: the storage write throws → handler catches → `grant(nk, userId, refundChangeset, ..., ':refund' suffix)` issues a refund with a SEPARATE idempotency key so a retry of the original spend won't double-debit, and the refund itself can't be claimed twice.

For packs the same pattern repeats for the pack contents grant (a
second `grant` call after the spend succeeds, with `:pack` suffix;
reversed with `:pack:reverse` on CAS conflict).

### Rewards — `rewards.ts`

`computeReward(mode, size, rank, confidence, isFirstWinOfDay)` returns
`{ coins, gems, xp }`. See `modules/src/economy/rewards.ts`. Tunables
per mode/size are in `modules/src/catalogs/rewards.json`. The
subscriber (`subscriber.ts`) listens for `RaceCompleted` events and
calls `grant` + `applyLedger` per finisher.

> The `RaceCompleted` payload is NOT enriched with rewards
> ([[carvideogamebackend-phase3-chunk5]]) — clients compute rewards
> client-side from the catalog + result rank, or read the player's
> wallet via `wallet_get` for verification. Server-side rewards are
> authoritative.

### `wallet_get` RPC

See §16.6 of `docs/unity-api.md`. Returns the current `{ coins, gems,
pending, ledger }` view. Sub-millisecond server cost; called by the
header HUD after every wallet mutation.

### Tests

| Suite | Cases |
|---|---|
| `tests/unit/wallet.test.ts` | grant/spend/ledger/idempotency/insufficient-funds/metadata packing |
| `tests/unit/rewards.test.ts` | reward table per mode/size/rank/confidence + first-win-of-day bonus |
| `tests/e2e/wallet.test.ts` | round-trip balance, post-grant reflection, FORBIDDEN/UNAUTHENTICATED |
| `tests/e2e/phase3-flow.test.ts` | new-user lifecycle: wallet_get → garage_get → store_buy → car_upgrade → wallet_get |
| `tests/e2e/refund-safety.test.ts` | forced CAS failure → spend is refunded via :refund grant |

### Future (not in scope)

- Gift / season-season-pass subsystems (Phase 5) will populate
  `wallet_get.pending` with non-empty `PendingCredit[]`.
- Anti-cheat / wallet caps (Phase 7) — a daily-grant ceiling on the
  `RaceCompleted` subscriber.
- Audit-log export (Phase 8) — `nk.walletLedgerList` over a 30-day
  window per user, with `reason` / `confidence` aggregations.

---

## Economy spreadsheet

Catálogo completo de costos, ganancias y progresión esperada para un
jugador activo. Datos leídos directamente de
`modules/src/catalogs/cars.json`, `upgrades.json`, and `rewards.json`.

### A. Precios de autos

| Car | Clase | Precio (coins) | Nivel req. | Starter |
|---|---|---|---|---|
| `starter_viper` | D | 0 | 1 | ✓ (gratis en primer auth) |
| `civic_r` | D | 8 000 | 6 | |
| `coupe_gt` | C | 18 000 | 12 | |
| `phantom_rsx` | B | 32 000 | 20 | |
| `aurora_aero` | A | 55 000 | 30 | |
| `titan_s1` | S | 120 000 | 40 | |

### B. Costo de mejoras al máximo (todas las 4 líneas a nivel 5)

| Clase | engine (5 niveles) | tires/nitro/handling c/u | **Total al máximo** |
|---|---|---|---|
| D | 500+800+1 200+1 800+2 500 = 6 800 | 400+700+1 100+1 600+2 200 = 6 000 | **24 800** |
| C | 900+1 400+2 200+3 000+4 200 = 11 700 | 800+1 200+1 900+2 700+3 800 = 10 400 | **42 900** |
| B | 1 500+2 400+3 600+5 000+7 000 = 19 500 | 1 300+2 200+3 300+4 600+6 400 = 17 800 | **72 900** |
| A | 2 500+4 000+6 000+8 500+12 000 = 33 000 | 2 200+3 600+5 400+7 700+10 800 = 29 700 | **122 100** |
| S | 4 000+6 500+10 000+14 000+20 000 = 54 500 | 3 500+5 800+9 000+13 000+18 000 = 49 300 | **202 400** |

### C. Recompensas por carrera (`rewards.json#positionBase`)

Suma total a repartir por carrera × `modeMultiplier`:

| Modo | Mult. | 2-P (sum 150) | 4-P (sum 255) | 6-P (sum 365) |
|---|---|---|---|---|
| `quick` | 1.00 | avg 75 | avg 63.75 | avg 60.83 |
| `ranked` | 1.25 | avg 93.75 | avg 79.69 | avg 76.04 |
| `private` | 0.25 | avg 18.75 | avg 15.94 | avg 15.21 |
| `time_trial` | 1.00 | (auto, sin oponentes) | — | — |

Promedio por jugador en quick 4-P, posición media = **64 coins/carrera**.
Bonus adicionales:
- `firstWinOfDay`: **+100 coins** (una vez por día UTC, primer `cargo_puesto=1`).
- `noAbandon`: **+10 coins** (cuando nadie abandona la partida).

### D. Ritmo de juego asumido

Hipótesis casual (celular, colas ~15s + carrera ~60s = ciclo 75s):

| Patrón | Carreras / hora | Coins / hora (quick 4P) |
|---|---|---|
| Casual (1 h/día) | 15 | ~960 |
| Comprometido (2 h/día) | 25 | ~1 600 |
| Hardcore (3 h/día) | 25 sostenidos | ~2 400 con firstWinOfDay incluido |

(Usamos 15 races/h para casual — más realista que 25 dada la fatiga
de emparejar + pantallas de carga + mirar el HUD.)

### E. Días hasta el primer auto nuevo (`civic_r`, 8 000 coins)

| Patrón | Horas/día | Coins / día | **Días** |
|---|---|---|---|
| Casual 30 min | 0.5 | 480 | **17 días** |
| Casual 1 h | 1 | 960 | **8-9 días** |
| Comprometido 2 h | 2 | 1 920 | **4 días** |
| Hardcore 2 h con first-win bonus diario | 2 | 2 020 | **4 días** |

### F. Días hasta maxear un auto

`civic_r` clase D maxed (todas las 4 líneas a nivel 5) = 24 800 coins:

| Patrón | Coins/día | **Días para maxear D** |
|---|---|---|
| Casual 30 min | 480 | **52 días** |
| Casual 1 h | 960 | **26 días** |
| Comprometido 2 h | 1 920 | **13 días** |

Clase C (`coupe_gt`, 42 900 coins al máximo): doble del tiempo de D.
Clase B (`phantom_rsx`, 72 900): ~3× el tiempo de D.
Clase S (`titan_s1`, 202 400): ~8× el tiempo de D.

### G. Costo total — todos los autos sin mejoras

| Compra | Costo |
|---|---|
| 1× `civic_r` | 8 000 |
| 1× `coupe_gt` | 18 000 |
| 1× `phantom_rsx` | 32 000 |
| 1× `aurora_aero` | 55 000 |
| 1× `titan_s1` | 120 000 |
| **TOTAL garage completo (sin upgrades)** | **233 000 coins** |

A ritmo casual 1 h/día (960 coins/día): **243 días = ~8 meses**.

### H. Packs (`store.json#packs`)

| Pack | Coins grant | Gems grant | Precio (coins) | **ROI** |
|---|---|---|---|---|
| `starter_pack` | +5 000 | +50 | 2 500 | **+2 500 coins netos + 50 gems** (2× — compra única, banner de bienvenida) |
| `coin_sack` | +2 500 | — | 2 000 | +500 netos |
| `coin_sack_small` | +1 000 | — | 800 | +200 netos |
| `coin_sack_large` | +5 000 | — | 3 500 | +1 500 netos |

`starter_pack` es el atajo más rentable para desbloquear el primer auto:
comprarlo (gasta 2 500, recibe 5 000) deja al jugador con 2 500 coins
**adicionales** y empuja la compra de `civic_r` a solo 2 días de casual 1 h/día.

### I. ⚠️ GAP — meta de "primer auto nuevo en 2-3 días" NO se cumple

**Objetivo del Checklist** (§3.3): "días hasta el primer auto nuevo
(objetivo: 2 a 3)".

**Realidad con catálogo actual**: el jugador **casual 1 h/día** tarda
**8-9 días** en comprar `civic_r`. El **casual 30 min/día** tarda
**17 días**. Solo un jugador **comprometido 2 h/día con first-win
bonus** llega a la meta de 4 días, y todavía por encima del objetivo.

**Causa raíz**: `positionBase` para 4-P reparte solo 255 coins totales
y `modeMultiplier.quick = 1.0`. Sin multiplicador por modo y con
rewards cortas, j'avais economie está calibrada para un patrón
hardcore (3 h/día).

**Recomendación** (a aplicar en Fase 5 wrap-up o Fase 6+):

| Opción | Cambio | Efecto en días a `civic_r` (casual 1 h/día) |
|---|---|---|
| **A. Subir rewards ~50%** | `positionBase[4] = [150, 105, 75, 52]` (sum 382) | 5-6 días |
| **B. Subir multiplier quick** | `modeMultiplier.quick = 1.5` | 5-6 días |
| **C. Bonus diario login** | +500 coins al primer auth del día UTC | 4 días |
| **D. Bajar precio `civic_r`** | 5 000 coins (en vez de 8 000) | 5-6 días |
| **E. Combinación suave** | A + C = +75% rewards + 500/dia | **2-3 días** ✓ |

**Decisión recomendada**: opción **E** (combinar +75% rewards con
+500 login bonus). Logra la meta sin devaluar el progreso de los
jugadores hardcore (que reciben +75% sin mucho dolor) ni requerir una
revisión de todos los precios de la tienda.

**Estado en código**: GAP ABIERTO. Marcar como bloqueador para Fase 5
Chunk 10 (wrap) o Fase 6 primer chunk de balance económico. NO
aplicar durante Phase 4 — afecta métricas de matchmaking/ranked que
aún están en observación.

### J. Tests que validan esta hoja

| Suite | Caso |
|---|---|
| `tests/unit/rewards.test.ts` | Tabla de rewards × modo × size × rank × confidence + first-win-of-day |
| `tests/unit/garage-catalog.test.ts` | Validación de precios `cars.json` (precios no negativos, `requiredLevel >= 1`) |
| `tests/unit/garage-storage.test.ts` | Costos de upgrade por nivel (500+800+1200+1800+2500 = 6800 para D engine) |
| `tests/unit/store-catalog.test.ts` | Validación de packs + precios en `store.json` |
| `tests/e2e/store.test.ts` | Flujo end-to-end: `starter_pack` → `wallet_get` refleja grant |

Los números de las secciones A-H y B-G se pueden verificar a partir de los
catálogos sin tocar el runtime. La sección I (GAP) requiere decisión
del usuario antes de cualquier ajuste.