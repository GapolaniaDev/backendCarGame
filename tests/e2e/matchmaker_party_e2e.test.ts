// Phase 7 Chunk 8 e2e — Matchmaker party integration.
//
// Verifies:
//   - mm_ticket_params with partyId stamps partyId + partySize into the
//     ticket metadata, accepts leader as caller.
//   - mm_ticket_params without partyId keeps the existing shape (Phase 4
//     backward compat).
//   - mm_ticket_params with partyId but caller is NOT the leader → FORBIDDEN.
//   - mm_ticket_params with non-existent partyId → NOT_FOUND.
//   - matchmakerMatched hook rejects a candidate where matched entries
//     carry different partyIds (party split).

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

interface TicketShape {
  metadata: Record<string, string>;
}

function asTicket(env: ReturnType<typeof loadBundleForTest>, payload: unknown): TicketShape {
  const r = call<Resp<{ ticket: TicketShape }>>(env, 'mm_ticket_params', payload);
  if (!r.ok) throw new Error(`mm_ticket_params failed: ${JSON.stringify(r)}`);
  return r.data.ticket;
}

describe('matchmaker party e2e (Phase 7 Chunk 8)', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('1. mm_ticket_params WITHOUT partyId keeps the existing shape (backward compat)', () => {
    const r = call<Resp<{ ticket: TicketShape }>>(env, 'mm_ticket_params', {
      mode: 'quick', size: 4, callerUserId: 'u1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ticket.metadata['partyId']).toBeUndefined();
    expect(r.data.ticket.metadata['partySize']).toBeUndefined();
    expect(r.data.ticket.metadata['mode']).toBe('quick');
    expect(r.data.ticket.metadata['size']).toBe('4');
  });

  it('2. mm_ticket_params WITH partyId stamps partyId + partySize into metadata', () => {
    // Create a party first so the leader can use it.
    const party = call<Resp<{ partyId: string; members: Array<{ userId: string }> }>>(
      env, 'party_create',
      { callerUserId: 'leader-1', maxSize: 4 },
    );
    if (!party.ok) throw new Error('party_create failed');
    const partyId = party.data.partyId;

    const ticket = asTicket(env, {
      mode: 'quick', size: 4, callerUserId: 'leader-1', partyId,
    });
    expect(ticket.metadata['partyId']).toBe(partyId);
    expect(ticket.metadata['partySize']).toBe(String(party.data.members.length));
  });

  it('3. mm_ticket_params with partyId but caller is not the leader → FORBIDDEN', () => {
    const party = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!party.ok) throw new Error('party_create failed');
    const partyId = party.data.partyId;

    const r = call<Resp<unknown>>(env, 'mm_ticket_params', {
      mode: 'quick', size: 4, callerUserId: 'intruder', partyId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('4. mm_ticket_params with non-existent partyId → NOT_FOUND', () => {
    const r = call<Resp<unknown>>(env, 'mm_ticket_params', {
      mode: 'quick', size: 4, callerUserId: 'u1', partyId: 'no-such-party',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('5. mm_ticket_params with partyId that is not open → FORBIDDEN', () => {
    const party = call<Resp<{ partyId: string }>>(env, 'party_create', {
      callerUserId: 'leader-1', maxSize: 4,
    });
    if (!party.ok) throw new Error('party_create failed');
    const partyId = party.data.partyId;

    // Close the party directly via storage.
    const partyKey = `parties/${partyId}/00000000-0000-0000-0000-000000000000`;
    const existing = env.fakeNakama.store.get(partyKey);
    if (existing) {
      const v = existing.value as { state: string };
      env.fakeNakama.store.set(partyKey, {
        ...existing,
        value: { ...v, state: 'closed' },
      });
    }

    const r = call<Resp<unknown>>(env, 'mm_ticket_params', {
      mode: 'quick', size: 4, callerUserId: 'leader-1', partyId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('6. matchmakerMatched hook rejects candidate with split party', () => {
    const hook = env.matchmakerMatchedHook;
    expect(hook).toBeDefined();
    if (!hook) return;

    const envelope = {
      matches: [
          {
            sessionId: 's1',
            tickets: [
              { ticket: 't1', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1' } },
              { ticket: 't2', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1' } },
            ],
            matched: [
              { sessionId: 's1', userId: 'u1', username: 'u1', vars: { partyId: 'party-A', partySize: '2' } },
              { sessionId: 's1', userId: 'u2', username: 'u2', vars: { partyId: 'party-B', partySize: '2' } },
            ],
          },
        ],
    };
    const decision = hook(undefined, env.logger, env.nak, envelope);
    expect(decision).toEqual({ matched: false });
  });

  it('7. matchmakerMatched hook accepts a candidate with a single intact party', () => {
    const hook = env.matchmakerMatchedHook;
    expect(hook).toBeDefined();
    if (!hook) return;

    const envelope = {
      matches: [
          {
            sessionId: 's1',
            tickets: [
              { ticket: 't1', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1' } },
              { ticket: 't2', metadata: { mode: 'quick', size: '2', version: '1.0.0', region: 'eu-west-1' } },
            ],
            matched: [
              { sessionId: 's1', userId: 'u1', username: 'u1', vars: { partyId: 'party-A', partySize: '2' } },
              { sessionId: 's1', userId: 'u2', username: 'u2', vars: { partyId: 'party-A', partySize: '2' } },
            ],
          },
        ],
    };
    const decision = hook(undefined, env.logger, env.nak, envelope);
    expect(decision).toEqual({ matched: true });
  });

  it('8. matchmakerMatched hook rejects a partial party (size mismatch)', () => {
    const hook = env.matchmakerMatchedHook;
    expect(hook).toBeDefined();
    if (!hook) return;

    const envelope = {
      matches: [
          {
            sessionId: 's1',
            tickets: [
              { ticket: 't1', metadata: { mode: 'quick', size: '3', version: '1.0.0', region: 'eu-west-1' } },
              { ticket: 't2', metadata: { mode: 'quick', size: '3', version: '1.0.0', region: 'eu-west-1' } },
              { ticket: 't3', metadata: { mode: 'quick', size: '3', version: '1.0.0', region: 'eu-west-1' } },
            ],
            matched: [
              { sessionId: 's1', userId: 'u1', username: 'u1', vars: { partyId: 'party-A', partySize: '4' } },
              { sessionId: 's1', userId: 'u2', username: 'u2', vars: { partyId: 'party-A', partySize: '4' } },
              { sessionId: 's1', userId: 'u3', username: 'u3', vars: { partyId: 'party-A', partySize: '4' } },
            ],
          },
        ],
    };
    const decision = hook(undefined, env.logger, env.nak, envelope);
    expect(decision).toEqual({ matched: false });
  });
});