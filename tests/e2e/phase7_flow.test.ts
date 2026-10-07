// Phase 7 Chunk 9 — End-to-end Phase 7 social + parties + moderation flow.
//
// Drives the cross-module interaction between parties, invites, blocks,
// friends, and the matchmaker party extension. Focused on Chunk 9's
// `party_join` fix + the chunk-8 ↔ chunk-2 ↔ chunk-9 wire-up. Deeper
// per-module coverage lives in dedicated tests (friend_flow, chat_flow,
// clubs_flow, moderation_flow).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  payload: unknown,
): T {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(
    handler(FakeContext, env.logger, env.nak, typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ) as T;
}

describe('phase7_flow (Phase 7 Chunk 9) — parties + social cross-module', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('1. party_create → party_invite → invite_respond → Bob joins the party', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    const inv = call<Resp<{ inviteId: string }>>(env, 'party_invite', {
      callerUserId: 'alice', partyId, targetUserId: 'bob',
    });
    if (!inv.ok) throw new Error('party_invite failed');

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'bob', inviteId: inv.data.inviteId, accept: true,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('accepted');
    expect(respond.data.partyId).toBe(partyId);

    const g = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'alice', partyId },
    );
    if (!g.ok) throw new Error('party_get failed');
    expect(g.data.party.members.map((m) => m.userId).sort()).toEqual(['alice', 'bob']);
  });

  it('2. invite_respond(accept=true) on a plain (non-party) invite does NOT set partyId', () => {
    const inv = call<Resp<{ inviteId: string }>>(env, 'invite_send', {
      callerUserId: 'alice', targetUserId: 'bob', kind: 'group', payload: { some: 'data' },
    });
    if (!inv.ok) throw new Error('invite_send failed');

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'bob', inviteId: inv.data.inviteId, accept: true,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('accepted');
    expect(respond.data.partyId).toBeUndefined();
  });

  it('3. invite_respond(accept=false) on a party invite does NOT add caller to roster', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    const inv = call<Resp<{ inviteId: string }>>(env, 'party_invite', {
      callerUserId: 'alice', partyId, targetUserId: 'bob',
    });
    if (!inv.ok) throw new Error('party_invite failed');

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'bob', inviteId: inv.data.inviteId, accept: false,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('declined');
    expect(respond.data.partyId).toBeUndefined();

    const g = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'alice', partyId },
    );
    if (!g.ok) throw new Error('party_get failed');
    expect(g.data.party.members).toHaveLength(1);
  });

  it('4. block_add → party_invite → FORBIDDEN (block blocks party_invite)', () => {
    call<Resp<unknown>>(env, 'block_add', { callerUserId: 'alice', targetUserId: 'bob' });
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const r = call<Resp<unknown>>(env, 'party_invite', {
      callerUserId: 'alice', partyId: create.data.partyId, targetUserId: 'bob',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('5. party_leave by leader (alone) disbands the party', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    const leave = call<Resp<{ left: true; disbanded: boolean }>>(env, 'party_leave', {
      callerUserId: 'alice', partyId,
    });
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    expect(leave.data.disbanded).toBe(true);

    const row = env.fakeNakama.store.get(`parties/${partyId}/00000000-0000-0000-0000-000000000000`);
    expect(row).toBeUndefined();
  });

  it('6. party_leave by a non-leader keeps the party alive (and removes the user)', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    // Bob joins via party_join RPC directly (no invite_respond).
    const join = call<Resp<unknown>>(env, 'party_join', {
      callerUserId: 'bob', partyId,
    });
    expect(join.ok).toBe(true);

    const leave = call<Resp<{ left: true; disbanded: boolean }>>(env, 'party_leave', {
      callerUserId: 'bob', partyId,
    });
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    expect(leave.data.disbanded).toBe(false);

    // Alice still there.
    const g = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'alice', partyId },
    );
    if (!g.ok) throw new Error('party_get failed');
    expect(g.data.party.members).toHaveLength(1);
    expect(g.data.party.members[0]?.userId).toBe('alice');
  });

  it('7. mm_ticket_params with partyId stamps partyId + partySize into ticket metadata', () => {
    const create = call<Resp<{ partyId: string; members: Array<{ userId: string }> }>>(
      env, 'party_create',
      { callerUserId: 'alice', maxSize: 4 },
    );
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    const r = call<Resp<{ ticket: { metadata: Record<string, string> } }>>(
      env, 'mm_ticket_params',
      { mode: 'quick', size: 4, callerUserId: 'alice', partyId },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ticket.metadata['partyId']).toBe(partyId);
    expect(r.data.ticket.metadata['partySize']).toBe(String(create.data.members.length));
  });

  it('8. friend_code_get returns a string; friend_add_by_code forms a mutual edge', () => {
    const code = call<Resp<{ code: string; userId: string }>>(env, 'friend_code_get', {
      callerUserId: 'alice',
    });
    expect(code.ok).toBe(true);
    if (!code.ok) return;
    expect(typeof code.data.code).toBe('string');
    expect(code.data.code.length).toBeGreaterThan(0);

    const added = call<Resp<{ mutual: boolean; friendId: string }>>(env, 'friend_add_by_code', {
      callerUserId: 'bob', code: code.data.code,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.mutual).toBe(true);
    expect(added.data.friendId).toBe('alice');
  });

  it('9. recent_rivals_get returns an empty rivals list for a fresh user', () => {
    const r = call<Resp<{ rivals: unknown[]; count: number }>>(env, 'recent_rivals_get', {
      callerUserId: 'alice', limit: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rivals).toEqual([]);
    expect(r.data.count).toBe(0);
  });

  it('10. party_join idempotency: same user joining same party twice → second is FORBIDDEN (already in a party)', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'alice', maxSize: 4,
    });
    if (!create.ok) throw new Error('party_create failed');
    const partyId = create.data.partyId;

    const first = call<Resp<unknown>>(env, 'party_join', { callerUserId: 'bob', partyId });
    expect(first.ok).toBe(true);

    const second = call<Resp<unknown>>(env, 'party_join', { callerUserId: 'bob', partyId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('FORBIDDEN');
  });
});