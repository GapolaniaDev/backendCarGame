# Account Linking & Deletion — CarVideoGameBackend

How players attach an Apple / Google / email identity to a Nakama
device-id account, how conflicts resolve, and how an account delete
cascades through storage + leaderboards.

**Phase**: 5 (Chunks 4, 5)
**Source**: `modules/src/account/`

---

## 1. Why link at all

Nakama device-id accounts are anonymous and bound to a single device.
If the player uninstalls the app or loses the device, the account is
gone. Linking attaches an external identity (`custom_id` in Nakama
terms) so the player can re-authenticate on a new device and recover
their progression.

The 500-coin bonus (D4) is granted **once** per profile on the first
successful link — gated by `profile.accountLinkBonusClaimed` so it
can't be re-claimed by switching providers.

---

## 2. Providers

| Provider | Token format (wire) | Validation |
|---|---|---|
| `apple` | Apple identity token (JWT) | Apple JWKS — see §7 |
| `google` | Google ID token | Google `tokeninfo` endpoint |
| `email` | HMAC-signed token (test-mode only) | HMAC-SHA-256 over `userId.ts.nonce` using a shared secret |
| `custom` | provider-defined opaque string | dev-only; rejected in production |

The wire contract is provider-agnostic:

```json
{
  "provider": "apple" | "google" | "email" | "custom",
  "token":    "<provider-specific opaque string>",
  "clientVersion": "1.2.3",
  "platform":       "ios"
}
```

The server-side `linkAccount(nk, logger, userId, provider, token,
nowMs)` function dispatches on provider.

---

## 3. Token validation (dev mode)

The test-mode `email` provider uses an HMAC verifier
(`account/linking.ts`). The wire format is
`v1.<userId>.<nonce>.<base64-hmac>`. HMAC-SHA-256 over the string
`<userId>.<nonce>` using a shared secret. The verifier:

1. Splits on `.`. Reject when not 4 parts or not `v1`.
2. Base64-decodes the HMAC. Constant-time compare.
3. Rejects when the `userId` doesn't match the caller's
   `ctx.userId` (or `callerUserId`).
4. Accepts any nonce — there's no replay-protection in dev mode.

**Production** (real Apple / Google) replaces the verifier with calls
to Apple JWKS / Google tokeninfo. See §7.

---

## 4. Link flow

```
device auth → ctx.userId = U
   ↓
account_link { provider, token, callerUserId: U }
   ↓
linkAccount(nk, ..., 'U', provider, token, nowMs)
   ↓
┌─────────────────────────────┐
│ Has the provider's userId   │
│ already been linked?        │
└──────┬─────────────────┬───┘
       │ no              │ yes
       ↓                 ↓
linked:true       conflict:
                  { conflictToken, otherUserId,
                    otherProfile, expiresAt: +24h }
```

- `linked:true` returns `bonusClaimed: boolean` and
  `newBalance: { coins, gems }`.
- `conflict` returns a `conflictToken` handle the client passes back
  to `account_link_resolve_conflict` within 24h to either:
  - `choice: 'link'` — keep the current account, link the provider,
    purge the conflict-account.
  - `choice: 'cancel'` — abandon the link.

### Conflict storage

`account_link_conflict/{userId}` (collection `account_link_conflict`,
owner = the original user). TTL: 24h. Lazily GC'd on read.

---

## 5. Conflict resolution flow

```
1. Client receives conflict envelope from account_link.
2. Shows UI: "Apple ID is already attached to another account.
   Link to current [Vodafone] OR cancel?"
3. Client sends account_link_resolve_conflict { choice, conflictToken,
   confirmText? }.
4. Server validates the conflictToken + choice + (if 'link') the
   confirmText.
5. Server either:
   - 'cancel' → removes the conflict row; account_link_conflict_resolved
     analytics event.
   - 'link'   → calls resolveConflict() which:
     a) deletes the other account (cascade — see §6)
     b) credits the 500-coin bonus IF not already claimed
     c) removes the conflict row
     d) emits account_link_conflict_resolved
```

