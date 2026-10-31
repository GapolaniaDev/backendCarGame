// Phase 5 Chunk 3 e2e tests for the per-user inbox RPCs.
//
// Covers the 5 cases from the peer spec:
//   1. Auth → `inbox_list` empty
//   2. Send via storage write (simulate admin) → `inbox_list` shows
//   3. `inbox_claim` (coins reward) → `wallet_get` reflects balance
//   4. Replay claim → CONFLICT
//   5. Expired message → BAD_REQUEST
//
// Plus a couple of invariant tests:
//   - inbox_list is NOT maintenance-gated
//   - inbox_claim IS maintenance-gated
//   - `wallet_get` is maintenance-gated (so inbox_claim's side-effect
//     contract is observable through wallet_get).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';
import {
  INBOX_COLLECTION,
  inboxKey,
} from '../../modules/src/liveops/messages';
import type { InboxMessage } from '../../modules/src/liveops/messages';
import {
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';

const USER = 'user-inbox-e2e';

interface InboxListOutput {
  messages: InboxMessage[];
  nextCursor: string;
  unreadCount: number;
}

interface WalletOutput {
  coins: number;
  gems: number;
  /** Per-currency deltas + ledger tail. */
  pending?: ReadonlyArray<{ reason: string; amount: number }>;
  ledgerTail?: ReadonlyArray<{ reason: string; sourceId?: string; changeset: Record<string, number> }>;
}

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
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

function callInboxList(env: ReturnType<typeof loadBundleForTest>, userId: string): Resp<InboxListOutput> {
  return call<Resp<InboxListOutput>>(
    env,
    'inbox_list',
    userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callInboxClaim(
  env: ReturnType<typeof loadBundleForTest>,
  userId: string,
  messageId: string,
): Resp<{ message: InboxMessage; newBalance?: { coins: number; gems: number } }> {
  return call<Resp<{ message: InboxMessage; newBalance?: { coins: number; gems: number } }>>(
    env,
    'inbox_claim',
    userId,
    { callerUserId: userId, messageId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

function callWalletGet(env: ReturnType<typeof loadBundleForTest>, userId: string): Resp<WalletOutput> {
  return call<Resp<WalletOutput>>(
    env,
    'wallet_get',
    userId,
    { callerUserId: userId, clientVersion: '1.0.0', platform: 'ios' },
  );
}

/** Simulate an admin writing an inbox message via raw storage (server-side path). */
function adminWriteInbox(
  env: ReturnType<typeof loadBundleForTest>,
  msg: InboxMessage,
): void {
  // The exact composite key the storage stub uses
  //   `${collection}/${key}/${userId}` with `key = inboxKey(...)`.
  const compositeKey = `${INBOX_COLLECTION}/${inboxKey(env.nak, msg.userId, msg.id)}/${msg.userId}`;
  env.fakeNakama.store.set(compositeKey, {
    collection: INBOX_COLLECTION,
    key: inboxKey(env.nak, msg.userId, msg.id),
    userId: msg.userId,
    value: msg as unknown as Record<string, unknown>,
    version: 'v00000001',
    permissionRead: 1,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    expiresAt: null,
  });
}

function flipMaintenance(env: ReturnType<typeof loadBundleForTest>, value: boolean): void {
  const stored = env.fakeNakama.store.get(LIVEOPS_STORAGE_KEY);
  expect(stored).toBeDefined();
  const current = stored?.value as LiveopsConfig;
  env.fakeNakama.store.set(LIVEOPS_STORAGE_KEY, {
    ...stored,
    value: { ...current, flags: { ...current.flags, maintenance: value } },
  });
}

describe('inbox (Phase 5 Chunk 3) — inbox_list RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('1. fresh user → empty inbox', () => {
    const r = callInboxList(env, USER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages).toEqual([]);
    expect(r.data.unreadCount).toBe(0);
  });

  it('2. admin writes → inbox_list shows it', () => {
    const now = Date.now();
    adminWriteInbox(env, {
      schemaVersion: 1,
      id: 'welcome-1',
      userId: USER,
      kind: 'reward',
      title: 'Welcome bonus',
      body: '500 coins on us.',
      reward: { coins: 500 },
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
    });

    const r = callInboxList(env, USER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages.length).toBe(1);
    expect(r.data.messages[0]?.id).toBe('welcome-1');
    expect(r.data.unreadCount).toBe(1);
  });

  it('inbox_list is NOT maintenance-gated — readable during splash', () => {
    flipMaintenance(env, true);
    const r = callInboxList(env, USER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages).toEqual([]);
    expect(r.data.unreadCount).toBe(0);
  });
});

describe('inbox (Phase 5 Chunk 3) — inbox_claim RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('claim credits the wallet — wallet_get reflects balance', () => {
    const now = Date.now();
    adminWriteInbox(env, {
      schemaVersion: 1,
      id: 'claim-1',
      userId: USER,
      kind: 'reward',
      title: 'Daily bonus',
      body: '100 coins.',
      reward: { coins: 100 },
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
    });

    const claim = callInboxClaim(env, USER, 'claim-1');
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data.message.claimedAt).toBeGreaterThan(0);
    expect(claim.data.newBalance).toEqual({ coins: 100, gems: 0 });

    const wallet = callWalletGet(env, USER);
    expect(wallet.ok).toBe(true);
    if (!wallet.ok) return;
    expect(wallet.data.coins).toBe(100);
  });

  it('4. replay claim → CONFLICT', () => {
    const now = Date.now();
    adminWriteInbox(env, {
      schemaVersion: 1,
      id: 'replay',
      userId: USER,
      kind: 'reward',
      title: 'bonus',
      body: 'bonus',
      reward: { coins: 50 },
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
    });

    const first = callInboxClaim(env, USER, 'replay');
    expect(first.ok).toBe(true);

    const second = callInboxClaim(env, USER, 'replay');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('5. expired message → BAD_REQUEST', () => {
    const now = Date.now();
    adminWriteInbox(env, {
      schemaVersion: 1,
      id: 'old',
      userId: USER,
      kind: 'reward',
      title: 'expired',
      body: 'expired',
      reward: { coins: 10 },
      createdAt: now - 40 * 86_400_000,
      expiresAt: now - 1 * 86_400_000, // expired yesterday
    });

    const r = callInboxClaim(env, USER, 'old');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('unknown messageId → NOT_FOUND', () => {
    const r = callInboxClaim(env, USER, 'never-existed');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('inbox_claim IS maintenance-gated → SERVICE_UNAVAILABLE', () => {
    flipMaintenance(env, true);
    const r = callInboxClaim(env, USER, 'anything');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
// ─── Plan T-17: one inbox for every reward sender ──────────────────────────

describe('inbox (plan T-17) — season rewards, notices and the legacy migration', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  const SYSTEM = '00000000-0000-0000-0000-000000000000';

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('a ranked season reward appears in inbox_list and pays once', async () => {
    const { sendReward } = await import('../../modules/src/liveops/inbox');
    const { payloadForTier } = await import('../../modules/src/ranked/season');
    const tier = payloadForTier('silver');
    sendReward(env.nak, USER, tier.type, tier.payload, 'season_2-rank-2', Date.now());

    const list = callInboxList(env, USER);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const msg = list.data.messages.find((m) => m.id === 'season_2-rank-2');
    expect(msg).toMatchObject({ kind: 'reward', source: 'season_silver', reward: { coins: 2500 } });

    const first = callInboxClaim(env, USER, 'season_2-rank-2');
    expect(first.ok && first.data.newBalance?.coins).toBe(2500);
    const second = callInboxClaim(env, USER, 'season_2-rank-2');
    expect(second.ok ? 'ok' : second.error.code).toBe('CONFLICT');
    expect(env.fakeNakama.wallets.get(USER)?.['coins']).toBe(2500);
  });

  it('a tournament prize notice appears and its claim pays nothing more', async () => {
    const { sendNotice } = await import('../../modules/src/liveops/inbox');
    sendNotice(env.nak, USER, 'tournament_prize', { coins: 400, note: 'Tournament prize: rank 1' }, 'tournament:t1:prize:u:1', Date.now());
    const list = callInboxList(env, USER);
    const msg = list.ok ? list.data.messages.find((m) => m.id === 'tournament:t1:prize:u:1') : undefined;
    expect(msg).toMatchObject({ kind: 'system', source: 'tournament_prize', granted: { coins: 400 } });
    expect(msg?.reward).toBeUndefined();
    const claim = callInboxClaim(env, USER, 'tournament:t1:prize:u:1');
    expect(claim.ok).toBe(true);
    expect(env.fakeNakama.wallets.get(USER)?.['coins'] ?? 0).toBe(0);
  });

  it('inbox_claim delivers catalog items and reports unknown ones (not silently)', () => {
    const now = Date.now();
    adminWriteInbox(env, {
      schemaVersion: 1, id: 'items', userId: USER, kind: 'reward', title: 't', body: 'b',
      reward: { cosmeticId: 'paint_red_flame', cosmeticIds: ['paint_red_flame', 'cosmetic_not_in_catalog'] },
      createdAt: now, expiresAt: now + 86_400_000,
    });
    const r = call<Resp<{ delivered?: { cosmeticId?: string }; undelivered?: string[] }>>(
      env, 'inbox_claim', USER, { messageId: 'items' },
    );
    expect(r).toMatchObject({ ok: true, data: { delivered: { cosmeticId: 'paint_red_flame' }, undelivered: ['cosmetic:cosmetic_not_in_catalog'] } });
    const garage = env.fakeNakama.store.get(`garage/${USER}/${USER}`)?.value as { cosmeticsBag: string[] };
    expect(garage.cosmeticsBag).toContain('paint_red_flame');
  });

  it('the boot migration moves liveops_inbox once: season → claimable (amount from the tier), others → notices', async () => {
    const { migrateLegacyInbox } = await import('../../modules/src/liveops/inbox_migration');
    // InitModule already ran it (empty) and wrote the marker.
    expect(env.fakeNakama.store.has(`migrations/inbox_v1/${SYSTEM}`)).toBe(true);
    env.fakeNakama.store.delete(`migrations/inbox_v1/${SYSTEM}`);
    const legacy = (key: string, value: Record<string, unknown>): void => {
      env.fakeNakama.store.set(`liveops_inbox/${USER}/${key}/${USER}`, {
        collection: 'liveops_inbox', key: `${USER}/${key}`, userId: USER, value, version: 'v1',
        permissionRead: 1, permissionWrite: 1, createTime: '', updateTime: '', expiresAt: null,
      });
    };
    legacy('season_2-rank-1', {
      schemaVersion: 1, rewardId: 'season_2-rank-1', userId: USER, type: 'season_gold',
      payload: { coins: 999_999, cosmetics: [] }, createdAt: 1, expiresAt: null, claimed: false,
    });
    legacy('tournament:t9:prize', {
      schemaVersion: 1, rewardId: 'tournament:t9:prize', userId: USER, type: 'tournament_prize',
      payload: { coins: 100 }, createdAt: 1, expiresAt: null, claimed: false,
    });

    const r = migrateLegacyInbox(env.nak, env.logger, Date.now());
    expect(r).toEqual({ rewards: 1, notices: 1, skipped: 0 });
    expect([...env.fakeNakama.store.keys()].some((k) => k.startsWith('liveops_inbox/'))).toBe(false);
    expect(migrateLegacyInbox(env.nak, env.logger, Date.now())).toBeNull();

    const list = callInboxList(env, USER);
    const season = list.ok ? list.data.messages.find((m) => m.id === 'season_2-rank-1') : undefined;
    expect(season?.reward?.coins).toBe(5000);
    const claim = callInboxClaim(env, USER, 'season_2-rank-1');
    expect(claim.ok && claim.data.newBalance?.coins).toBe(5000);
  });
});
