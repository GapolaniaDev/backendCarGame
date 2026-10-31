// Plan T-22 — blocks, searches and chat moderation (Soc-3, Soc-4, HT-83;
// audit 07 f3, f18).
//
//   - a block (either way) stops direct chat and friend_add_by_code;
//   - a club history hides the messages of blocked senders;
//   - the friend-code lookup reaches codes past the first 1000 rows;
//   - chat messages carry the account username (3.27 `.user.username`);
//   - a malformed chat cursor is a BAD_REQUEST.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest } from './_stubs';
import type { LoadedBundle } from './_stubs';
import { CLUBS_MEMBERS_COLLECTION } from '../../modules/src/clubs/members_repo';
import { PROFILES_COLLECTION } from '../../modules/src/profiles/storage';
import { FRIENDS_CODE_COLLECTION, FRIENDS_CODE_INDEX_COLLECTION } from '../../modules/src/social/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: { reason?: string } } };

interface ChatList { messages: Array<{ senderUserId: string; senderName: string; senderDisplayName: string; content: string }>; nextCursor: string }

const A = 'user-a';
const B = 'user-b';
const C = 'user-c';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as T;
}

function code(env: LoadedBundle, userId: string): string {
  const r = call<Resp<{ code: string }>>(env, 'friend_code_get', userId, {});
  if (!r.ok) throw new Error('friend_code_get failed');
  return r.data.code;
}

function befriend(env: LoadedBundle, x: string, y: string): void {
  const r = call<Resp<unknown>>(env, 'friend_add_by_code', x, { code: code(env, y) });
  if (!r.ok) throw new Error(`friend_add_by_code failed: ${JSON.stringify(r)}`);
}

function dm(env: LoadedBundle, from: string, to: string, content: string): Resp<unknown> {
  return call<Resp<unknown>>(env, 'chat_send', from, { channelType: 'direct', targetId: to, language: 'es', content });
}

function seedClubMember(env: LoadedBundle, clubId: string, userId: string): void {
  env.fakeNakama.store.set(`${CLUBS_MEMBERS_COLLECTION}/current/${userId}`, {
    collection: CLUBS_MEMBERS_COLLECTION, key: 'current', userId,
    value: { schemaVersion: 1, clubId, userId, role: 'member', joinedAt: 1, weeklyContribution: 0 },
    version: 'v1', permissionRead: 1, permissionWrite: 0,
    createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
  });
  if (!env.fakeNakama.groups.has(clubId)) {
    env.fakeNakama.groups.set(clubId, {
      id: clubId, creatorId: userId, name: clubId, description: '', avatarUrl: '', langTag: 'es',
      metadata: {}, open: false, edgeCount: 0, maxCount: 30, createTime: 0, updateTime: 0,
    });
    env.fakeNakama.groupMembers.set(clubId, new Set());
    env.fakeNakama.groupStates.set(clubId, new Map());
  }
  env.fakeNakama.groupMembers.get(clubId)!.add(userId);
  env.fakeNakama.groupStates.get(clubId)!.set(userId, 2);
}

/** The chat 1/s limit: move the caller's last send back in time. */
function rewindChatRate(env: LoadedBundle, userId: string): void {
  const key = `chat_rate/${userId}/${userId}`;
  const row = env.fakeNakama.store.get(key);
  if (row !== undefined) env.fakeNakama.store.set(key, { ...row, value: { ...(row.value as Record<string, unknown>), tsLast: 0 } });
}

