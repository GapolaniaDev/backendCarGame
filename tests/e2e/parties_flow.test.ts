// Phase 7 Chunk 8 e2e — Party RPCs.

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

describe('parties_flow (Phase 7 Chunk 8) — RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('1. party_create returns partyId + maxSize + roster (leader only)', () => {
    const r = call<Resp<{ partyId: string; leaderUserId: string; maxSize: number; members: Array<{ userId: string }> }>>(
      env, 'party_create',
      { callerUserId: 'leader-1', maxSize: 4 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.leaderUserId).toBe('leader-1');
    expect(r.data.maxSize).toBe(4);
    expect(r.data.members).toHaveLength(1);
    expect(r.data.members[0]?.userId).toBe('leader-1');
    expect(typeof r.data.partyId).toBe('string');
    expect(r.data.partyId.length).toBeGreaterThan(0);

    // active_party/{user} now exists
    const ap = env.fakeNakama.store.get('active_party/leader-1/leader-1');
    expect(ap).toBeDefined();
    expect((ap?.value as { partyId: string }).partyId).toBe(r.data.partyId);
  });

  it('2. party_create when caller already in a party → FORBIDDEN', () => {
    call<Resp<unknown>>(env, 'party_create', { callerUserId: 'leader-1', maxSize: 4 });
    const r = call<Resp<unknown>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('3. party_invite: leader-only', async () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const partyId = create.data.partyId;

    // Non-leader cannot invite.
    const denied = call<Resp<unknown>>(env, 'party_invite', {
      callerUserId: 'intruder', partyId, targetUserId: 'target-1',
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('FORBIDDEN');

    // Leader can invite.
    const invited = call<Resp<{ inviteId: string; expiresAt: number; partyId: string; targetUserId: string }>>(
      env, 'party_invite',
      { callerUserId: 'leader-1', partyId, targetUserId: 'target-1' },
    );
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;
    expect(invited.data.partyId).toBe(partyId);
    expect(invited.data.targetUserId).toBe('target-1');
    expect(typeof invited.data.inviteId).toBe('string');
    expect(invited.data.expiresAt).toBeGreaterThan(Date.now());

    // An invite row was written under invites/{inviteId}/{targetUserId}
    // with kind='group' and payload.partyId.
    const inviteRow = env.fakeNakama.store.get(`invites/${invited.data.inviteId}/target-1`);
    expect(inviteRow).toBeDefined();
    const v = (inviteRow?.value as { partyId?: string; partyMaxSize?: number; payload?: { partyId?: string; partyMaxSize?: number } });
    // The party_id payload lives in either the top-level shortcut or under .payload.
    const payload = (v?.payload ?? v) as { partyId: string; partyMaxSize: number };
    expect(payload.partyId).toBe(partyId);
    expect(payload.partyMaxSize).toBe(4);
  });

  it('4. party_leave: removes member from roster + clears active_party', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    // Leader cannot leave when alone? Actually with 0 others, leader leaving
    // should disband the party.
    const r = call<Resp<{ left: true; disbanded: boolean }>>(env, 'party_leave', {
      callerUserId: 'leader-1', partyId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.left).toBe(true);
    expect(r.data.disbanded).toBe(true);

    // The party row should be gone.
    const partyRow = env.fakeNakama.store.get(`parties/${partyId}/00000000-0000-0000-0000-000000000000`);
    expect(partyRow).toBeUndefined();

    // active_party/{leader-1} should be gone too.
    const ap = env.fakeNakama.store.get('active_party/leader-1/leader-1');
    expect(ap).toBeUndefined();
  });

  it('5. party_leave: leader cannot leave with members present → FORBIDDEN', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    // Directly add a second member via storage (simulating an accepted invite).
    const existing = env.fakeNakama.store.get(`parties/${partyId}/00000000-0000-0000-0000-000000000000`);
    if (existing) {
      const v = existing.value as { members: Array<{ userId: string; joinedAt: number }> };
      env.fakeNakama.store.set(`parties/${partyId}/00000000-0000-0000-0000-000000000000`, {
        ...existing,
        value: {
          ...v,
          members: [...v.members, { userId: 'member-2', joinedAt: Date.now() }],
        },
      });
    }

    const r = call<Resp<unknown>>(env, 'party_leave', {
      callerUserId: 'leader-1', partyId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('6. party_kick: leader-only, removes member', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    // Add a member via direct storage.
    const partyKey = `parties/${partyId}/00000000-0000-0000-0000-000000000000`;
    const existing = env.fakeNakama.store.get(partyKey);
    if (existing) {
      const v = existing.value as { members: Array<{ userId: string; joinedAt: number }> };
      env.fakeNakama.store.set(partyKey, {
        ...existing,
        value: { ...v, members: [...v.members, { userId: 'member-2', joinedAt: Date.now() }] },
      });
    }

    // Non-leader cannot kick.
    const denied = call<Resp<unknown>>(env, 'party_kick', {
      callerUserId: 'member-2', partyId, targetUserId: 'member-2',
    });
    expect(denied.ok).toBe(false);

    // Leader can kick.
    const kicked = call<Resp<{ kicked: true; targetUserId: string }>>(env, 'party_kick', {
      callerUserId: 'leader-1', partyId, targetUserId: 'member-2',
    });
    expect(kicked.ok).toBe(true);
    if (!kicked.ok) return;
    expect(kicked.data.kicked).toBe(true);
    expect(kicked.data.targetUserId).toBe('member-2');

    // Member is gone from the party.
    const after = env.fakeNakama.store.get(partyKey);
    const afterMembers = (after?.value as { members: Array<{ userId: string }> }).members;
    expect(afterMembers.find((m) => m.userId === 'member-2')).toBeUndefined();
  });

  it('7. party_get: members-only', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    // Non-member → FORBIDDEN
    const denied = call<Resp<unknown>>(env, 'party_get', {
      callerUserId: 'outsider', partyId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('FORBIDDEN');

    // Member → OK with the roster.
    const ok = call<Resp<{ party: { leaderUserId: string; members: Array<{ userId: string }> } }>>(
      env, 'party_get',
      { callerUserId: 'leader-1', partyId },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.data.party.leaderUserId).toBe('leader-1');
    expect(ok.data.party.members).toHaveLength(1);
    expect(ok.data.party.members[0]?.userId).toBe('leader-1');
  });

  it('8. maxSize enforcement: party_invite on a full party → CONFLICT', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 2,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    // Fill the party to maxSize=2 (leader + 1).
    const partyKey = `parties/${partyId}/00000000-0000-0000-0000-000000000000`;
    const existing = env.fakeNakama.store.get(partyKey);
    if (existing) {
      const v = existing.value as { members: Array<{ userId: string; joinedAt: number }> };
      env.fakeNakama.store.set(partyKey, {
        ...existing,
        value: { ...v, members: [...v.members, { userId: 'member-2', joinedAt: Date.now() }] },
      });
    }

    const r = call<Resp<unknown>>(env, 'party_invite', {
      callerUserId: 'leader-1', partyId, targetUserId: 'target-3',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
  });

  it('9. party_invite self → BAD_REQUEST', () => {
    const create = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!create.ok) throw new Error('create failed');
    const partyId = create.data.partyId;

    const r = call<Resp<unknown>>(env, 'party_invite', {
      callerUserId: 'leader-1', partyId, targetUserId: 'leader-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('10. party_invite to a non-existent party → NOT_FOUND', () => {
    const r = call<Resp<unknown>>(env, 'party_invite', {
      callerUserId: 'leader-1', partyId: 'no-such-party', targetUserId: 'target-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('11. invalid maxSize → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 5,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });
});