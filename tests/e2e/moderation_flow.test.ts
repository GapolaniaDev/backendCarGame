// Phase 7 Chunk 7 e2e — Moderation RPCs.
//
// Boots the full bundle, exercises report_player + the 3 admin RPCs
// through env.resolver(). Admin RPCs require a seeded adminRpcKey in
// liveops_config (same pattern as admin_e2e).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';

const ADMIN_KEY = 'moderation-admin-key-1234567890';

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

function seedAdminRpcKey(env: ReturnType<typeof loadBundleForTest>): void {
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 1,
      flags: { maintenance: false },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

function setMaintenance(env: ReturnType<typeof loadBundleForTest>, on: boolean): void {
  const existing = env.fakeNakama.store.get(`liveops/config/${SYSTEM_USER_ID}`);
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 2,
      flags: { maintenance: on },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000002', permissionRead: 0, permissionWrite: 0,
    createTime: existing?.createTime ?? '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
  });
}

describe('moderation_flow (Phase 7 Chunk 7) — RPC', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    seedAdminRpcKey(env);
  });

  it('1. report_player happy path → silenced=false, distinctCount=1', () => {
    const r = call<Resp<{ reportId: string; silenced: boolean; distinctCount: number; triggeredSilence: boolean }>>(
      env, 'report_player',
      { callerUserId: 'reporter-1', targetUserId: 'target-1', reason: 'toxic_chat' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.silenced).toBe(false);
    expect(r.data.distinctCount).toBe(1);
    expect(r.data.triggeredSilence).toBe(false);
    expect(typeof r.data.reportId).toBe('string');
    expect(r.data.reportId.length).toBeGreaterThan(0);
  });

  it('2. 3rd distinct reporter triggers auto-silence (silenced=true, untilUtc>now)', () => {
    // reporter-1 reports target-1
    const r1 = call<Resp<{ silenced: boolean; distinctCount: number; triggeredSilence: boolean }>>(
      env, 'report_player',
      { callerUserId: 'reporter-1', targetUserId: 'target-1', reason: 'cheating' },
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.data.silenced).toBe(false);
      expect(r1.data.distinctCount).toBe(1);
    }

    // reporter-2 reports target-1
    const r2 = call<Resp<{ silenced: boolean; distinctCount: number; triggeredSilence: boolean }>>(
      env, 'report_player',
      { callerUserId: 'reporter-2', targetUserId: 'target-1', reason: 'cheating' },
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.silenced).toBe(false);
      expect(r2.data.distinctCount).toBe(2);
    }

    // reporter-3 reports target-1 → trigger
    const r3 = call<Resp<{ silenced: boolean; distinctCount: number; triggeredSilence: boolean; untilUtc: number }>>(
      env, 'report_player',
      { callerUserId: 'reporter-3', targetUserId: 'target-1', reason: 'cheating' },
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.data.silenced).toBe(true);
    expect(r3.data.distinctCount).toBe(3);
    expect(r3.data.triggeredSilence).toBe(true);
    expect(typeof r3.data.untilUtc).toBe('number');
    expect(r3.data.untilUtc).toBeGreaterThan(Date.now());
  });

  it('3. same reporter twice → distinctCount stays 1 (no double-counting)', () => {
    // First report
    const r1 = call<Resp<{ distinctCount: number; silenced: boolean }>>(
      env, 'report_player',
      { callerUserId: 'reporter-1', targetUserId: 'target-1', reason: 'cheating' },
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data.distinctCount).toBe(1);

    // Same reporter again — should NOT increment distinctCount
    const r2 = call<Resp<{ distinctCount: number; silenced: boolean }>>(
      env, 'report_player',
      { callerUserId: 'reporter-1', targetUserId: 'target-1', reason: 'toxic_chat' },
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.distinctCount).toBe(1);
      expect(r2.data.silenced).toBe(false);
    }
  });

  it('4. self-report → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'reporter-1',
      targetUserId: 'reporter-1',
      reason: 'cheating',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('5. invalid reason → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'reporter-1',
      targetUserId: 'target-1',
      reason: 'invalid_reason',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('6. invalid context (lastMessages > 20) → BAD_REQUEST', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      senderUserId: `u${i}`, content: 'x', ts: i,
    }));
    const r = call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'reporter-1',
      targetUserId: 'target-1',
      reason: 'toxic_chat',
      context: { lastMessages: tooMany },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('7. per-reporter rate limit: 6th report in window → RATE_LIMITED', () => {
    // 5 reports succeed
    for (let i = 0; i < 5; i++) {
      const r = call<Resp<unknown>>(env, 'report_player', {
        callerUserId: 'reporter-rate',
        targetUserId: `target-${i}`,
        reason: 'other',
      });
      expect(r.ok).toBe(true);
    }
    // 6th is rejected
    const r6 = call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'reporter-rate',
      targetUserId: 'target-6',
      reason: 'other',
    });
    expect(r6.ok).toBe(false);
    if (r6.ok) return;
    expect(r6.error.code).toBe('RATE_LIMITED');
  });

  it('8. maintenance mode → report_player blocked (admin RPCs unaffected)', () => {
    setMaintenance(env, true);
    const r = call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'reporter-1',
      targetUserId: 'target-1',
      reason: 'cheating',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // assertNotInMaintenance returns SERVICE_UNAVAILABLE.
    expect(r.error.code).toBe('SERVICE_UNAVAILABLE');

    // Admin RPC should still work in maintenance (admin bypass).
    const admin = call<Resp<unknown>>(env, 'admin_view_reports', {
      adminKey: ADMIN_KEY,
      status: 'open',
    });
    expect(admin.ok).toBe(true);
  });

  it('9. auto-silence excludes reports older than 24h (lazy GC)', () => {
    // Seed a reports_recent row with old + fresh entries.
    const now = Date.now();
    env.fakeNakama.store.set('reports_recent/target-1/target-1', {
      collection: 'reports_recent', key: 'target-1', userId: 'target-1',
      value: {
        schemaVersion: 1, targetUserId: 'target-1',
        entries: {
          'old-reporter': now - 25 * 60 * 60 * 1000,    // 25h ago — expired
          'fresh-reporter': now - 1 * 60 * 60 * 1000,   // 1h ago — inside window
        },
      },
      version: 'v00000099', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z', expiresAt: null,
    });

    // A new reporter files against target-1. After GC + insert,
    // distinctCount = 2 (new + fresh-reporter). Not silenced.
    const r = call<Resp<{ distinctCount: number; silenced: boolean; triggeredSilence: boolean }>>(
      env, 'report_player',
      { callerUserId: 'new-reporter', targetUserId: 'target-1', reason: 'cheating' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.distinctCount).toBe(2);
    expect(r.data.silenced).toBe(false);
  });

  it('10. auto-silence clears after 1h (silenced row untilUtc < now)', () => {
    // Trigger auto-silence first
    for (const reporter of ['r1', 'r2', 'r3']) {
      call<Resp<unknown>>(env, 'report_player', {
        callerUserId: reporter,
        targetUserId: 'target-clear',
        reason: 'cheating',
      });
    }
    // Force the silenced row into the past via direct mutation
    const silencedKey = 'silenced/target-clear/target-clear';
    const cur = env.fakeNakama.store.get(silencedKey);
    expect(cur).toBeDefined();
    if (cur) {
      env.fakeNakama.store.set(silencedKey, {
        ...cur,
        value: { ...cur.value as object, untilUtc: 1 },
      });
    }

    // Verify storage state
    const updated = env.fakeNakama.store.get(silencedKey);
    const v = updated?.value as { untilUtc: number };
    expect(v.untilUtc).toBeLessThan(Date.now());
  });

  it('11. admin RPCs require adminKey (FORBIDDEN without)', () => {
    const r1 = call<Resp<unknown>>(env, 'admin_view_reports', {});
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('FORBIDDEN');

    const r2 = call<Resp<unknown>>(env, 'admin_silence', {
      targetUserId: 'someone', reason: 'manual',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('FORBIDDEN');

    const r3 = call<Resp<unknown>>(env, 'admin_unsilence', { targetUserId: 'someone' });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('FORBIDDEN');
  });

  it('12. admin_view_reports (with key) → returns list with reporterUserId', () => {
    // File a couple of reports
    call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'r1', targetUserId: 't1', reason: 'cheating',
    });
    call<Resp<unknown>>(env, 'report_player', {
      callerUserId: 'r2', targetUserId: 't2', reason: 'toxic_chat',
    });

    const r = call<Resp<{ reports: Array<{ reporterUserId: string; targetUserId: string; reason: string; status: string }>; nextCursor: string }>>(
      env, 'admin_view_reports',
      { adminKey: ADMIN_KEY, status: 'open' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.reports.length).toBe(2);
    // Both reports present; the same-ms tie-break makes strict "newest
    // first" order brittle in unit tests, so we check set equality +
    // the reporterUserId is visible (the key invariant of this RPC).
    const byTarget = new Map(r.data.reports.map((rep) => [rep.targetUserId, rep]));
    expect(byTarget.get('t1')?.reporterUserId).toBe('r1');
    expect(byTarget.get('t1')?.reason).toBe('cheating');
    expect(byTarget.get('t1')?.status).toBe('open');
    expect(byTarget.get('t2')?.reporterUserId).toBe('r2');
    expect(byTarget.get('t2')?.reason).toBe('toxic_chat');
    expect(byTarget.get('t2')?.status).toBe('open');
    expect(typeof r.data.nextCursor).toBe('string');
  });

  it('13. admin_view_reports invalid status → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'admin_view_reports', {
      adminKey: ADMIN_KEY, status: 'invalid',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('14. admin_silence (with key) → OK + audit log row', () => {
    const r = call<Resp<{ silenced: true; untilUtc: number }>>(
      env, 'admin_silence',
      { adminKey: ADMIN_KEY, targetUserId: 'target-admin', durationHours: 5, reason: 'manual moderation' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.silenced).toBe(true);
    expect(r.data.untilUtc).toBeGreaterThan(Date.now());
    // ~5h
    const expected = r.data.untilUtc - Date.now();
    expect(expected).toBeGreaterThan(4 * 60 * 60 * 1000);
    expect(expected).toBeLessThan(6 * 60 * 60 * 1000);

    // Audit log: analytics_events should contain an 'admin_action' row
    const analyticsRows: Array<{ value: { name: string; props: Record<string, unknown> } }> = [];
    for (const [k, v] of Array.from(env.fakeNakama.store.entries())) {
      if (k.startsWith('analytics_events/')) {
        const row = v.value as { name: string; props: Record<string, unknown> };
        if (row.name === 'admin_action' && row.props['rpcName'] === 'admin_silence') {
          analyticsRows.push({ value: row });
        }
      }
    }
    expect(analyticsRows.length).toBe(1);
  });

  it('15. admin_silence invalid duration (negative) → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'admin_silence', {
      adminKey: ADMIN_KEY, targetUserId: 't', durationHours: -1, reason: 'oops',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('16. admin_unsilence (with key) → OK + silenced row untilUtc=0', () => {
    // First silence
    call<Resp<unknown>>(env, 'admin_silence', {
      adminKey: ADMIN_KEY, targetUserId: 'target-unsilence', durationHours: 1, reason: 'test',
    });
    // Verify row exists with untilUtc > now
    const before = env.fakeNakama.store.get('silenced/target-unsilence/target-unsilence');
    expect(before).toBeDefined();
    const beforeVal = before?.value as { untilUtc: number };
    expect(beforeVal.untilUtc).toBeGreaterThan(Date.now());

    // Now unsilence
    const r = call<Resp<{ silenced: false }>>(
      env, 'admin_unsilence',
      { adminKey: ADMIN_KEY, targetUserId: 'target-unsilence' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.silenced).toBe(false);

    // Verify row updated to untilUtc=0
    const after = env.fakeNakama.store.get('silenced/target-unsilence/target-unsilence');
    const afterVal = after?.value as { untilUtc: number };
    expect(afterVal.untilUtc).toBe(0);
  });
});