describe('blocks, searches and chat (plan T-22)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('a block either way stops direct chat', () => {
    befriend(env, A, B);
    expect(dm(env, A, B, 'hola').ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'block_add', B, { targetUserId: A }).ok).toBe(true);
    rewindChatRate(env, A);
    const fromA = dm(env, A, B, 'otra vez');
    expect(fromA.ok).toBe(false);
    if (!fromA.ok) {
      expect(fromA.error.code).toBe('FORBIDDEN');
      expect(fromA.error.details?.reason).toBe('BLOCKED');
    }
    const fromB = dm(env, B, A, 'adios');
    expect(fromB.ok).toBe(false);
    if (!fromB.ok) expect(fromB.error.details?.reason).toBe('BLOCKED');
  });

  it('a blocked player cannot add by code (NOT_FOUND, no edges)', () => {
    expect(call<Resp<unknown>>(env, 'block_add', A, { targetUserId: B }).ok).toBe(true);
    const r = call<Resp<unknown>>(env, 'friend_add_by_code', B, { code: code(env, A) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    expect(env.fakeNakama.store.has(`friends_edge/${A}/${B}`)).toBe(false);
    expect(env.fakeNakama.store.has(`friends_edge/${B}/${A}`)).toBe(false);
    // ... and once unblocked the add works.
    expect(call<Resp<unknown>>(env, 'block_remove', A, { targetUserId: B }).ok).toBe(true);
    expect(call<Resp<unknown>>(env, 'friend_add_by_code', B, { code: code(env, A) }).ok).toBe(true);
  });

  it('friend codes past the first 1000 rows are found (and then indexed)', () => {
    for (let i = 0; i < 1200; i++) {
      const uid = `filler-${i}`;
      env.fakeNakama.store.set(`${FRIENDS_CODE_COLLECTION}/${uid}/${uid}`, {
        collection: FRIENDS_CODE_COLLECTION, key: uid, userId: uid,
        value: { schemaVersion: 1, userId: uid, code: `F${String(i).padStart(7, '0')}`, createdAt: 1 },
        version: 'v1', permissionRead: 1, permissionWrite: 0,
        createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
      });
    }
    // A code row written before the index existed (no index row).
    const target = code(env, C);
    env.fakeNakama.store.delete(`${FRIENDS_CODE_INDEX_COLLECTION}/${target}/${SYSTEM}`);
    const row = env.fakeNakama.store.get(`${FRIENDS_CODE_COLLECTION}/${C}/${C}`)!;
    env.fakeNakama.store.delete(`${FRIENDS_CODE_COLLECTION}/${C}/${C}`);
    env.fakeNakama.store.set(`${FRIENDS_CODE_COLLECTION}/${C}/${C}`, row);

    expect(call<Resp<unknown>>(env, 'friend_add_by_code', A, { code: target }).ok).toBe(true);
    expect(env.fakeNakama.store.has(`${FRIENDS_CODE_INDEX_COLLECTION}/${target}/${SYSTEM}`)).toBe(true);
  });

  it('chat messages carry the account username', () => {
    env.fakeNakama.users.set(A, {
      userId: A, username: 'alice', createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(), disableTime: null, metadata: {},
    } as never);
    env.fakeNakama.store.set(`${PROFILES_COLLECTION}/${A}/${A}`, {
      collection: PROFILES_COLLECTION, key: A, userId: A,
      value: { displayName: 'Alice Pro' }, version: 'v1',
      permissionRead: 0, permissionWrite: 0,
      createTime: new Date(0).toISOString(), updateTime: new Date(0).toISOString(), expiresAt: null,
    });
    befriend(env, A, B);
    expect(dm(env, A, B, 'hola').ok).toBe(true);
    const list = call<Resp<ChatList>>(env, 'chat_list', B, { channelType: 'direct', targetId: A });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.messages[0]!.senderName).toBe('alice');
      expect(list.data.messages[0]!.senderDisplayName).toBe('Alice Pro');
    }
  });

  it('a club history hides the messages of blocked senders', () => {
    for (const u of [A, B, C]) seedClubMember(env, 'club-x', u);
    for (const [u, text] of [[A, 'from a'], [B, 'from b']] as const) {
      expect(call<Resp<unknown>>(env, 'chat_send', u, { channelType: 'club', targetId: 'club-x', language: 'es', content: text }).ok).toBe(true);
    }
    expect(call<Resp<unknown>>(env, 'block_add', C, { targetUserId: B }).ok).toBe(true);
    const forC = call<Resp<ChatList>>(env, 'chat_list', C, { channelType: 'club', targetId: 'club-x' });
    if (forC.ok) expect(forC.data.messages.map((m) => m.content)).toEqual(['from a']);
    const forA = call<Resp<ChatList>>(env, 'chat_list', A, { channelType: 'club', targetId: 'club-x' });
    if (forA.ok) expect(forA.data.messages.map((m) => m.content)).toEqual(['from b', 'from a']);
  });

  it('a malformed chat cursor is a BAD_REQUEST', () => {
    befriend(env, A, B);
    expect(dm(env, A, B, 'hola').ok).toBe(true);
    const r = call<Resp<ChatList>>(env, 'chat_list', A, { channelType: 'direct', targetId: B, cursor: 'not-a-number' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_REQUEST');
  });
});
