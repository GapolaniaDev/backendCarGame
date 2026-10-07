// Phase 7 Chunk 9 — Party join e2e (RPC + invite_respond party flow).

import { describe, it, beforeEach } from 'vitest';
import { expect } from 'vitest';
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

describe('party_flow (Phase 7 Chunk 9) — RPC + invite_respond', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('1. party_join adds the caller to the roster', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    const r = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_join',
      { callerUserId: 'user-2', partyId },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.party.members.map((m) => m.userId)).toEqual(['leader-1', 'user-2']);

    // active_party index updated.
    const ap = env.fakeNakama.store.get('active_party/user-2/user-2');
    expect(ap).toBeDefined();
    expect((ap?.value as { partyId: string }).partyId).toBe(partyId);
  });

  it('2. party_join when caller is already in a party → FORBIDDEN', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;
    // Join as user-2 — succeeds, now they're in this party.
    call<Resp<unknown>>(env, 'party_join', { callerUserId: 'user-2', partyId });
    // Try to join a different party as user-2 → FORBIDDEN (already in a party).
    const create2 = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-3', maxSize: 4,
    });
    if (!create2.ok) throw new Error('create2 failed');
    const r = call<Resp<unknown>>(env, 'party_join', {
      callerUserId: 'user-2', partyId: create2.data.partyId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('3. party_join when caller is already a member → CONFLICT', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;
    // Remove leader's active_party entry directly so the "already in
    // a party" gate doesn't fire; joinParty then sees the leader is
    // already in this party's roster.
    env.fakeNakama.store.delete('active_party/leader-1/leader-1');
    const r = call<Resp<unknown>>(env, 'party_join', {
      callerUserId: 'leader-1', partyId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  it('4. party_join on a non-existent party → NOT_FOUND', () => {
    const r = call<Resp<unknown>>(env, 'party_join', {
      callerUserId: 'user-2', partyId: 'no-such',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('5. invite_respond(accept=true) on a party invite adds caller to roster', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    const invited = call<Resp<{ inviteId: string }>>(env, 'party_invite', {
      callerUserId: 'leader-1', partyId, targetUserId: 'user-2',
    });
    if (!invited.ok) throw new Error('invite failed');
    const inviteId = invited.data.inviteId;

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'user-2', inviteId, accept: true,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('accepted');
    expect(respond.data.partyId).toBe(partyId);

    // Roster updated.
    const r = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'leader-1', partyId },
    );
    if (!r.ok) throw new Error('party_get failed');
    expect(r.data.party.members.map((m) => m.userId)).toEqual(['leader-1', 'user-2']);
  });

  it('6. invite_respond(accept=false) on a party invite does NOT add caller', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    const invited = call<Resp<{ inviteId: string }>>(env, 'party_invite', {
      callerUserId: 'leader-1', partyId, targetUserId: 'user-2',
    });
    if (!invited.ok) throw new Error('invite failed');

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'user-2', inviteId: invited.data.inviteId, accept: false,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('declined');
    expect(respond.data.partyId).toBeUndefined();

    // Roster unchanged.
    const r = call<Resp<{ party: { members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'leader-1', partyId },
    );
    if (!r.ok) throw new Error('party_get failed');
    expect(r.data.party.members).toHaveLength(1);
  });

  it('7. invite_respond(accept=true) on a non-party invite does NOT include partyId', () => {
    // Send a plain invite via invite_send (kind='group', no partyId payload).
    const invited = call<Resp<{ inviteId: string }>>(env, 'invite_send', {
      callerUserId: 'leader-1', targetUserId: 'user-2', kind: 'group', payload: { some: 'data' },
    });
    if (!invited.ok) throw new Error('invite_send failed');

    const respond = call<Resp<{ status: string; partyId?: string }>>(env, 'invite_respond', {
      callerUserId: 'user-2', inviteId: invited.data.inviteId, accept: true,
    });
    expect(respond.ok).toBe(true);
    if (!respond.ok) return;
    expect(respond.data.status).toBe('accepted');
    expect(respond.data.partyId).toBeUndefined();
  });
});