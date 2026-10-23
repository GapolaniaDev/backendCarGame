# Social — friend codes, invites, blocks, clubs, chat, moderation

This module bundles the cross-player surface shipped across Phase 7
Chunks 1, 2, 3, 4, 6, and 7. Parties live separately — see
[`parties.md`](./parties.md).

## Storage collections

| Collection | Owner | Read perm | Write perm | Shape | Source |
|---|---|---|---|---|---|
| `friends_code` | owner | owner | server | `{schemaVersion, userId, code, createdAt}` | Chunk 1 |
| `friends_code_index/{code}` | system | server | server | `{schemaVersion, code, userId}`: `friend_add_by_code` reads one key | T-22 |
| `friends_edge` | owner | owner | server | `{schemaVersion, userId, friendId, friendCode, since}` (one row per friendship edge; both written in one write) | Chunk 1 |
| `recent_rivals` | owner | owner | server | `{schemaVersion, userId, entries: [{userId, lastRaceAt, raceCount}]}` (cap 20) | Chunk 1 |
| `invites` | target | target | server | `~/.invites/types.ts:InviteRecord` (kind: group\|private_room, payload open dict) | Chunk 2 |
| `blocks` | owner | owner | server | `{schemaVersion, ownerId, targetId, createdAt}` | Chunk 2 |
| Nakama group `{clubId}` | leader (superadmin) | - | server only | CLOSED group: name, motto, `maxCount` 30; the roster enumerator and capacity guard | Chunk 3, T-21 |
| `clubs_metadata/{clubId}` | system | public | server | `{schemaVersion, clubId, leaderId, motto, emblemId, region, minDivision, weeklyPoints, createdAt}` | Chunk 3 |
| `clubs_members/current/{userId}` | owner | owner | server | `{schemaVersion, clubId, userId, role, joinedAt, weeklyContribution}`: ONE row per player (create-only = one club per player) | Chunk 4, T-21 |
| `clubs_created/{userId}` | owner | owner | server | lifetime counter (one club founded per player) | Chunk 3 |
| `club_week` (leaderboard) | - | - | server | weekly per-club points, owner = club id | Chunk 5 |
| `clubs_week_meta/{clubId}` | system | owner | server | which ISO week the club is scored in | Chunk 5 |
| `clubs_week_reset/{week}` | system | owner | server | global reset marker, claimed create-only before the weekly reward | Chunk 5 |
| `chat_channels/{channelId}` | system | server | server | `{schemaVersion, channelId, lastSeq}` | T-22 |
| `chat_history/{channelId}/{seq}` | system | server | server | one message per sequence number (zero-padded, 12 digits), 7-day retention filtered on read | Chunk 6, T-22 |
| `chat_silenced` | server | 2 | 0 | `{schemaVersion, userId, untilUtc, reason}` | Chunk 6/7 |
| `chat_blocked_words` | server | 2 | 0 | `{schemaVersion, lang, words: string[]}` | Chunk 6 |
| `reports/{reportId}` | server | server | server | `{schemaVersion, reportId, reporterUserId, targetUserId, reason, context, createdAt, status, triggeredSilence}` | Chunk 7 |
| `reports_recent/{userId}` | server | server | server | rolling last-24h reporter IDs (for auto-silence) | Chunk 7 |
| `reports_rate/{reporterUserId}` | server | server | server | per-reporter rate counter (5/hour) | Chunk 7 |

## RPC inventory (Phase 7 RPCs + `club_join`, plan T-21)

### Friend codes + recent rivals (Chunk 1)

| RPC | Auth | Returns |
|---|---|---|
| `friend_code_get` | owner | `{code, userId, createdAt}` |
| `friend_add_by_code` | owner | `{friendId, friendCode, since, mutual}` |
| `friend_list_get` | owner | `{items: [...], count}` |
| `friend_remove` | owner | `{removed: true}` |
| `recent_rivals_get` | owner | `{rivals: [...], count}` |

### Invites + blocks (Chunk 2)

| RPC | Auth | Returns |
|---|---|---|
| `invite_send` | owner | `{inviteId, delivered: 'online'\|'offline', expiresAt}` |
| `invite_list` | owner | `{items, count}` |
| `invite_respond` | owner | `{status, inviteId, partyId?}` — `partyId` set on accept when `payload.partyId` is present (Chunk 9) |
| `block_add` | owner | `{created: boolean}` |
| `block_remove` | owner | `{removed: boolean}` |
| `block_list` | owner | `{items, count}` |

