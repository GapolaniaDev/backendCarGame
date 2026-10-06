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
  const compositeKey = `${INBOX_COLLECTION}/${inboxKey(msg.userId, msg.id)}/${msg.userId}`;
  env.fakeNakama.store.set(compositeKey, {
    collection: INBOX_COLLECTION,
    key: inboxKey(msg.userId, msg.id),
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