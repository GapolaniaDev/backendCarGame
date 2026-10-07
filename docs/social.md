# Social — friend codes, invites, blocks, clubs, chat, moderation

This module bundles the cross-player surface shipped across Phase 7
Chunks 1, 2, 3, 4, 6, and 7. Parties live separately — see
[`parties.md`](./parties.md).

## Storage collections

| Collection | Owner | Read perm | Write perm | Shape | Source |
|---|---|---|---|---|---|
| `friend_codes` | owner | owner | server | `{schemaVersion, userId, code, createdAt}` | Chunk 1 |
| `friend_edges` | owner | owner | server | `{schemaVersion, userId, friendId, friendCode, since}` (one row per friendship edge) | Chunk 1 |
| `recent_rivals` | owner | owner | server | `{schemaVersion, userId, entries: [{userId, lastRaceAt, raceCount}]}` (cap 20) | Chunk 1 |
| `invites` | target | target | server | `~/.invites/types.ts:InviteRecord` (kind: group\|private_room, payload open dict) | Chunk 2 |
| `blocks` | owner | owner | server | `{schemaVersion, ownerId, targetId, createdAt}` | Chunk 2 |
| `clubs/{clubId}` (Nakama group) | server | public | server | Nakama native + emblems metadata | Chunk 3 |
| `clubs_members/{clubId}` | server | public | server | `{schemaVersion, clubId, members: [{userId, role, joinedAt}]}` | Chunk 4 |
| `clubs_emitted` | system | public | server | `{schemaVersion, clubId, kind, ts, props}` (event bus mirror) | Chunk 3 |
| `clubs_week_points` | system | public | server | weekly per-club points leaderboard mirror | Chunk 5 |
| `clubs_week_reset` | system | public | server | lazy reset marker (3.27 JS lacks `registerLeaderboardReset`) | Chunk 5 |
| `chat_history/{channel}/{targetId}` | server | 2 (public read) | 0 (server-only) | ring buffer, 7-day TTL | Chunk 6 |
| `chat_silenced` | server | 2 | 0 | `{schemaVersion, userId, untilUtc, reason}` | Chunk 6/7 |
| `chat_blocked_words` | server | 2 | 0 | `{schemaVersion, lang, words: string[]}` | Chunk 6 |
| `reports/{reportId}` | server | server | server | `{schemaVersion, reportId, reporterUserId, targetUserId, reason, context, createdAt, status, triggeredSilence}` | Chunk 7 |
| `reports_recent/{userId}` | server | server | server | rolling last-24h reporter IDs (for auto-silence) | Chunk 7 |
| `reports_rate/{reporterUserId}` | server | server | server | per-reporter rate counter (5/hour) | Chunk 7 |

## RPC inventory (26 Phase 7 RPCs + 1 from Chunk 9)

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
| `club_create` | owner + level 8 + 5000 coins | `{clubId, costCoins, balanceAfter}` |
| `club_get` | owner | `{club: {clubId, name, emblemId, motto, ...}}` |
| `club_search` | owner | `{items, count}` |
| `club_update` | leader | `{updated: true}` |
| `club_members_list` | owner | `{members, nextCursor}` |
| `club_kick` | leader | `{kicked: true}` |
| `club_promote` | leader | `{promoted: true, role: 'admin'}` |
| `club_demote` | leader | `{demoted: true, role: 'member'}` |
| `club_leave` | member | `{left: true}` |

### Chat (Chunk 6)

| RPC | Auth | Returns |
|---|---|---|
| `chat_send` | owner | `{messageId, sentAt}` (gated by silence + rate + blocked words) |
| `chat_list` | owner | `{items, count}` (read-only, NOT maintenance-gated) |

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
| `club_update` | 30/min |
| `club_members_list` | 30/min |
| `club_kick` | 30/min |
| `club_promote` / `club_demote` | 30/min |
| `club_leave` | 30/min |
| `chat_send` | 1/sec + 20/min |
| `chat_list` | 30/min |
| `report_player` | 30/min RPC + 5/hour per reporter |
| `admin_*` (RPC) | 30/min |
| `party_*` | 30/min |

## Known Nakama 3.27 JS runtime gaps (4 documented)

1. **`nk.socketSend` missing** → online invite push always returns
   `delivered: 'offline'`. Clients poll `invite_list` for inbox.
2. **`registerBeforeAddGroupUsers` missing** → `checkClubJoinGate` is a
   pure helper called inside the runtime hook path. Not enforced at
   the runtime layer today.
3. **`registerLeaderboardReset` missing** → club weekly reset is lazy on
   the first `club_get`/`club_search` after Monday. A
   `clubs_week_reset` global marker prevents double-send across
   multi-club fan-out.
4. **`registerBeforeSendChannelMessage` missing** → `validateChatSend`
   is called synchronously from the `chat_send` RPC. Blocked-word +
   rate + silence checks fire before the chat_history write.

## Hooks (server-emitted events)

| Event name | Emitted from |
|---|---|
| `friend_added` | `friend_add_by_code` |
| `friend_removed` | `friend_remove` |
| `invite_sent` | `invite_send` |
| `invite_responded` | `invite_respond` |
| `block_added` / `block_removed` | `block_add` / `block_remove` |
| `club_created` / `club_updated` / `club_kicked` / `club_promoted` / `club_demoted` / `club_left` | Clubs RPCs |
| `club_week_rewarded` | weekly-reset subscriber |
| `chat_sent` | `chat_send` |
| `chat_silenced` / `chat_unsilenced` | auto-silence / `admin_unsilence` |
| `report_filed` | `report_player` |
| `admin_action` | every admin RPC (Phase 5 D7) |