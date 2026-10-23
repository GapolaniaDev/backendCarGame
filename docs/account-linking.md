# Account Linking & Deletion — CarVideoGameBackend

How players attach an Apple / Google / Steam / Facebook / email / custom
identity to their Nakama account, how a link conflict resolves, and how
an account delete purges every collection.

**Plan cards**: T-15 (native linking, P-02), T-16 (full purge)
**Source**: `modules/src/account/`, `modules/src/core/collections.ts`

---

## 1. Native linking (no server token)

Linking is done by the **client with the Nakama client API**:
`LinkDeviceAsync`, `LinkEmailAsync`, `LinkCustomAsync`, `LinkGoogleAsync`,
`LinkAppleAsync`, `LinkSteamAsync`, `LinkFacebookAsync` (the JGK gateway
already wraps them). Nakama verifies the provider token (Apple / Google
JWKS, Steam and Facebook APIs, email + password) with its own
configuration, so:

- the server never signs, receives or verifies a link token;
- there is **no secret in the bundle** (the old test HMAC token and its
  `ACCOUNT_LINK_TEST_SECRET`, audit 06 f11, are gone) and no secret of
  ours to configure: nothing goes to `runtime.env`;
- provider credentials (Apple Service ID, Google client ids, Steam key,
  Facebook app) are Nakama settings (`nakama.yml` / env), see §5.

`accountGetId` (3.27, `accountToJsObject`) reports what is linked:
`user.appleId`, `user.googleId`, `user.facebookId`,
`user.facebookInstantGameId`, `user.gamecenterId`, `user.steamId`,
`email`, `customId` (`devices` are the guest credential, not a link).
`account/identities.ts::linkedProviders` maps them to provider names.

### `account_link` — the one-time bonus

After a successful native link the client calls `account_link`:

```json
{ "provider": "google" }        // optional: must be one of the linked providers
```

- A body with `token` (the old contract) is rejected:
  `BAD_REQUEST`, `details.reason = "NATIVE_LINK_REQUIRED"`, whatever the
  token is. Nothing is linked or credited.
- No linked identity (or `provider` not linked) → `CONFLICT`,
  `details.reason = "NOT_LINKED"`, `details.providers`.
- Otherwise → `{ linked: true, providers, bonusClaimed, newBalance? }`.
  The 500-coin bonus (D4) is granted **once per account**: the
  `profile.accountLinkBonusClaimed` flag (CAS) and the coins are one
  wallet movement (`moveWallet`, durable key `accountLinkBonus:<userId>`),
  so concurrent calls pay once and a failure credits nothing.

---

## 2. Conflicts — both accounts prove themselves

A native link of an identity that already belongs to another account
fails with HTTP 409 (gRPC `AlreadyExists`, "… is already in use"). The
server cannot let account A delete account B just by asking, so the
flow needs a session of **each** account:

```
A (current session) ── LinkGoogleAsync(token) ──► 409 AlreadyExists
A's client ── AuthenticateGoogleAsync(token, create: false) ──► session of B
                                                       (Nakama verified the identity)
B session ── account_link_resolve_conflict { step: "open" }
          ◄── { conflictToken, expiresAt (+10 min), target: summary of B }
   UI: "B will be deleted: level N, X coins, Y gems" — confirm?
A session ── account_link_resolve_conflict { step: "resolve", conflictToken,
                                             choice: "link", confirmText: "TRANSFER" }
          ◄── { resolved: "linked", affectedAccountDeleted: true, relinkProviders: ["google"] }
A's client ── LinkGoogleAsync(token) ──► OK   (the identity is free now)
A session ── account_link {} ──► bonus (once)
```

- `step: "open"` (default `resolve`) is accepted only when the caller has
  a linked identity; it writes `account_link_conflict/<token>` (system
  owner) with the caller as **target** and its providers.
- `step: "resolve"`, `choice: "cancel"` drops the record (both accounts
  stay; the player may just keep using B's session).
- `choice: "link"` requires `confirmText: "TRANSFER"`, refuses a caller
  that is the target itself, re-checks that the target still exists and
  deletes it with the full account deletion of §3 (`deleteAccount`),
  which frees its identities for the re-link.
- Tokens are single use and expire after 10 minutes (`NOT_FOUND`).
- The target summary comes from the real account (profile + wallet);
  there is no placeholder account any more (audit 06 f12).

Analytics: `account_linked`, `account_link_conflict`,
`account_link_conflict_resolved` (system-owned rows).

---

## 3. Account delete

`account_delete { confirmText: "DELETE" }` (right to erasure; **not**
maintenance-gated). `account/delete.ts::deleteAccount`:

1. `removePlayerFromAll` marks the user abandoned in open race sessions
   (DNF at close). It skips the roster-less `last_closed/*` and report
   rows of `race_sessions` and pages the listing.
2. `purgeUserStorage` walks **every collection of the central registry**
   `core/collections.ts` (§4): deletes the objects the user owns, then
   applies each collection's rules for objects that name the user.
3. `purgeFromLeaderboards` removes the user's record from every Nakama
   leaderboard (3.27 `leaderboardList(limit 1-100, cursor)`; only boards
   holding a record count).
4. `nk.accountDeleteId(userId, false)`: Nakama deletes the account row
   (its identities, so they can be linked elsewhere) and cascades owned
   storage, friends (`user_edge`), group memberships (a group left
   without a superadmin is deleted), wallet ledger, notifications and
   leaderboard records.

Response:

```ts
{
  deletedAt: ISO-8601 string,
  summary: {
    storageDeleted: number,       // owned or keyed by the user
    collectionsAffected: string[],
    referencesRemoved: number,    // other owners' objects rewritten / deleted
    boardsDeleted: number,
    boardsAffected: string[],
    unlinkedAuths: string[],      // providers that were linked
    wasClubLeaderOf: string[],    // clubs the user created
    abandonedFromRaces: number,
  }
}
```

`account_deleted` is emitted (system-owned row) only after the delete
succeeded.

---

## 4. The collection registry

`core/collections.ts` lists every storage collection (60) with its
module, its owner (`user`, `system`, `mixed`) and its purge rules:

| Rule | Used by | Effect |
|---|---|---|
| (always) | every collection | delete the objects owned by the user |
| `systemKey` | `race_active`, `anti_cheat_marks`, `race_sessions` (`last_closed/<uid>`) | delete the system row keyed by the user |
| `systemKeySuffix` | `race_presence` (`<sid>/<uid>`) | delete the system rows ending with the user id |
| `keyIsUser` | `friends_edge`, `blocks` | delete other owners' rows keyed by the user (friend mirror edge, blocks of the user) |
| `valueField` | `invites.fromUserId`, `chat_history.senderUserId`, `account_link_conflict.targetUserId` | delete other owners' rows that name the user |
| `entries` | `recent_rivals`, `tournament_leaderboard` | remove the user's `{userId}` entries from other owners' lists |

Collections kept on purpose carry a `retained` reason (LiveOps config,
locks, season and tournament documents, per-race anti-cheat evidence,
moderation reports, IAP fraud flags, analytics audit rows, party
documents until the party disbands, club metadata owned by a deleted
leader — roster repair is T-21).

`tests/unit/collections_registry.test.ts` fails when a `*_COLLECTION`
constant or a literal collection name in `modules/src` is not in the
registry, so a new collection cannot be forgotten by the purge.

---

## 5. Production checklist

- Configure the providers in Nakama's `social.*` settings (`nakama.yml`
  / env), not in the runtime, for the platforms you ship (for example
  `social.apple.bundle_id`, `social.steam.publisher_key` and
  `social.steam.app_id`).
- Rate limiting of `account_link*` is not in v1.

---

## 6. Files

| Concern | File |
|---|---|
| Wire types | `account/types.ts` |
| Linked identities (`accountGetId`) | `account/identities.ts` |
| Bonus + conflict | `account/linking.ts` |
| Account deletion | `account/delete.ts` |
| Purge | `account/purge.ts` |
| Collection registry | `core/collections.ts` |
| RPCs | `account/rpcs.ts` |