The `confirmText` is required when the conflict targets an account
with a non-empty garage or wallet — defensive check against
"accidentally" deleting progression.

---

## 6. Account delete cascade

`account_delete_impl` (Phase 5 Chunk 5). GDPR right to erasure. The
RPC:

1. Verifies `confirmText === 'DELETE'` (exact match — sentinels
   against accidental UI fires).
2. Marks the user as abandoned in every active race session so
   `RaceCompleted` knows they DNF'd.
3. Purges storage rows from a **whitelist** of collections:
   - `profiles`
   - `loadout`
   - `garage`
   - `wallet_ledger` (NOT per-user today — ledger rows are not
     owner-scoped; the delete emits a `wallet_moved` event with
     `reason: 'account_delete'` for audit)
   - `ranked_records`
   - `liveops/abandons/{userId}` (the abandonment counter)
   - `analytics_events` rows where `userId` matches
   - Skips: `abandons/{userId}` (treated as session-scoped — not
     "user data"), `pc-account` (system config).
4. Purges leaderboard records: every leaderboard the user has a row
   on is updated via `nk.leaderboardRecordDelete`.
5. Unlinks every custom auth the user has attached
   (`nk.unlinkCustom`).
6. Calls `nk.accountDeleteId(userId, false)` — second arg is the
   "recorded" flag (BOOLEAN, NOT unix seconds — confirmed against
   the runtime).
7. Emits `account_deleted` analytics event with full summary.

`account_delete` **bypasses maintenance** — GDPR > ops. The client can
always exercise the right to erasure.

### Summary fields

```ts
{
  deletedAt: ISO-8601 string,
  summary: {
    storageDeleted:     number,
    collectionsAffected: string[],
    boardsDeleted:      number,
    boardsAffected:     string[],
    unlinkedAuths:      number,
    wasClubLeaderOf:    string[],   // always [] in v1 (clubs = Phase 7)
    abandonedFromRaces: number,
  }
}
```

---

## 7. Production checklist (real Apple / Google)

Out of scope for v1 — the test-mode `email` HMAC verifier is what the
e2e suite exercises. To go live:

### Apple
- `APPLE_KEYS_URL` — defaults to `https://appleid.apple.com/auth/keys`
- The validator MUST fetch the JWKS, find the key matching the JWT's
  `kid`, verify the signature, and check `aud === APPLE_CLIENT_ID`,
  `iss === 'https://appleid.apple.com'`, and `exp` in the future.
- Cache the JWKS for 1h, key-pinned by `kid`.

### Google
- `GOOGLE_CLIENT_ID` — your OAuth web/iOS/Android client IDs.
- The validator calls
  `https://oauth2.googleapis.com/tokeninfo?id_token=<token>` and
  verifies `aud` matches one of the configured client IDs.

### Env vars (not yet wired)
```
APPLE_KEYS_URL=https://appleid.apple.com/auth/keys
GOOGLE_CLIENT_ID=...                # comma-separated
LINKING_SHARED_SECRET=...           # dev-mode email HMAC secret
```

The e2e tests use a stub `linkAccount` path with no real network
calls; production deployment MUST replace the dev-mode verifier
before any external players can attach Apple / Google identities.

### Rate limiting
Per-IP and per-user rate limits on `account_link` and
`account_link_resolve_conflict` are NOT in v1. Add when abuse is
observed.

### Audit
Every link success / conflict / resolution emits an `account_linked`,
`account_link_conflict`, or `account_link_conflict_resolved` event
into `analytics_events`. See `docs/liveops.md` §6.

---

## 8. Files

| Concern | File |
|---|---|
| Wire types | `account/types.ts` |
| Linking + conflict logic | `account/linking.ts` |
| RPCs | `account/rpcs.ts` |
| Purge whitelist | `account/purge.ts` |
| Race abandon-on-delete | `account/rpcs.ts` (calls `race/remove_player.ts`) |