// Phase 7 Chunk 9 — Unit tests for `joinParty` (CAS-retryable party
// roster update + active_party inverse index).

import { describe, it, expect } from 'vitest';

import { joinParty } from '../../modules/src/parties/parties_repo';
import type { ILogger } from '../../modules/src/nkruntime';
import { FakeNakama } from '../e2e/_stubs';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function mkLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    debug: noop, info: noop, warn: noop, error: noop,
    withField: () => mkLogger(),
    withFields: () => mkLogger(),
  } as unknown as ILogger;
}

function setupOpenParty(fakeNakama: FakeNakama, partyId: string, leaderUserId: string, maxSize: number): void {
  fakeNakama.store.set(
    `parties/${partyId}/${SYSTEM_USER_ID}`,
    {
      value: {
        schemaVersion: 1,
        partyId,
        leaderUserId,
        maxSize,
        state: 'open',
        createdAt: 1_000_000,
        members: [{ userId: leaderUserId, joinedAt: 1_000_000 }],
      },
      version: 'v00000000',
    },
  );
}

describe('parties joinParty (Phase 7 Chunk 9)', () => {
  it('adds the user to the party roster + writes active_party index', () => {
    const fakeNak = new FakeNakama();
    setupOpenParty(fakeNak.nakama as unknown as FakeNakama, 'p1', 'leader-1', 4);
    // joinParty takes the INakama — but FakeNakama is exposed via .nakama
    // (an INakama-shaped facade). The fake storage lives on `fakeNakama.store`.
    const nak = fakeNak.nakama;
    const r = joinParty(
      nak as unknown as Parameters<typeof joinParty>[0],
      mkLogger(),
      'user-2',
      'p1',
    );
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.record.members.map((m) => m.userId)).toEqual(['leader-1', 'user-2']);
    // active_party/{user-2} should exist.
    const ap = fakeNak.store.get('active_party/user-2/user-2');
    expect(ap).toBeDefined();
    expect((ap?.value as { partyId: string }).partyId).toBe('p1');
  });

  it('returns null when the party does not exist', () => {
    const fakeNak = new FakeNakama();
    const r = joinParty(
      fakeNak.nakama as unknown as Parameters<typeof joinParty>[0],
      mkLogger(),
      'user-2',
      'no-such-party',
    );
    expect(r).toBeNull();
  });

  it('throws when the party is full', () => {
    const fakeNak = new FakeNakama();
    setupOpenParty(fakeNak.nakama as unknown as FakeNakama, 'p1', 'leader-1', 2);
    // Pre-fill the second slot.
    const existing = fakeNak.store.get(`parties/p1/${SYSTEM_USER_ID}`);
    if (existing) {
      const v = existing.value as { members: Array<{ userId: string; joinedAt: number }> };
      fakeNak.store.set(`parties/p1/${SYSTEM_USER_ID}`, {
        ...existing,
        value: { ...v, members: [...v.members, { userId: 'member-2', joinedAt: 1 }] },
      });
    }
    expect(() => joinParty(
      fakeNak.nakama as unknown as Parameters<typeof joinParty>[0],
      mkLogger(),
      'user-3',
      'p1',
    )).toThrowError(/party is full/);
  });

  it('throws when the user is already a member', () => {
    const fakeNak = new FakeNakama();
    setupOpenParty(fakeNak.nakama as unknown as FakeNakama, 'p1', 'leader-1', 4);
    expect(() => joinParty(
      fakeNak.nakama as unknown as Parameters<typeof joinParty>[0],
      mkLogger(),
      'leader-1',
      'p1',
    )).toThrowError(/already a member/);
  });

  it('throws when the party is closed', () => {
    const fakeNak = new FakeNakama();
    setupOpenParty(fakeNak.nakama as unknown as FakeNakama, 'p1', 'leader-1', 4);
    const existing = fakeNak.store.get(`parties/p1/${SYSTEM_USER_ID}`);
    if (existing) {
      const v = existing.value as { state: string };
      fakeNak.store.set(`parties/p1/${SYSTEM_USER_ID}`, {
        ...existing,
        value: { ...v, state: 'closed' },
      });
    }
    expect(() => joinParty(
      fakeNak.nakama as unknown as Parameters<typeof joinParty>[0],
      mkLogger(),
      'user-2',
      'p1',
    )).toThrowError(/party is closed/);
  });
});