### Clubs (Chunks 3-5)

| RPC | Auth | Returns |
|---|---|---|
| `club_create` | level 8 + 5000 coins, not in a club | `{clubId, name, costPaid, newBalance}` |
| `club_get` | any | `{club, members: [leader], weeklyRank}` |
| `club_search` | any | `{clubs, nextCursor}` (name prefix, region filter) |
| `club_join` | level 8, not in a club (T-21) | `{clubId, userId, role: 'member', joinedAt}` |
| `club_update` | leader / admin | `{clubId, updatedAt}` |
| `club_members_list` | any | `{members, nextCursor}` (offset cursor over leader, admins, members) |
| `club_kick` | leader / admin | `{removed, clubId, targetUserId}` |
| `club_promote` | leader | `{clubId, userId, role}` (`to`: `admin` \| `officer` \| `leader`) |
| `club_demote` | leader | `{clubId, userId, role}` (`to`: `member` \| `admin` \| `officer`) |
| `club_leave` | member (not the leader) | `{left, clubId, userId}` |

#### Membership model (plan T-21)

- A club is a **closed** Nakama group plus `clubs_metadata`. The roster is
  the group (`groupUsersList`, paged by the runtime cursor) joined with the
  members' rows `clubs_members/current/{userId}`: the row holds the
  authoritative role and weekly contribution; a group edge without a row
  of that club is not a member.
- **Joining** goes through `club_join` only. Rules: one club per player
  (the row is created with version `*`), room left (`groupUsersAdd` as the
  system user enforces `maxCount`), level 8 (no profile = level 1), the
  club's minimum division, and no block either way with the leader or an
  admin. Refusals: `CONFLICT` (`ALREADY_MEMBER`, `ALREADY_IN_CLUB`,
  `CLUB_FULL`) and `FORBIDDEN` (`BLOCKED`, `MIN_LEVEL`, `MIN_DIVISION`) in
  `details.reason`.
- The client group API cannot bypass this: `registerBeforeJoinGroup`
  evaluates the same rules and always answers 403 (naming the failing rule,
  or pointing to `club_join`); create / update / delete / leave / add /
  kick / ban / promote / demote group calls answer 403 too.
- `club_create` charges the 5000 coins in the same transaction that writes
  the metadata, the lifetime counter and the leader's row; a failed charge
  deletes the group.
- A leader transfer moves the group superadmin along with the role.
- **Account deletion** first releases the club: a leader hands it to the
  oldest admin (else the oldest member); a club left empty is dissolved
  (metadata, week meta and group deleted). A party member leaves the party
  (a leader hands it to the oldest member).

### Chat (Chunk 6)

| RPC | Auth | Returns |
|---|---|---|
| `chat_send` | club member / friend | `{messageId, ts, channelId}` (gated by rate, length, blocked words, silence, access and blocks) |
| `chat_list` | club member / friend | `{messages, nextCursor}` (newest first, NOT maintenance-gated) |

#### Chat rules (plan T-22)

- A blocked word answers **`CONTENT_REJECTED`** (the code the Unity chat
  adapter maps to `ChatError.Rejected`).
- A direct message needs friendship and **no block either way**
  (`checkChatSendBlock`): `FORBIDDEN` with `details.reason = 'BLOCKED'`.
- A club history hides the messages of senders that have a block with the
  reader.
- History: each channel numbers its messages (`chat_channels` head + one
  `chat_history` row per number, written in one storage write). A page is
  one batched read of `limit` keys (default 50, max 100); `nextCursor` is
  the next number, `''` at the end; a malformed cursor is `BAD_REQUEST`.
- `senderName` is the account username (`usersGetId`; 3.27 nests it under
  `accountGetId(...).user`).

#### Friend codes and blocks (plan T-22)

- `friend_add_by_code` resolves the code with one index read
  (`friends_code_index`), confirmed against the owner's code row; codes
  written before the index are found by a scan that follows the runtime
  cursor over every page, and then indexed.
- A block either way makes `friend_add_by_code` answer `NOT_FOUND` (the
  block is not revealed); both friendship edges are written in one write.

### Moderation (Chunk 7)

| RPC | Auth | Returns |
|---|---|---|
| `report_player` | owner | `{reportId, silenced, untilUtc?, distinctCount, triggeredSilence}` |
| `admin_view_reports` | adminKey | `{reports, count}` (bypasses maintenance) |
| `admin_silence` | adminKey | `{silenced: true, untilUtc}` (bypasses maintenance) |
| `admin_unsilence` | adminKey | `{silenced: false, untilUtc: 0}` (bypasses maintenance, lazy clear preserves audit) |

