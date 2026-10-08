// Phase 8 Chunk 4 e2e tests — 6 anti-cheat admin RPCs wired into the
// bundle.
//
// Each test boots the full bundle (`modules/index.js`) via
// `loadBundleForTest`, seeds the liveops config with `adminRpcKey`,
// then drives each RPC through `env.resolver(...)`. The 6 RPCs:
//
//   1. admin_marks_list
//   2. admin_marks_partials_view
//   3. admin_marks_confirm
//   4. admin_marks_dismiss
//   5. admin_marks_sanction
//   6. admin_anti_cheat_stats_get
//
// All 6 require `assertAdminKey` (Phase 5 D7) and bypass the
// maintenance gate (admin ops continue during pause).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';

const ADMIN_KEY = 'anti-cheat-admin-key-v1';

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

function seedAdminRpcKey(env: ReturnType<typeof loadBundleForTest>, on = false): void {
  // The admin RPCs read liveops_config on every call (no cache). We
  // seed it once per test via direct store access so we don't depend on
  // the boot path.
  env.fakeNakama.store.set(`liveops/config/${SYSTEM_USER_ID}`, {
    collection: 'liveops', key: 'config', userId: SYSTEM_USER_ID,
    value: {
      schemaVersion: 1, version: 1,
      flags: { maintenance: on },
      minClientVersion: { ios: '0.1.0', android: '0.1.0', windows: '0.1.0', macos: '0.1.0', linux: '0.1.0' },
      regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://api.example.com' }],
      calendar: [],
      adminRpcKey: ADMIN_KEY,
    },
    version: 'v00000001', permissionRead: 0, permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
  });
}

function setMaintenance(env: ReturnType<typeof loadBundleForTest>, on: boolean): void {
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
    createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
  });
}

const ANTI_CHEAT_MARKS_COLLECTION = 'anti_cheat_marks';
const ANTI_CHEAT_MARKS_SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

function seedMarks(env: ReturnType<typeof loadBundleForTest>, userId: string, marks: Array<Record<string, unknown>>): void {
  env.fakeNakama.store.set(
    `${ANTI_CHEAT_MARKS_COLLECTION}/${userId}/${ANTI_CHEAT_MARKS_SYSTEM_USER}`,
    {
      collection: ANTI_CHEAT_MARKS_COLLECTION,
      key: userId,
      userId: ANTI_CHEAT_MARKS_SYSTEM_USER,
      value: { schemaVersion: 1, userId, marks },
      version: 'v00000099', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    },
  );
}

