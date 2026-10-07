// Phase 7 Chunk 2 e2e — invites + blocks lifecycle.
//
// Covers the ~6 cases from the peer spec:
//   1.  invite_send happy path → offline delivery + target list shows it
//   2.  invite_send self → BAD_REQUEST
//   3.  invite_send blocked → FORBIDDEN
//   4.  invite_respond accept → status='accepted', list hides it
//   5.  invite_respond twice → CONFLICT
//   6.  invite_respond on expired → CONFLICT
//   7.  block_add idempotent (twice = ok)
//   8.  block_add self → BAD_REQUEST
//   9.  block_remove idempotent (missing = ok with removed:false)
//  10.  block_list returns own blocks
//  11.  invite_send rate limit 11/min → RATE_LIMITED
//  12.  invite_list is lazy: expired surfaces as 'expired' in payload
//  13.  Maintenance gate on all 6 RPCs

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  INVITES_COLLECTION,
  BLOCKS_COLLECTION,
  INVITE_TTL_MS,
  type InviteRecord,
  type BlockRecord,
  type InviteKind,
} from '../../modules/src/social/types';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { LIVEOPS_STORAGE_KEY } from '../../modules/src/liveops/config';

const USER_A = 'user-inv-a';
const USER_B = 'user-inv-b';
const USER_C = 'user-inv-c';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

interface InviteSendOutput {
  inviteId: string;
  delivered: 'online' | 'offline';
  expiresAt: number;
}

interface InviteCard {
  inviteId: string;
  fromUserId: string;
  kind: InviteKind;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  isExpired: boolean;
}

interface InviteListOutput {
  items: InviteCard[];
  count: number;
}

interface InviteRespondOutput {
  status: 'accepted' | 'declined';
  inviteId: string;
}

interface BlockCard {
  targetUserId: string;
  createdAt: number;
}

interface BlockAddOutput {
  created: boolean;
}

interface BlockRemoveOutput {
  removed: boolean;
}

interface BlockListOutput {
  blocks: BlockCard[];
  count: number;
}

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