## Decisions locked (D-locks from Phase 7)

| # | Decision |
|---|---|
| D1 | Invite TTL = 24h |
| D2 | Self-invite → BAD_REQUEST |
| D3 | Either-side block → FORBIDDEN on invite + party_invite |
| D4 | Status transitions: `pending → accepted/declined/expired` (lazy) |
| D5 | Invite ID via `nk.uuidv4()` |
| D6 | Friend code 8 chars, 31-char alphabet, salted (`cv-friend-code-v1`) |
| D7 | Friend edges mutual (both sides stored as separate rows) |
| D8 | Per-reporter rate: 5 reports/hour |
| D9 | Auto-silence = 3 distinct reporters in 24h → 1h silence (max-of extension) |
| D10 | Reports anonymous to targets; only `admin_view_reports` exposes `reporterUserId` |
| D11 | `admin_unsilence` writes `untilUtc=0` (lazy clear, preserves audit) |
| D12 | Chat rate: 1 msg/sec + 20/min per user; 200 char cap; 7-day history TTL |
| D13 | Chat blocked words: multi-lang (es/en/pt) + leet-normalized; 3 reports in 24h → 1h chat-only silence |
| D14 | Storage-based parties (3.27 JS lacks party API — see `parties.md`) |
| D15 | `PARTY_MAX_SIZE = 6`, maxSize ∈ {2, 4, 6}, default 4 |

## Rate limits

| RPC | Limit |
|---|---|
| `friend_code_get` | 30/min |
| `friend_add_by_code` | 10/min |
| `friend_list_get` | 30/min |
| `friend_remove` | 30/min |
| `recent_rivals_get` | 30/min |
| `invite_send` | 10/min |
| `invite_list` | 30/min |
| `invite_respond` | 30/min |
| `block_add` | 30/min |
| `block_remove` | 30/min |
| `block_list` | 30/min |
| `club_create` | 5/min |
| `club_get` | 60/min |
| `club_search` | 30/min |
| `club_join` | 10/min |
| `club_update` | 30/min |
| `club_members_list` | 60/min |
| `club_kick` | 10/min |
| `club_promote` / `club_demote` | 10/min |
| `club_leave` | 10/min |
| `chat_send` | 1/sec + 20/min, and 30/min per RPC |
| `chat_list` | 60/min |
| `report_player` | 30/min RPC + 5/hour per reporter |
| `admin_*` (RPC) | 30/min |
| `party_*` | 30/min |

## Nakama 3.27 notes

1. **Presence and push are out of scope** (plan P-03): online invite push
   always returns `delivered: 'offline'`; clients poll `invite_list`.
2. **Group hooks exist** (`registerBeforeJoinGroup`,
   `registerBeforeAddGroupUsers`, ..., verified in v3.27.0
   `runtime_javascript_init.go`): they guard the client group API (T-21).
   Group runtime signatures (v3.27.0 `runtime_javascript_nakama.go`):
   `groupCreate(userId, name, creatorId, langTag, description, avatarUrl,
   open, metadata, maxCount)`, `groupsList(name ILIKE, langTag, open,
   edgeCount, limit 1-100, cursor) -> {groups, cursor}`; groups carry `id`.
3. **Club weekly reset is lazy** on the first `club_get`/`club_search` after
   Monday. The `clubs_week_reset` marker is claimed create-only before the
   weekly reward (a claimable `sendReward`, id `club_week:<week>:<userId>`).
4. **Chat is RPC-only**: `validateChatSend` runs inside `chat_send` before
   the history write (no native channel is used).

## Hooks (server-emitted events)

| Event name | Emitted from |
|---|---|
| `friend_added` | `friend_add_by_code` |
| `friend_removed` | `friend_remove` |
| `invite_sent` | `invite_send` |
| `invite_responded` | `invite_respond` |
| `block_added` / `block_removed` | `block_add` / `block_remove` |
| `club_created` / `club_joined` / `club_updated` / `club_kicked` / `club_promoted` / `club_demoted` / `club_left` | Clubs RPCs |
| `club_week_rewarded` | weekly-reset subscriber |
| `chat_sent` | `chat_send` |
| `chat_silenced` / `chat_unsilenced` | auto-silence / `admin_unsilence` |
| `report_filed` | `report_player` |
| `admin_action` | every admin RPC (Phase 5 D7) |