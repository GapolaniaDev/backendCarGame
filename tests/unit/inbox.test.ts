// The single inbox (plan T-17): `sendInbox`, `listInbox` and the
// one-transaction `claimInbox` (payout + garage delivery + claimedAt in
// one `moveWallet`), with the FakeNakama stub.

import { describe, it, expect } from 'vitest';

import {
  INBOX_COLLECTION,
  claimInbox,
  inboxKey,
  listInbox,
  sendInbox,
  type InboxMessage,
} from '../../modules/src/liveops/messages';
import { FakeLogger, FakeNakama } from '../e2e/_stubs';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const USER = 'user-inbox';

function stored(nak: FakeNakama, id: string): InboxMessage | undefined {
  return nak.store.get(`${INBOX_COLLECTION}/${inboxKey(nak.nakama, USER, id)}/${USER}`)?.value as InboxMessage | undefined;
}

function send(nak: FakeNakama, id: string, extra: Partial<InboxMessage> = {}, nowMs = NOW): void {
  sendInbox(nak.nakama, USER, { id, kind: 'reward', title: 't', body: 'b', ...extra }, nowMs);
}

const coinsOf = (nak: FakeNakama): number => nak.wallets.get(USER)?.['coins'] ?? 0;

describe('sendInbox', () => {
  it('stores an owner-read, server-write message with the 30-day TTL', () => {
    const nak = new FakeNakama();
    const r = sendInbox(nak.nakama, USER, { id: 'm1', kind: 'reward', title: 't', body: 'b', reward: { coins: 100 } }, NOW);
    expect(r.inserted).toBe(true);
    expect(r.message.expiresAt).toBe(NOW + 30 * DAY_MS);
    const obj = nak.store.get(`${INBOX_COLLECTION}/${USER}/m1/${USER}`);
    expect(obj?.permissionRead).toBe(1);
    expect(obj?.permissionWrite).toBe(0);
  });

  it('a duplicate id is ignored, also once claimed (never re-armed)', () => {
    const nak = new FakeNakama();
    send(nak, 'm1', { reward: { coins: 10 } });
    expect(claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW).ok).toBe(true);
    const again = sendInbox(nak.nakama, USER, { id: 'm1', kind: 'reward', title: 't', body: 'b', reward: { coins: 10 } }, NOW);
    expect(again.inserted).toBe(false);
    expect(stored(nak, 'm1')?.claimedAt).toBe(NOW);
  });

  it('hashes keys past 128 characters, and claims by the original id', () => {
    const nak = new FakeNakama();
    const id = `event_xp_applied:${'s'.repeat(60)}:${'u'.repeat(60)}`;
    send(nak, id, { reward: { coins: 5 } });
    const key = inboxKey(nak.nakama, USER, id);
    expect(key.startsWith(`${USER}/sha256:`)).toBe(true);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(listInbox(nak.nakama, USER, {}, NOW).messages[0]?.id).toBe(id);
    expect(claimInbox(nak.nakama, new FakeLogger(), USER, id, NOW).ok).toBe(true);
  });
});

describe('listInbox', () => {
  it('newest first, hides claimed unless asked, unread excludes expired', () => {
    const nak = new FakeNakama();
    send(nak, 'old', {}, NOW - 2000);
    send(nak, 'new', {}, NOW);
    send(nak, 'gone', { expiresAt: NOW - 1 }, NOW - 1000);
    claimInbox(nak.nakama, new FakeLogger(), USER, 'old', NOW - 1500);
    const def = listInbox(nak.nakama, USER, {}, NOW);
    expect(def.messages.map((m) => m.id)).toEqual(['new', 'gone']);
    expect(def.unreadCount).toBe(1);
    expect(listInbox(nak.nakama, USER, { includeClaimed: true }, NOW).messages.map((m) => m.id)).toEqual(['new', 'gone', 'old']);
  });
});

describe('claimInbox — one transaction', () => {
  it('pays coins and gems once, with a ledger row and the claim mark', () => {
    const nak = new FakeNakama();
    send(nak, 'm1', { reward: { coins: 300, gems: 2 } });
    const r = claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW);
    expect(r).toMatchObject({ ok: true, newBalance: { coins: 300, gems: 2 } });
    expect(stored(nak, 'm1')?.claimedAt).toBe(NOW);
    expect(nak.ledger.get(USER)?.length).toBe(1);

    const again = claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW);
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(coinsOf(nak)).toBe(300);
  });

  it('a concurrent claim that wins first → this one gets CONFLICT and nothing is paid twice', () => {
    const nak = new FakeNakama();
    send(nak, 'm1', { reward: { coins: 300 } });
    const core = nak.nakama as unknown as { multiUpdate: (...a: unknown[]) => unknown };
    const real = core.multiUpdate.bind(core);
    let raced = false;
    core.multiUpdate = (...args: unknown[]) => {
      if (!raced) {
        raced = true;
        // The other request commits between our read and our write.
        expect(claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW).ok).toBe(true);
      }
      return real(...args);
    };
    const r = claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW);
    expect(r).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(coinsOf(nak)).toBe(300);
    expect(nak.ledger.get(USER)?.length).toBe(1);
  });

  it('a failed payout writes nothing: the reward stays claimable and the error is an envelope code', () => {
    const nak = new FakeNakama();
    send(nak, 'm1', { reward: { coins: 300 } });
    const core = nak.nakama as unknown as { multiUpdate: (...a: unknown[]) => unknown };
    const real = core.multiUpdate.bind(core);
    core.multiUpdate = () => { throw new Error('db down'); };
    const failed = claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW);
    expect(failed).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(stored(nak, 'm1')?.claimedAt).toBeUndefined();
    expect(coinsOf(nak)).toBe(0);

    core.multiUpdate = real;
    expect(claimInbox(nak.nakama, new FakeLogger(), USER, 'm1', NOW)).toMatchObject({ ok: true, newBalance: { coins: 300 } });
  });

  it('a notice (no reward) is acknowledged without a payout', () => {
    const nak = new FakeNakama();
    sendInbox(nak.nakama, USER, { id: 'n1', kind: 'system', title: 't', body: 'b', granted: { coins: 10 } }, NOW);
    const r = claimInbox(nak.nakama, new FakeLogger(), USER, 'n1', NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.newBalance).toBeUndefined();
    expect(coinsOf(nak)).toBe(0);
  });

  it('unknown → NOT_FOUND; expired → BAD_REQUEST mentioning expiry', () => {
    const nak = new FakeNakama();
    expect(claimInbox(nak.nakama, new FakeLogger(), USER, 'nope', NOW)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    send(nak, 'late', { reward: { coins: 1 }, expiresAt: NOW - 1 }, NOW - 10);
    const r = claimInbox(nak.nakama, new FakeLogger(), USER, 'late', NOW);
    expect(r).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(!r.ok && r.message).toMatch(/expire/);
  });
});
