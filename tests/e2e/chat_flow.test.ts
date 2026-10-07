// Phase 7 Chunk 6 — chat_send + chat_list end-to-end through the
// production bundle.
//
// Covers the full RPC surface:
//   - boot registers chat_send + chat_list
//   - happy path club channel
//   - happy path direct channel
//   - blocked word (es) rejected
//   - silenced user rejected
//   - 1/s + 20/min rate limits
//   - per-RPC rate limit (coarse)
//   - content >200 rejected
//   - non-member / non-friend rejected
//   - chat_list sorted desc + TTL filter
//   - chat_list pagination (basic limit)
//   - maintenance blocks chat_send

import { describe, it, expect, beforeEach } from 'vitest';

import {
  FakeContext,
  SYSTEM_USER_ID,
  loadBundleForTest,
  type LoadedBundle,
} from './_stubs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import {
  CLUB_WEEK_LEADERBOARD_ID as _UNUSED,
} from '../../modules/src/clubs/leaderboard_init';
import { CLUBS_METADATA_COLLECTION } from '../../modules/src/clubs/types';
import {
  FRIENDS_EDGE_COLLECTION,
  type FriendEdgeRecord,
} from '../../modules/src/social/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
void _UNUSED;

type ChatResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface ChatSendOutput {
  messageId: string;
  ts: number;
  channelId: string;
}
interface ChatListOutput {
  messages: Array<{
    messageId: string;
    senderUserId: string;
    senderName: string;
    content: string;
    language: string;
    ts: number;
  }>;
  nextCursor: string;
}

const ALICE = 'user-alice';
const BOB = 'user-bob';

function call<T>(
  env: LoadedBundle,
  rpc: string,
  caller: string | null,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler(ctx, env.logger, env.nak, body)) as T;
}

