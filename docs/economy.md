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