function callInviteSend(
  env: LoadedBundle,
  caller: string,
  targetUserId: string,
  kind: InviteKind = 'private_room',
  payload: Record<string, unknown> = { sessionId: 'sid-1' },
): Resp<InviteSendOutput> {
  return call<Resp<InviteSendOutput>>(
    env, 'invite_send', caller,
    { callerUserId: caller, targetUserId, kind, payload,
      clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callInviteList(env: LoadedBundle, userId: string): Resp<InviteListOutput> {
  return call<Resp<InviteListOutput>>(
    env, 'invite_list', userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callInviteRespond(
  env: LoadedBundle,
  userId: string,
  inviteId: string,
  accept: boolean,
): Resp<InviteRespondOutput> {
  return call<Resp<InviteRespondOutput>>(
    env, 'invite_respond', userId,
    { callerUserId: userId, inviteId, accept,
      clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callBlockAdd(env: LoadedBundle, caller: string, targetUserId: string): Resp<BlockAddOutput> {
  return call<Resp<BlockAddOutput>>(
    env, 'block_add', caller,
    { callerUserId: caller, targetUserId,
      clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callBlockRemove(env: LoadedBundle, caller: string, targetUserId: string): Resp<BlockRemoveOutput> {
  return call<Resp<BlockRemoveOutput>>(
    env, 'block_remove', caller,
    { callerUserId: caller, targetUserId,
      clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callBlockList(env: LoadedBundle, caller: string): Resp<BlockListOutput> {
  return call<Resp<BlockListOutput>>(
    env, 'block_list', caller,
    { callerUserId: caller, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function seedInvite(
  env: LoadedBundle,
  targetUserId: string,
  inviteId: string,
  overrides: Partial<InviteRecord> = {},
): InviteRecord {
  const rec: InviteRecord = {
    schemaVersion: 1,
    inviteId,
    fromUserId: USER_A,
    targetUserId,
    kind: 'private_room',
    payload: { sessionId: 'sid-1' },
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITE_TTL_MS,
    status: 'pending',
    ...overrides,
  };
  env.fakeNakama.store.set(
    `${INVITES_COLLECTION}/${inviteId}/${targetUserId}`,
    {
      collection: INVITES_COLLECTION,
      key: inviteId,
      userId: targetUserId,
      value: rec,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      expiresAt: null,
    },
  );
  return rec;
}

function seedBlock(
  env: LoadedBundle,
  ownerId: string,
  targetUserId: string,
): BlockRecord {
  const rec: BlockRecord = {
    schemaVersion: 1,
    ownerId,
    targetUserId,
    createdAt: Date.now(),
  };
  env.fakeNakama.store.set(
    `${BLOCKS_COLLECTION}/${targetUserId}/${ownerId}`,
    {
      collection: BLOCKS_COLLECTION,
      key: targetUserId,
      userId: ownerId,
      value: rec,
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      expiresAt: null,
    },
  );
  return rec;
}

function setMaintenance(env: LoadedBundle): void {
  const cfg = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: true },
    minClientVersion: {
      ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
    calendar: [],
  } as const;
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: cfg as unknown as LiveopsConfig,
    version: stored?.version ?? 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: stored?.createTime ?? new Date().toISOString(),
    updateTime: new Date().toISOString(),
    expiresAt: null,
  });
}

describe('invite_block_flow e2e (Phase 7 Chunk 2)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  // ─── invite_send ─────────────────────────────────────────────────────────

  it('invite_send happy path → offline delivery + target list shows it', () => {
    const send = callInviteSend(env, USER_A, USER_B);
    expect(send.ok).toBe(true);
    if (!send.ok) return;
    expect(send.data.delivered).toBe('offline');
    expect(send.data.inviteId.length).toBeGreaterThan(0);
    expect(send.data.expiresAt).toBeGreaterThan(Date.now());

    const list = callInviteList(env, USER_B);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.count).toBe(1);
    expect(list.data.items[0]?.fromUserId).toBe(USER_A);
    expect(list.data.items[0]?.status).toBe('pending');
    expect(list.data.items[0]?.kind).toBe('private_room');
  });

  it('invite_send self → BAD_REQUEST', () => {
    const send = callInviteSend(env, USER_A, USER_A);
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.code).toBe('BAD_REQUEST');
  });

  it('invite_send wrong kind → BAD_REQUEST', () => {
    const send = call<Resp<InviteSendOutput>>(
      env, 'invite_send', USER_A,
      { callerUserId: USER_A, targetUserId: USER_B, kind: 'wrong_kind',
        payload: { sessionId: 's' }, clientVersion: '1.0.0', platform: 'ios' },
    );
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.code).toBe('BAD_REQUEST');
  });

  it('invite_send non-object payload → BAD_REQUEST', () => {
    const send = call<Resp<InviteSendOutput>>(
      env, 'invite_send', USER_A,
      { callerUserId: USER_A, targetUserId: USER_B, kind: 'group',
        payload: 'not an object', clientVersion: '1.0.0', platform: 'ios' },
    );
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.code).toBe('BAD_REQUEST');
  });

  it('invite_send blocked → FORBIDDEN (caller is blocked)', () => {
    seedBlock(env, USER_A, USER_B);
    const send = callInviteSend(env, USER_A, USER_B);
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.code).toBe('FORBIDDEN');
  });

  it('invite_send blocked → FORBIDDEN (target blocked caller)', () => {
    seedBlock(env, USER_B, USER_A);
    const send = callInviteSend(env, USER_A, USER_B);
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.code).toBe('FORBIDDEN');
  });

  it('invite_send rate limit 11/min → RATE_LIMITED', () => {
    // First 10 succeed (with different targets to dodge any block check;
    // here they're all fresh).
    for (let i = 0; i < 10; i++) {
      const res = callInviteSend(env, USER_A, `target-${i}`);
      expect(res.ok).toBe(true);
    }
    const overflow = callInviteSend(env, USER_A, 'target-overflow');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe('RATE_LIMITED');
  });

  // ─── invite_respond ──────────────────────────────────────────────────────

  it('invite_respond accept → status=accepted, list hides it', () => {
    const send = callInviteSend(env, USER_A, USER_B);
    if (!send.ok) throw new Error('setup failed');
    const inviteId = send.data.inviteId;

    const respond = callInviteRespond(env, USER_B, inviteId, true);
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('accepted');

    const list = callInviteList(env, USER_B);
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data.count).toBe(0);
  });

  it('invite_respond twice → CONFLICT', () => {
    const send = callInviteSend(env, USER_A, USER_B);
    if (!send.ok) throw new Error('setup failed');
    const first = callInviteRespond(env, USER_B, send.data.inviteId, true);
    expect(first.ok).toBe(true);
    const second = callInviteRespond(env, USER_B, send.data.inviteId, true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
  });

  it('invite_respond on expired → CONFLICT', () => {
    const rec = seedInvite(env, USER_B, 'expired-1', {
      expiresAt: Date.now() - 1000, // already past
    });
    void rec;
    const res = callInviteRespond(env, USER_B, 'expired-1', true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONFLICT');
  });

  it('invite_respond on missing → NOT_FOUND', () => {
    const res = callInviteRespond(env, USER_B, 'nope', true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('invite_list surfaces expired invites with status="expired"', () => {
    seedInvite(env, USER_B, 'past', {
      expiresAt: Date.now() - 1000,
    });
    const list = callInviteList(env, USER_B);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.count).toBe(1);
    expect(list.data.items[0]?.status).toBe('expired');
    expect(list.data.items[0]?.isExpired).toBe(true);
  });

  it('invite_list hides accepted/declined invites', () => {
    seedInvite(env, USER_B, 'acc', { status: 'accepted' });
    seedInvite(env, USER_B, 'dec', { status: 'declined' });
    seedInvite(env, USER_B, 'pending', { status: 'pending' });
    const list = callInviteList(env, USER_B);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.count).toBe(1);
    expect(list.data.items[0]?.inviteId).toBe('pending');
  });

  // ─── block_add / block_remove / block_list ──────────────────────────────

  it('block_add idempotent (twice = ok, created:false on second)', () => {
    const first = callBlockAdd(env, USER_A, USER_B);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.created).toBe(true);
    const second = callBlockAdd(env, USER_A, USER_B);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.created).toBe(false);
  });

  it('block_add self → BAD_REQUEST', () => {
    const res = callBlockAdd(env, USER_A, USER_A);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
  });

  it('block_remove idempotent (missing = removed:false)', () => {
    const res = callBlockRemove(env, USER_A, USER_B);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.removed).toBe(false);
  });

  it('block_list returns own blocks, hidden from others', () => {
    callBlockAdd(env, USER_A, USER_B);
    callBlockAdd(env, USER_A, USER_C);
    const a = callBlockList(env, USER_A);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.data.count).toBe(2);
      const targets = a.data.blocks.map((b) => b.targetUserId).sort();
      expect(targets).toEqual([USER_B, USER_C]);
    }
    const b = callBlockList(env, USER_B);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.data.count).toBe(0);
  });

  it('block_remove deletes a real block', () => {
    callBlockAdd(env, USER_A, USER_B);
    const removed = callBlockRemove(env, USER_A, USER_B);
    expect(removed.ok && removed.data.removed).toBe(true);
    // Invite now succeeds (no longer blocked).
    const send = callInviteSend(env, USER_A, USER_B);
    expect(send.ok).toBe(true);
  });

  // ─── maintenance gate ─────────────────────────────────────────────────────

  it('all 6 RPCs are gated by maintenance', () => {
    setMaintenance(env);
    const a = callInviteSend(env, USER_A, USER_B);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe('SERVICE_UNAVAILABLE');
    const b = callInviteList(env, USER_A);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe('SERVICE_UNAVAILABLE');
    const c = callInviteRespond(env, USER_A, 'x', true);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('SERVICE_UNAVAILABLE');
    const d = callBlockAdd(env, USER_A, USER_B);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.code).toBe('SERVICE_UNAVAILABLE');
    const e = callBlockRemove(env, USER_A, USER_B);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe('SERVICE_UNAVAILABLE');
    const f = callBlockList(env, USER_A);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});