describe('anti_cheat_admin_e2e (Phase 8 Chunk 4) — 6 admin RPCs', () => {
  let env: ReturnType<typeof loadBundleForTest>;
  beforeEach(() => {
    env = loadBundleForTest();
    seedAdminRpcKey(env);
  });

  // ─── FORBIDDEN gate ─────────────────────────────────────────────────

  it('admin_marks_list without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_marks_list', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('admin_marks_partials_view without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_marks_partials_view', { raceId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
  });

  it('admin_marks_confirm without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_marks_confirm', { userId: 'u1', markId: 'm' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
  });

  it('admin_marks_dismiss without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_marks_dismiss', { userId: 'u1', markId: 'm', reason: 'r' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
  });

  it('admin_marks_sanction without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_marks_sanction', { userId: 'u1', markId: 'm', durationHours: 1, reason: 'r' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
  });

  it('admin_anti_cheat_stats_get without adminKey → FORBIDDEN', () => {
    const r = call<Resp<unknown>>(env, 'admin_anti_cheat_stats_get', { startDate: '2026-10-01', endDate: '2026-10-08' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
  });

  // ─── admin_marks_confirm ────────────────────────────────────────────

  it('admin_marks_confirm sets confirmed=true on the target mark', () => {
    seedMarks(env, 'u-confirm', [
      { id: 'm-a', raceId: 'r', kind: 'partial_impossible', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
      { id: 'm-b', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 2000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<{ confirmed: true; markId: string }>>(env, 'admin_marks_confirm', {
      adminKey: ADMIN_KEY, userId: 'u-confirm', markId: 'm-a',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.confirmed).toBe(true);
    expect(r.data.markId).toBe('m-a');
    const row = env.fakeNakama.store.get(`${ANTI_CHEAT_MARKS_COLLECTION}/u-confirm/${ANTI_CHEAT_MARKS_SYSTEM_USER}`);
    const marks = row?.value as { marks: Array<{ id: string; confirmed: boolean }> };
    expect(marks.marks.find((m) => m.id === 'm-a')?.confirmed).toBe(true);
    expect(marks.marks.find((m) => m.id === 'm-b')?.confirmed).toBe(false);
  });

  it('admin_marks_confirm rejects confirming a dismissed mark', () => {
    seedMarks(env, 'u-conflict', [
      { id: 'm-x', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: true },
    ]);
    const r = call<Resp<unknown>>(env, 'admin_marks_confirm', {
      adminKey: ADMIN_KEY, userId: 'u-conflict', markId: 'm-x',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('CONFLICT');
  });

  it('admin_marks_confirm → NOT_FOUND when markId absent', () => {
    seedMarks(env, 'u-confirm404', [
      { id: 'present', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<unknown>>(env, 'admin_marks_confirm', {
      adminKey: ADMIN_KEY, userId: 'u-confirm404', markId: 'ghost',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('NOT_FOUND');
  });

  // ─── admin_marks_dismiss ────────────────────────────────────────────

  it('admin_marks_dismiss sets dismissed=true + audit event', () => {
    seedMarks(env, 'u-dismiss', [
      { id: 'm-d', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<{ dismissed: true; markId: string }>>(env, 'admin_marks_dismiss', {
      adminKey: ADMIN_KEY, userId: 'u-dismiss', markId: 'm-d', reason: 'false positive',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.dismissed).toBe(true);
    const row = env.fakeNakama.store.get(`${ANTI_CHEAT_MARKS_COLLECTION}/u-dismiss/${ANTI_CHEAT_MARKS_SYSTEM_USER}`);
    const marks = row?.value as { marks: Array<{ id: string; dismissed: boolean }> };
    expect(marks.marks.find((m) => m.id === 'm-d')?.dismissed).toBe(true);
    // Analytics row written (per emitAdminAction).
    const analytics = Array.from(env.fakeNakama.store.values())
      .filter((o) => o.collection === 'analytics_events');
    expect(analytics.length).toBeGreaterThan(0);
    const match = analytics.find((o) => {
      const v = o.value as { name?: string; props?: { rpcName?: string } };
      return v.name === 'admin_action' && v.props?.rpcName === 'anti_cheat:marks_dismiss';
    });
    expect(match).toBeDefined();
  });

  it('admin_marks_dismiss rejects missing reason → BAD_REQUEST', () => {
    seedMarks(env, 'u-dismiss-no-reason', [
      { id: 'm-r', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<unknown>>(env, 'admin_marks_dismiss', {
      adminKey: ADMIN_KEY, userId: 'u-dismiss-no-reason', markId: 'm-r',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('BAD_REQUEST');
  });

  // ─── admin_marks_sanction ───────────────────────────────────────────

  it('admin_marks_sanction sets hiddenUntilUtc in the future', () => {
    const before = Date.now();
    seedMarks(env, 'u-sanction', [
      { id: 'm-s', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<{ hidden: boolean; untilUtc?: number }>>(env, 'admin_marks_sanction', {
      adminKey: ADMIN_KEY, userId: 'u-sanction', markId: 'm-s', durationHours: 24, reason: 'cheating',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hidden).toBe(true);
    expect(typeof r.data.untilUtc).toBe('number');
    expect(r.data.untilUtc).toBeGreaterThan(before);
    const row = env.fakeNakama.store.get(`${ANTI_CHEAT_MARKS_COLLECTION}/u-sanction/${ANTI_CHEAT_MARKS_SYSTEM_USER}`);
    const marks = row?.value as { marks: Array<{ id: string; hiddenUntilUtc?: number }> };
    expect(marks.marks.find((m) => m.id === 'm-s')?.hiddenUntilUtc).toBeDefined();
  });

  it('admin_marks_sanction with durationHours=0 clears hiddenUntilUtc', () => {
    const future = Date.now() + 60 * 60 * 1000;
    seedMarks(env, 'u-clear', [
      { id: 'm-c', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false, hiddenUntilUtc: future },
    ]);
    const r = call<Resp<{ hidden: boolean; untilUtc?: number }>>(env, 'admin_marks_sanction', {
      adminKey: ADMIN_KEY, userId: 'u-clear', markId: 'm-c', durationHours: 0, reason: 'overturned',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hidden).toBe(false);
    expect(r.data.untilUtc).toBeUndefined();
    const row = env.fakeNakama.store.get(`${ANTI_CHEAT_MARKS_COLLECTION}/u-clear/${ANTI_CHEAT_MARKS_SYSTEM_USER}`);
    const marks = row?.value as { marks: Array<{ id: string; hiddenUntilUtc?: number }> };
    expect(marks.marks.find((m) => m.id === 'm-c')?.hiddenUntilUtc).toBeUndefined();
  });

  it('admin_marks_sanction rejects bad durationHours → BAD_REQUEST', () => {
    seedMarks(env, 'u-bad-dur', [
      { id: 'm-bd', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1000, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<unknown>>(env, 'admin_marks_sanction', {
      adminKey: ADMIN_KEY, userId: 'u-bad-dur', markId: 'm-bd', durationHours: 99999, reason: 'r',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('BAD_REQUEST');
  });

  // ─── admin_marks_list ───────────────────────────────────────────────

  it('admin_marks_list paginates + filters by status', () => {
    seedMarks(env, 'u-list-1', [
      { id: 'p1', raceId: 'r', kind: 'partial_impossible', severity: 'low', detectedAt: 100, confirmed: false, dismissed: false },
      { id: 'p2', raceId: 'r', kind: 'partial_impossible', severity: 'low', detectedAt: 200, confirmed: false, dismissed: true },
    ]);
    seedMarks(env, 'u-list-2', [
      { id: 'p3', raceId: 'r', kind: 'abrupt_improvement', severity: 'high', detectedAt: 300, confirmed: false, dismissed: false },
    ]);

    const all = call<Resp<{ marks: Array<{ id: string }>; total: number; nextCursor: string }>>(env, 'admin_marks_list', {
      adminKey: ADMIN_KEY, status: 'all', limit: 10,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.marks).toHaveLength(3);
    // Newest first.
    expect(all.data.marks.map((m) => m.id)).toEqual(['p3', 'p2', 'p1']);

    const onlyPending = call<Resp<{ marks: Array<{ id: string }> }>>(env, 'admin_marks_list', {
      adminKey: ADMIN_KEY, status: 'pending',
    });
    expect(onlyPending.ok).toBe(true);
    if (!onlyPending.ok) return;
    expect(onlyPending.data.marks.map((m) => m.id).sort()).toEqual(['p1', 'p3']);

    const onlyDismissed = call<Resp<{ marks: Array<{ id: string }> }>>(env, 'admin_marks_list', {
      adminKey: ADMIN_KEY, status: 'dismissed',
    });
    expect(onlyDismissed.ok).toBe(true);
    if (!onlyDismissed.ok) return;
    expect(onlyDismissed.data.marks.map((m) => m.id)).toEqual(['p2']);
  });

  // ─── admin_marks_partials_view ──────────────────────────────────────

  it('admin_marks_partials_view reports per-sector violation', () => {
    env.fakeNakama.store.set(`race_partials/race-partials-v/${SYSTEM_USER_ID}`, {
      collection: 'race_partials', key: 'race-partials-v', userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, raceId: 'race-partials-v',
        partials: [
          { index: 0, timeMs: 0 },
          { index: 1, timeMs: 500 }, // sector 0→1 = 500ms, below 1000ms floor
          { index: 2, timeMs: 4000 },
        ],
      },
      version: 'v1', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    const r = call<Resp<{ hasViolation: boolean; sectorCount: number; found: boolean; violationAt?: number; deltaTimeMs?: number }>>(env, 'admin_marks_partials_view', {
      adminKey: ADMIN_KEY, raceId: 'race-partials-v', minSectionTimeMs: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hasViolation).toBe(true);
    expect(r.data.sectorCount).toBe(3);
    expect(r.data.found).toBe(true);
    expect(r.data.violationAt).toBe(1);
    expect(r.data.deltaTimeMs).toBe(500);
  });

  it('admin_marks_partials_view returns found=false when partials row absent', () => {
    const r = call<Resp<{ found: boolean; sectorCount: number }>>(env, 'admin_marks_partials_view', {
      adminKey: ADMIN_KEY, raceId: 'no-such-race',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.found).toBe(false);
    expect(r.data.sectorCount).toBe(0);
  });

  // ─── admin_anti_cheat_stats_get ─────────────────────────────────

  it('admin_anti_cheat_stats_get returns zero rows for absent dates', () => {
    const r = call<Resp<{ startDate: string; endDate: string; days: Array<{ marksTotal: number }> }>>(env, 'admin_anti_cheat_stats_get', {
      adminKey: ADMIN_KEY, startDate: '2026-10-01', endDate: '2026-10-03',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.days).toHaveLength(3);
    expect(r.data.days.every((d) => d.marksTotal === 0)).toBe(true);
  });

  it('admin_anti_cheat_stats_get returns persisted stats rows', () => {
    env.fakeNakama.store.set(`anti_cheat_stats/2026-10-05/${SYSTEM_USER_ID}`, {
      collection: 'anti_cheat_stats', key: '2026-10-05', userId: SYSTEM_USER_ID,
      value: {
        schemaVersion: 1, utcDate: '2026-10-05', marksTotal: 5,
        marksByKind: { partial_impossible: 3, abrupt_improvement: 2, quorum_disagreement: 0 },
        marksBySeverity: { low: 3, medium: 2, high: 0 },
        usersHidden: 1, usersConfirmed: 2,
      },
      version: 'v1', permissionRead: 1, permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00', expiresAt: null,
    });
    const r = call<Resp<{ days: Array<{ utcDate: string; marksTotal: number }> }>>(env, 'admin_anti_cheat_stats_get', {
      adminKey: ADMIN_KEY, startDate: '2026-10-05', endDate: '2026-10-05',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.days).toHaveLength(1);
    expect(r.data.days[0]?.marksTotal).toBe(5);
    expect(r.data.days[0]?.utcDate).toBe('2026-10-05');
  });

  it('admin_anti_cheat_stats_get rejects malformed dates → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'admin_anti_cheat_stats_get', {
      adminKey: ADMIN_KEY, startDate: 'yesterday', endDate: 'today',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('BAD_REQUEST');
  });

  it('admin_anti_cheat_stats_get rejects end < start → BAD_REQUEST', () => {
    const r = call<Resp<unknown>>(env, 'admin_anti_cheat_stats_get', {
      adminKey: ADMIN_KEY, startDate: '2026-10-08', endDate: '2026-10-01',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('BAD_REQUEST');
  });

  // ─── Maintenance bypass ────────────────────────────────────────────

  it('admin RPCs bypass the maintenance gate (admin_silence analog)', () => {
    setMaintenance(env, true);
    seedMarks(env, 'u-maint', [
      { id: 'm', raceId: 'r', kind: 'abrupt_improvement', severity: 'low', detectedAt: 1, confirmed: false, dismissed: false },
    ]);
    const r = call<Resp<{ confirmed: true }>>(env, 'admin_marks_confirm', {
      adminKey: ADMIN_KEY, userId: 'u-maint', markId: 'm',
    });
    expect(r.ok).toBe(true);
  });
});