// Phase 5 Chunk 3 unit tests for the per-user inbox module
// (`sendInbox`, `listInbox`, `claimInbox`).
//
// Covers the 10 cases from the peer spec:
//   1. sendInbox happy path → storage row with expected shape
//   2. sendInbox duplicate messageId → idempotent (no overwrite)
//   3. listInbox default excludes claimed
//   4. listInbox includeClaimed=true → all messages
//   5. listInbox unreadCount excludes expired
//   6. claimInbox happy path → grant coins via wallet
//   7. claimInbox already claimed → CONFLICT
//   8. claimInbox expired → BAD_REQUEST
//   9. claimInbox cosmetic reward → adds to bag (handler layer; here: claimedAt set, no wallet grant)
//   10. claimInbox car reward → adds to garage (handler layer; here: claimedAt set, no wallet grant)
//
// These tests exercise the pure `inbox/messages.ts` surface with the
// `FakeNakama` stub. The handler layer (RPCs that wire car/cosmetic
// delivery through the garage catalog) is covered in the e2e suite.

import { describe, it, expect } from 'vitest';

import {
  INBOX_COLLECTION,
  claimInbox,
  inboxKey,
  listInbox,
  sendInbox,
  type InboxMessage,
} from '../../modules/src/liveops/messages';
import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const USER = 'user-inbox';

function makeNakama(): FakeNakamaType {
  return new FakeNakama();
}

function makeBaseMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    schemaVersion: 1,
    id: 'msg-1',
    userId: USER,
    kind: 'reward',
    title: 'Welcome bonus',
    body: '500 coins on us.',
    reward: { coins: 500 },
    createdAt: NOW,
    expiresAt: NOW + 30 * DAY_MS,
    ...overrides,
  };
}

function writeDirectly(nak: FakeNakamaType, m: InboxMessage): void {
  // Match the FakeNakama stub's composite storage key:
  //   `${collection}/${key}/${userId}` where `key` is itself
  //   `${userId}/${messageId}`. (See storageKeyString in _stubs.ts.)
  nak.store.set(`${INBOX_COLLECTION}/${inboxKey(m.userId, m.id)}/${m.userId}`, {
    collection: INBOX_COLLECTION,
    key: inboxKey(m.userId, m.id),
    userId: m.userId,
    value: m as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    expiresAt: null,
  });
}

function makeGrantSpy(): {
  grantFn: (
    nk: import('../../modules/src/nkruntime').INakama,
    userId: string,
    changeset: { coins?: number; gems?: number },
    idempKey: string,
  ) => { coins: number; gems: number };
  calls: Array<{ userId: string; changeset: { coins?: number; gems?: number }; idempKey: string }>;
} {
  const calls: Array<{ userId: string; changeset: { coins?: number; gems?: number }; idempKey: string }> = [];
  return {
    grantFn: (_nk, userId, changeset, idempKey) => {
      calls.push({ userId, changeset, idempKey });
      return { coins: 1000, gems: 0 };
    },
    calls,
  };
}

describe('inbox (Phase 5 Chunk 3) — sendInbox', () => {
  it('1. happy path — storage row has expected shape', () => {
    const nak = makeNakama();
    const result = sendInbox(
      nak.nakama,
      USER,
      { id: 'msg-a', kind: 'reward', title: 't', body: 'b', reward: { coins: 100 } },
      NOW,
    );
    expect(result.inserted).toBe(true);
    expect(result.message.id).toBe('msg-a');
    expect(result.message.userId).toBe(USER);
    expect(result.message.schemaVersion).toBe(1);
    expect(result.message.createdAt).toBe(NOW);
    // Default TTL = 30 days
    expect(result.message.expiresAt).toBe(NOW + 30 * DAY_MS);

    const stored = nak.store.get(`${INBOX_COLLECTION}/${inboxKey(USER, 'msg-a')}/${USER}`);
    expect(stored).toBeDefined();
    expect(stored?.permissionRead).toBe(1);
    expect(stored?.permissionWrite).toBe(0);
  });

  it('2. duplicate messageId is idempotent (returns existing, inserted=false)', () => {
    const nak = makeNakama();
    const first = sendInbox(
      nak.nakama,
      USER,
      { id: 'msg-dup', kind: 'system', title: 't', body: 'b' },
      NOW,
    );
    expect(first.inserted).toBe(true);

    const second = sendInbox(
      nak.nakama,
      USER,
      { id: 'msg-dup', kind: 'system', title: 'CHANGED', body: 'CHANGED' },
      NOW + 1000,
    );
    expect(second.inserted).toBe(false);
    expect(second.message.title).toBe('t'); // original wins
    expect(second.message.body).toBe('b');
  });
});

