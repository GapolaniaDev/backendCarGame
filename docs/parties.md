# Parties — matchmaker grouping + storage-based roster

Phase 7 Chunk 8 + Chunk 9 ship a complete party + matchmaker
integration. Parties are intentionally NOT implemented via the Nakama
party API (`registerParty`, `partyCreate`, etc.) because the JS runtime
in Nakama 3.27 does not expose those bindings. We use plain storage
with the pattern documented below.

## Storage collections

| Collection | Owner | Read perm | Write perm | Shape |
|---|---|---|---|---|
| `parties` | `00000000-0000-0000-0000-000000000000` (system) | 1 (public) | 1 (server) | `{schemaVersion, partyId, leaderUserId, maxSize, state, createdAt, members: [{userId, joinedAt}]}` |
| `active_party` | per-user | 1 | 1 | `{schemaVersion, userId, partyId, joinedAt}` (inverse index user→party) |

The system-sentinel user for `parties` keys keeps the storage layer
single-row-per-party; the inverse `active_party` index lets each user
discover their current party in O(1).

## Why storage-based (not Nakama party API)

Nakama 3.27's JS runtime (goja) lacks the party surface:

- `registerParty`
- `partyCreate` / `partyUpdate` / `partyJoin` / `partyLeave` / `partyPromote` / `partyKick`
- `partyList` / `partyIdFromLabel`
- `registerBefore/AfterJoinParty`, `registerBefore/AfterLeaveParty`, `registerBefore/AfterCreateParty`, `registerMatchmakerPartyAdd`, `registerMatchmakerPartyRemove`

Verified against `modules/src/nkruntime.d.ts` (no party methods
present). Sticking to storage keeps the chunk small and matches the
existing clubs pattern.

## RPC inventory (6 RPCs)

| RPC | Auth | Gated | Returns |
|---|---|---|---|
| `party_create` | owner | YES (maintenance + rate 30/min) | `{partyId, leaderUserId, maxSize, state, createdAt, members[]}` |
| `party_invite` | leader | YES | `{inviteId, expiresAt, partyId, targetUserId}` — delegates to `invites_repo.writeInviteCreate(kind='group')` with payload `{partyId, partyMaxSize}` |
| `party_join` | owner | YES | `{party, partyId, joinedAt}` — CAS-update roster + write `active_party` (Chunk 9 fix) |
| `party_leave` | member | YES | `{left: true, disbanded}` — leader-with-members → FORBIDDEN |
| `party_kick` | leader | YES | `{kicked: true, partyId, targetUserId}` — leader-only |
| `party_get` | member | NO (read-only) | `{party: {partyId, leaderUserId, maxSize, state, createdAt, members[]}}` |

## Matchmaker integration (`mm_ticket_params`)

When the party leader calls `mm_ticket_params`, they pass an optional
`partyId`. The RPC:

1. Resolves the party via `parties_repo.readParty`.
2. Validates: caller is leader, party is `state: 'open'`, members ≥ 1.
3. Reads the leader's `RankedRecord` rating (server-only).
4. Stamps into the ticket metadata:
   - `metadata.partyId = party.partyId`
   - `metadata.partySize = String(party.members.length)`
5. Sets `rating` to the leader's rating (matchmaker band uses the
   leader's rating as the ceiling — every party member must arrive in
   the matched set or the hook rejects it).

When `partyId` is absent, `mm_ticket_params` keeps the Phase 4 behavior
(individual rating + region + version stamping).

## Matchmaker matched-hook grouping

`modules/src/matchmaking/matched_hook.ts` runs `validatePartyGrouping`
after the size/duration checks. The rule:

> If any matched entry has `vars.partyId`, every matched entry must
> share the same partyId AND the matched count must equal the
> party's declared size (from `vars.partySize`).

Rejections:

- **party split**: matched entries carry different `partyId` values
  (the matchmaker split a single party across multiple sessions).
- **party partial**: matched count differs from `partySize`
  (some party members didn't arrive).

The matchmaker retries with the unsplit tickets queued.

## Invites ↔ parties wire-up (Chunk 9 fix)

`party_invite` writes an `InviteRecord` with `kind: 'group'` and
`payload: { partyId, partyMaxSize }`. The receiving user calls
`invite_respond(accept=true)`, which:

1. CAS-updates the invite to `status: 'accepted'`.
2. If `kind === 'group'` and `payload.partyId` is a non-empty string,
   calls `parties_repo.joinParty(callerId, partyId)`.
3. On success, the response includes `partyId` as a side-effect hint.

A standalone `party_join` RPC is also exposed for clients that want to
join a party without going through invites (rare — kept for tests).

## Decisions locked

| # | Decision |
|---|---|
| D14 | Storage-based parties (3.27 JS lacks `registerParty*` API) |
| D15 | `PARTY_MAX_SIZE = 6`, maxSize ∈ {2, 4, 6}, default 4 |
| D16 | Leader-only kick + invite; non-leader leave always OK; leader alone → disband |
| D17 | Party size honored in matchmaker grouping (rejects splits + partials) |
| D18 | `invite_respond(accept=true)` on `kind='group'` calls `joinParty`; errors do NOT undo the invite acceptance |

## Storage writes (per RPC)

| RPC | Writes |
|---|---|
| `party_create` | `parties/{partyId}` (system) + `active_party/{callerId}` (owner) |
| `party_invite` | `invites/{inviteId}` (target-owned) — does NOT touch parties |
| `party_join` | `parties/{partyId}` (system) CAS-update + `active_party/{callerId}` (owner) |
| `party_leave` | `parties/{partyId}` (system) CAS-update or delete (if empty); `active_party/{callerId}` delete |
| `party_kick` | `parties/{partyId}` (system) CAS-update; `active_party/{targetUserId}` delete |
| `party_get` | read-only |

All CAS updates retry up to `MAX_CAS_RETRIES = 3` before surfacing
`INTERNAL`.

## Analytics events

| Event name | Fired by |
|---|---|
| `party_created` | `party_create` |
| `party_invite_sent` | `party_invite` |
| `party_joined` | `party_join` (and `invite_respond` accept with party) |
| `party_left` | `party_leave` |
| `party_kicked` | `party_kick` |

## Known limitations

- **No party transfer** — leader can't hand leadership to another
  member. Leader must kick all + the next member calls `party_create`
  to become a new leader. (Future chunk.)
- **No presence** — Nakama 3.27 JS lacks `nk.socketSend`, so party
  updates don't push to members in real time. Clients poll
  `party_get` after their own actions.
- **Single-server constraint** — storage-based parties don't span
  multiple Nakama nodes naturally. The 3.27 JS runtime can't bind
  `partyIdFromLabel` or register a global party ID map.