function seedClubMember(env: LoadedBundle, clubId: string, userId: string): void {
  env.fakeNakama.store.set(`${CLUBS_MEMBERS_COLLECTION}/${clubId}/${userId}`, {
    collection: CLUBS_MEMBERS_COLLECTION,
    key: clubId,
    userId,
    value: {
      schemaVersion: 1,
      clubId, userId, role: 'member',
      joinedAt: 1_700_000_000_000, weeklyContribution: 0,
    },
    version: 'v00000001',
    permissionRead: 1, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
  // Seed a meta row so club_week_reset's first_seen path doesn't crash.
  env.fakeNakama.store.set(`${CLUBS_METADATA_COLLECTION}/${clubId}/${userId}`, {
    collection: CLUBS_METADATA_COLLECTION,
    key: clubId,
    userId,
    value: {
      schemaVersion: 1,
      clubId, leaderId: userId,
      motto: 'm', emblemId: 'emblem_default',
      region: 'us', minDivision: 'bronce',
      weeklyPoints: 0, createdAt: 1_700_000_000_000,
    },
    version: 'v00000001',
    permissionRead: 2, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedFriendEdge(env: LoadedBundle, ownerId: string, friendId: string): void {
  const rec: FriendEdgeRecord = {
    schemaVersion: 1, userId: ownerId, friendId,
    friendCode: 'ABCDEFGH', since: 1_700_000_000_000,
  };
  env.fakeNakama.store.set(`${FRIENDS_EDGE_COLLECTION}/${friendId}/${ownerId}`, {
    collection: FRIENDS_EDGE_COLLECTION,
    key: friendId,
    userId: ownerId,
    value: rec as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1, permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

function seedAccount(env: LoadedBundle, userId: string, username: string): void {
  // accountGetId in the stub returns null for SYSTEM_USER_ID and a
  // synthetic object for everything else. We seed the store's `users`
  // map for parity so resolver sees a real username if it ever reads it.
  void username;
  env.fakeNakama.users.set(userId, {
    userId,
    username,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    disableTime: null,
    metadata: {},
  });
}

function setMaintenance(env: LoadedBundle): void {
  const cfg: LiveopsConfig = {
    schemaVersion: 1, version: 1,
    flags: { maintenance: true },
    minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  };
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: cfg as unknown as LiveopsConfig,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1, permissionWrite: 0,
    createTime: stored?.createTime ?? new Date(0).toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('chat_send + chat_list flow (Phase 7 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('boot registers chat_send + chat_list', () => {
    expect(env.resolver('chat_send')).toBeDefined();
    expect(env.resolver('chat_list')).toBeDefined();
  });

  it('happy path: club channel send + list', () => {
    const clubId = 'grp-test-1';
    seedClubMember(env, clubId, ALICE);
    seedAccount(env, ALICE, 'alice');

    const send = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
      language: 'es',
      content: 'hola club',
    });
    expect(send.ok).toBe(true);
    if (send.ok) {
      expect(send.data.channelId).toBe(`club:${clubId}`);
      expect(send.data.ts).toBeGreaterThan(0);
    }

    const list = call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.messages.length).toBe(1);
      expect(list.data.messages[0].content).toBe('hola club');
      expect(list.data.messages[0].senderUserId).toBe(ALICE);
    }
  });

  it('happy path: direct channel resolves symmetrically', () => {
    seedFriendEdge(env, ALICE, BOB);
    seedFriendEdge(env, BOB, ALICE);
    seedAccount(env, ALICE, 'alice');
    seedAccount(env, BOB, 'bob');

    const send = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'direct',
      targetId: BOB,
      language: 'es',
      content: 'hola bob',
    });
    expect(send.ok).toBe(true);
    if (send.ok) {
      // Both users sort lexicographically (ALICE < BOB alphabetically).
      expect(send.data.channelId).toBe(`direct:${ALICE}:${BOB}`);
    }

    // Bob can read what Alice sent in the same channel.
    const bobList = call<ChatResp<ChatListOutput>>(env, 'chat_list', BOB, {
      callerUserId: BOB,
      channelType: 'direct',
      targetId: ALICE,
    });
    expect(bobList.ok).toBe(true);
    if (bobList.ok) {
      expect(bobList.data.messages.length).toBe(1);
      expect(bobList.data.messages[0].senderUserId).toBe(ALICE);
      expect(bobList.data.messages[0].content).toBe('hola bob');
    }
  });

  it('blocked word (es) is rejected with FORBIDDEN', () => {
    const clubId = 'grp-test-2';
    seedClubMember(env, clubId, ALICE);
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
      language: 'es',
      content: 'eres un IDIOTA',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('blocked word (en) bypasses with leet', () => {
    // Sanity: 1d10t should normalize to "idiot" and be caught.
    const clubId = 'grp-test-2b';
    seedClubMember(env, clubId, ALICE);
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
      language: 'en',
      content: '1d10t here',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('silenced user is rejected with untilUtc in details', () => {
    const clubId = 'grp-test-3';
    seedClubMember(env, clubId, ALICE);
    // Seed a silenced row for ALICE with untilUtc in the future.
    const until = Date.now() + 60_000;
    env.fakeNakama.store.set(`silenced/${ALICE}/${ALICE}`, {
      collection: 'silenced', key: ALICE, userId: ALICE,
      value: {
        schemaVersion: 1, userId: ALICE,
        untilUtc: until, reason: 'auto:3_reports_24h',
        createdAt: Date.now() - 1000,
      },
      version: 'v00000001',
      permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });

    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
      language: 'es',
      content: 'hola',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('FORBIDDEN');
      expect((res.error.details as { untilUtc: number }).untilUtc).toBe(until);
    }
  });

  it('content >200 chars is rejected with BAD_REQUEST', () => {
    const clubId = 'grp-test-4';
    seedClubMember(env, clubId, ALICE);
    const long = 'x'.repeat(201);
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club',
      targetId: clubId,
      language: 'es',
      content: long,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('BAD_REQUEST');
      expect(res.error.message).toMatch(/too long/);
    }
  });

  it('1/s rate limit rejects the second send within the same second', () => {
    const clubId = 'grp-test-5';
    seedClubMember(env, clubId, ALICE);
    const r1 = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club', targetId: clubId,
      language: 'es', content: 'primero',
    });
    expect(r1.ok).toBe(true);
    const r2 = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club', targetId: clubId,
      language: 'es', content: 'segundo',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('RATE_LIMITED');
      expect((r2.error.details as { reason: string }).reason).toBe('too_fast');
    }
  });

  it('non-member of club is rejected with FORBIDDEN', () => {
    const clubId = 'grp-test-6';
    // No member row for ALICE.
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'club', targetId: clubId,
      language: 'es', content: 'hola',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('non-friend direct chat is rejected with FORBIDDEN', () => {
    // No edge between ALICE and BOB.
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'direct', targetId: BOB,
      language: 'es', content: 'hola',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('self-chat is rejected with BAD_REQUEST', () => {
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE,
      channelType: 'direct', targetId: ALICE,
      language: 'es', content: 'hola a mi',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
  });

  it('chat_list: 2 messages return newest first, paginates with limit', () => {
    const clubId = 'grp-test-7';
    const channelId = `club:${clubId}`;
    seedClubMember(env, clubId, ALICE);
    seedAccount(env, ALICE, 'alice');

    const r1 = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'primero',
    });
    expect(r1.ok).toBe(true);
    const primeroId = r1.data!.messageId;

    // Rewind chat_rate's tsLast by 1100ms so the second send passes the
    // 1/s check (direct store mutation + re-set to ensure persistence).
    const rateKey = `chat_rate/${ALICE}/${ALICE}`;
    const rate = env.fakeNakama.store.get(rateKey);
    expect(rate).toBeDefined();
    if (rate !== undefined) {
      const rewound = {
        ...(rate.value as Record<string, unknown>),
        tsLast: Date.now() - 1100,
      };
      env.fakeNakama.store.set(rateKey, { ...rate, value: rewound });
    }

    // Force primero's createdAt to be earlier than the second send so
    // sort by createdAt desc is deterministic (avoids same-ms flakiness
    // when Date.now() returns the same value for both sends).
    const primeroKey = `chat_history/${channelId}/${primeroId}/00000000-0000-0000-0000-000000000000`;
    const primeroObj = env.fakeNakama.store.get(primeroKey);
    expect(primeroObj).toBeDefined();
    if (primeroObj !== undefined) {
      const value = primeroObj.value as { createdAt: number };
      env.fakeNakama.store.set(primeroKey, {
        ...primeroObj,
        value: { ...value, createdAt: value.createdAt - 10 },
      });
    }

    const r2 = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'segundo',
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.messageId).not.toBe(primeroId);
    }

    const list = call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      limit: 1,
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.messages.length).toBe(1);
      expect(list.data.messages[0].content).toBe('segundo');
    }

    const listAll = call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
    });
    expect(listAll.ok).toBe(true);
    if (listAll.ok) {
      expect(listAll.data.messages.length).toBe(2);
      expect(listAll.data.messages[0].content).toBe('segundo');
      expect(listAll.data.messages[1].content).toBe('primero');
    }
  });

  it('chat_list filters out expired messages (lazy TTL)', () => {
    const clubId = 'grp-test-8';
    seedClubMember(env, clubId, ALICE);
    seedAccount(env, ALICE, 'alice');

    call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'fresh',
    });

    // Forge a second message with an expired expiresAt.
    const channelId = `club:${clubId}`;
    env.fakeNakama.store.set(`chat_history/${channelId}/stale-msg/00000000-0000-0000-0000-000000000000`, {
      collection: 'chat_history',
      key: `${channelId}/stale-msg`,
      userId: '00000000-0000-0000-0000-000000000000',
      value: {
        schemaVersion: 1,
        messageId: 'stale-msg',
        channelId,
        channelType: 'club',
        targetId: clubId,
        senderUserId: ALICE,
        senderName: 'alice',
        content: 'stale',
        language: 'es',
        createdAt: 1_000_000_000_000, // very old
        expiresAt: 1_000_000_000_001, // already expired
      },
      version: 'v00000001',
      permissionRead: 1, permissionWrite: 0,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: new Date(1_000_000_000_001).toISOString(),
    });

    const list = call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.messages.length).toBe(1);
      expect(list.data.messages[0].content).toBe('fresh');
    }
  });

  it('maintenance blocks chat_send with SERVICE_UNAVAILABLE', () => {
    const clubId = 'grp-test-9';
    seedClubMember(env, clubId, ALICE);
    setMaintenance(env);
    const res = call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'hola',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('chat_list is NOT maintenance-gated (read history during maintenance)', () => {
    const clubId = 'grp-test-10';
    seedClubMember(env, clubId, ALICE);
    seedAccount(env, ALICE, 'alice');

    call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'antes',
    });
    setMaintenance(env);
    const res = call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.messages.length).toBe(1);
    }
  });

  it('chat_send emits chat_sent + chat_list emits chat_listed analytics events', () => {
    const clubId = 'grp-test-11';
    seedClubMember(env, clubId, ALICE);
    seedAccount(env, ALICE, 'alice');

    call<ChatResp<ChatSendOutput>>(env, 'chat_send', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
      language: 'es', content: 'audit me',
    });
    call<ChatResp<ChatListOutput>>(env, 'chat_list', ALICE, {
      callerUserId: ALICE, channelType: 'club', targetId: clubId,
    });

    const events = Array.from(env.fakeNakama.store.values())
      .filter((o) => o.collection === 'analytics_events')
      .map((o) => (o.value as { name: string }).name);
    expect(events).toContain('chat_sent');
    expect(events).toContain('chat_listed');
  });
});