describe('inbox (Phase 5 Chunk 3) — listInbox', () => {
  it('3. default exclude claimed', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'm1' }));
    writeDirectly(nak, makeBaseMessage({ id: 'm2', claimedAt: NOW - 1000 }));
    const result = listInbox(nak.nakama, USER, {}, NOW);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.id).toBe('m1');
    expect(result.unreadCount).toBe(1);
  });

  it('4. includeClaimed=true → all messages', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'm1' }));
    writeDirectly(nak, makeBaseMessage({ id: 'm2', claimedAt: NOW - 1000 }));
    const result = listInbox(nak.nakama, USER, { includeClaimed: true }, NOW);
    expect(result.messages.length).toBe(2);
    expect(result.unreadCount).toBe(1);
  });

  it('5. unreadCount excludes expired messages', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'fresh', expiresAt: NOW + 1000 }));
    writeDirectly(nak, makeBaseMessage({ id: 'old', expiresAt: NOW - 1000 }));
    const result = listInbox(nak.nakama, USER, { includeClaimed: true }, NOW);
    // Both visible (includeClaimed=true) but only fresh counts as unread.
    expect(result.messages.length).toBe(2);
    expect(result.unreadCount).toBe(1);
  });

  it('sorted newest first', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'old', createdAt: NOW - 10000 }));
    writeDirectly(nak, makeBaseMessage({ id: 'new', createdAt: NOW }));
    const result = listInbox(nak.nakama, USER, {}, NOW);
    expect(result.messages[0]?.id).toBe('new');
    expect(result.messages[1]?.id).toBe('old');
  });
});

describe('inbox (Phase 5 Chunk 3) — claimInbox', () => {
  it('6. happy path — sets claimedAt + invokes grantFn for coins', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'claim-ok', reward: { coins: 500 } }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'claim-ok', NOW, spy.grantFn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.claimedAt).toBe(NOW);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.idempKey).toBe('inbox:claim-ok');
    expect(spy.calls[0]?.changeset).toEqual({ coins: 500 });
    expect(result.newBalance).toEqual({ coins: 1000, gems: 0 });
  });

  it('happy path — gems only', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'g', reward: { gems: 25 } }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'g', NOW, spy.grantFn);
    expect(result.ok).toBe(true);
    expect(spy.calls[0]?.changeset).toEqual({ gems: 25 });
  });

  it('happy path — no reward → no grant call', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'nr', reward: undefined }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'nr', NOW, spy.grantFn);
    expect(result.ok).toBe(true);
    expect(spy.calls.length).toBe(0);
  });

  it('7. already claimed → CONFLICT', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'dup', claimedAt: NOW - 5000 }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'dup', NOW, spy.grantFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICT');
    expect(spy.calls.length).toBe(0);
  });

  it('8. expired → BAD_REQUEST', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'old', expiresAt: NOW - 1000 }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'old', NOW, spy.grantFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BAD_REQUEST');
    expect(spy.calls.length).toBe(0);
  });

  it('NOT_FOUND when messageId does not exist', () => {
    const nak = makeNakama();
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'missing', NOW, spy.grantFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('9. cosmetic reward — claimedAt set, no wallet grant (handler applies cosmetic)', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'c', reward: { cosmeticId: 'decal_spark' } }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'c', NOW, spy.grantFn);
    expect(result.ok).toBe(true);
    expect(spy.calls.length).toBe(0); // no coin/gem grant
    if (!result.ok) return;
    expect(result.message.claimedAt).toBe(NOW);
    // Cosmetic application lives in the inbox_claim RPC handler (after
    // the claim CAS) — covered by the e2e suite.
  });

  it('10. car reward — claimedAt set, no wallet grant (handler adds car)', () => {
    const nak = makeNakama();
    writeDirectly(nak, makeBaseMessage({ id: 'car', reward: { carId: 'starter_viper' } }));
    const spy = makeGrantSpy();
    const result = claimInbox(nak.nakama, USER, 'car', NOW, spy.grantFn);
    expect(result.ok).toBe(true);
    expect(spy.calls.length).toBe(0);
    if (!result.ok) return;
    expect(result.message.claimedAt).toBe(NOW);
  });
});
