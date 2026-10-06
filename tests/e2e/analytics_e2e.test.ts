// Phase 5 Chunk 7 e2e tests — server-emitted analytics events.
//
// Covers the 3 spec cases:
//   1. Full race lifecycle → `session_started` + `race_completed`
//      rows appear in the `analytics_events` storage collection.
//   2. admin_wallet_adjust → `admin_action` row appears.
//   3. With `analyticsWebhook` configured in liveops config → the
//      outbound POST is captured by the FakeNakama httpRequest stub.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
} from './_stubs';
import { ANALYTICS_COLLECTION } from '../../modules/src/core/admin/analytics';
import type {
  RaceSessionCreateOutput,
  RaceSubmitResultOutput,
} from '../../modules/src/race/types';
import type { IStorageObject } from '../../modules/src/nkruntime';

const ADMIN_KEY = 'test-admin-key-1234567890';
const HOST_ID = 'user-host';

function call<T>(
  env: ReturnType<typeof loadBundleForTest>,
  rpc: string,
  caller: string | null,
  payload: unknown,
): { ok: true; data: T } | { ok: false; error: { code: string; message: string } } {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const ctx = caller === null ? FakeContext : { ...FakeContext, userId: caller };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = handler(ctx, env.logger, env.nak, body);
  return JSON.parse(raw as string) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
}

function analyticsByName(
  store: Map<string, IStorageObject>,
  name: string,
): IStorageObject[] {
  const out: IStorageObject[] = [];
  for (const obj of store.values()) {
    if (obj.collection !== ANALYTICS_COLLECTION) continue;
    const v = obj.value as Record<string, unknown>;
    if (v['name'] === name) out.push(obj);
  }
  return out;
}

function setLiveops(
  env: ReturnType<typeof loadBundleForTest>,
  fields: Record<string, unknown>,
): void {
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops',
    key: 'config',
    userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1,
      version: 1,
      flags: { maintenance: false },
      minClientVersion: {
        ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0',
      },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      ...fields,
    },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    expiresAt: null,
  });
}

describe('analytics_e2e (Phase 5 Chunk 7) — emit', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    setLiveops(env, {});
  });

  it('1. full race lifecycle emits session_started + race_completed', () => {
    const P1 = 'user-p1';

    const create = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'match-analytics-1',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 2,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const sid = create.data.sessionId;

    const join = call<{ rosterVersion: number }>(env, 'race_session_join', null, {
      sessionId: sid, userId: P1, callerUserId: P1,
      loadout: { classId: 'B', bodyId: 'coupe' },
    });
    expect(join.ok).toBe(true);

    const start = call<{ startedAt: number }>(env, 'race_session_start', HOST_ID, {
      sessionId: sid, callerUserId: HOST_ID,
    });
    expect(start.ok).toBe(true);

    // Backdate so the submit-time clock check tolerates our short totalMs.
    const obj = env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`);
    if (obj) (obj.value as { startedAt: number }).startedAt = 1_000_000_000_000;

    const submit1 = call<RaceSubmitResultOutput>(env, 'race_submit_result', HOST_ID, {
      sessionId: sid, callerUserId: HOST_ID,
      report: { userId: HOST_ID, totalMs: 120_000, laps: [40_000, 40_000, 40_000], isBotReport: false },
    });
    expect(submit1.ok).toBe(true);

    const submit2 = call<RaceSubmitResultOutput>(env, 'race_submit_result', P1, {
      sessionId: sid, callerUserId: P1,
      report: { userId: P1, totalMs: 130_000, laps: [44_000, 44_000, 42_000], isBotReport: false },
    });
    expect(submit2.ok).toBe(true);

    const sessionRows = analyticsByName(env.fakeNakama.store, 'session_started');
    expect(sessionRows.length).toBe(1);
    const sRow = sessionRows[0];
    expect(sRow.userId).toBe(SYSTEM_USER_ID);
    const sValue = sRow.value as Record<string, unknown>;
    expect((sValue['props'] as Record<string, unknown>)['sessionId']).toBe(sid);
    expect((sValue['props'] as Record<string, unknown>)['hostId']).toBe(HOST_ID);
    expect((sValue['props'] as Record<string, unknown>)['mode']).toBe('quick');

    const completedRows = analyticsByName(env.fakeNakama.store, 'race_completed');
    expect(completedRows.length).toBe(1);
    const cValue = completedRows[0].value as Record<string, unknown>;
    expect((cValue['props'] as Record<string, unknown>)['sessionId']).toBe(sid);
    expect(((cValue['props'] as Record<string, unknown>)['finisherCount'])).toBe(2);
    expect(((cValue['props'] as Record<string, unknown>)['abandonedCount'])).toBe(0);
  });

  it('2. admin_wallet_adjust → admin_action row', () => {
    setLiveops(env, { adminRpcKey: ADMIN_KEY });
    env.fakeNakama.wallets.set('u1', { coins: 100 });

    const r = call<Resp<unknown>>(env, 'admin_wallet_adjust', null, {
      adminKey: ADMIN_KEY, userId: 'u1', coins: 1000, reason: 'manual top-up',
    });
    expect(r.ok).toBe(true);

    const rows = analyticsByName(env.fakeNakama.store, 'admin_action');
    expect(rows.length).toBe(1);
    const props = (rows[0].value as Record<string, unknown>)['props'] as Record<string, unknown>;
    expect(props['rpcName']).toBe('admin_wallet_adjust');
    expect(props['targetUserId']).toBe('u1');
    expect(props['coinsDelta']).toBe(1000);
  });

  it('3. analyticsWebhook configured → outbound POST captured', () => {
    setLiveops(env, { analyticsWebhook: 'https://analytics.example.com/hook' });

    const create = call<RaceSessionCreateOutput>(env, 'race_session_create', null, {
      matchId: 'match-webhook',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 2,
      hostLoadout: { classId: 'B', bodyId: 'coupe' },
      hostUserId: HOST_ID,
    });
    expect(create.ok).toBe(true);

    expect(env.fakeNakama.httpRequests.length).toBeGreaterThanOrEqual(1);
    const targetCall = env.fakeNakama.httpRequests.find(
      (c) => c.url === 'https://analytics.example.com/hook',
    );
    expect(targetCall).toBeDefined();
    expect(targetCall!.method).toBe('POST');
    expect(targetCall!.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(targetCall!.body) as Record<string, unknown>;
    expect(payload['name']).toBe('session_started');
    expect((payload['props'] as Record<string, unknown>)['hostId']).toBe(HOST_ID);
  });
});

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };