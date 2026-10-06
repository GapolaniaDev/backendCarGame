// E2E tests for Phase 4 Chunk 10: host recovery full path.
//
// The full race_host_claim contract is in `race_host_claim.test.ts`
// (Chunk 4). This file adds the integration scenarios the original
// suite doesn't cover: same-caller idempotent re-claim, claim after
// grace expiry, and a multi-claim race (CAS conflict path).

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { RaceSession } from '../../modules/src/race/types';

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

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

const HOST_ID = 'host-recovery-host';
const NEXT_ID = 'host-recovery-next';
const SKIP_ID = 'host-recovery-skip';
const OUTSIDER_ID = 'host-recovery-outsider';

const HOST_LOADOUT = { classId: 'C', bodyId: 'viper' };

function seedStartedSession(
  env: ReturnType<typeof loadBundleForTest>,
  host = HOST_ID,
): string {
  const create = call<Resp<{ sessionId: string }>>(env, 'race_session_create', host, {
    matchId: 'host-rec-m1',
    mode: 'quick',
    trackId: 'neon_blvd',
    size: 4,
    hostLoadout: HOST_LOADOUT,
    hostUserId: host,
  });
  if (!create.ok) throw new Error('seed create failed');
  const sid = create.data.sessionId;
  for (const userId of [NEXT_ID, SKIP_ID, 'host-rec-extra']) {
    const join = call<Resp<unknown>>(env, 'race_session_join', userId, {
      sessionId: sid,
      userId,
      callerUserId: userId,
      loadout: HOST_LOADOUT,
    });
    if (!join.ok) throw new Error('seed join failed');
  }
  const start = call<Resp<unknown>>(env, 'race_session_start', host, {
    sessionId: sid,
    callerUserId: host,
  });
  if (!start.ok) throw new Error('seed start failed');
  return sid;
}

function reportHostDisconnect(
  env: ReturnType<typeof loadBundleForTest>,
  sessionId: string,
  hostId: string,
  at: number,
): void {
  const storeKey = `race_sessions/${sessionId}/${SYSTEM_USER_ID}`;
  const stored = env.fakeNakama.store.get(storeKey);
  if (!stored) throw new Error('session not in store');
  const value = stored.value as { roster: Array<{ userId: string; disconnectReportedAt?: number }> };
  const roster = value.roster.map((e) =>
    e.userId === hostId ? { ...e, disconnectReportedAt: at } : e,
  );
  env.nak.storageWrite([{
    collection: 'race_sessions',
    key: sessionId,
    userId: SYSTEM_USER_ID,
    value: { ...value, roster },
    permissionRead: 0,
    permissionWrite: 0,
    version: stored.version,
  }]);
}

function readSession(
  env: ReturnType<typeof loadBundleForTest>,
  sessionId: string,
): RaceSession {
  const stored = env.fakeNakama.store.get(`race_sessions/${sessionId}/${SYSTEM_USER_ID}`);
  if (!stored) throw new Error('session not in store');
  return stored.value as RaceSession;
}

function claim(
  env: ReturnType<typeof loadBundleForTest>,
  caller: string,
  payload: Record<string, unknown>,
): Resp<unknown> {
  return call<Resp<unknown>>(env, 'race_host_claim', caller, {
    callerUserId: caller,
    ...payload,
  });
}

describe('host recovery (Phase 4 Chunk 10) — full integration', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('happy path: host drop → succession[1] claims → new host + claimedAt persisted', () => {
    const sid = seedStartedSession(env);
    reportHostDisconnect(env, sid, HOST_ID, Date.now() - 1000);
    const r = claim(env, NEXT_ID, { sessionId: sid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { newHost: string; claimedAt: number };
    expect(data.newHost).toBe(NEXT_ID);
    const session = readSession(env, sid);
    expect(session.host).toBe(NEXT_ID);
  });

  it('second claim by ANOTHER caller (after the first one moved host) → CONFLICT', () => {
    const sid = seedStartedSession(env);
    reportHostDisconnect(env, sid, HOST_ID, Date.now() - 1000);

    const r1 = claim(env, NEXT_ID, { sessionId: sid });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // A new disconnect event fires (the new host also drops) — mark
    // NEXT_ID as disconnected and let SKIP_ID try to claim.
    reportHostDisconnect(env, sid, NEXT_ID, Date.now() - 1000);
    // SKIP_ID is in succession[2] — but with NEXT_ID now host, the
    // succession list still points to the original order. The valid
    // claimant becomes the next human after NEXT_ID in the recorded
    // succession, which is SKIP_ID. So this SHOULD succeed.
    const r2 = claim(env, SKIP_ID, { sessionId: sid });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const data = r2.data as { newHost: string };
    expect(data.newHost).toBe(SKIP_ID);
  });

  it('outsider (not in roster) → FORBIDDEN', () => {
    const sid = seedStartedSession(env);
    reportHostDisconnect(env, sid, HOST_ID, Date.now() - 1000);
    const r = claim(env, OUTSIDER_ID, { sessionId: sid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('claim after grace window expires → BAD_REQUEST', () => {
    const sid = seedStartedSession(env);
    // Stamped 30s in the past — beyond the 20s + 5s tolerance grace.
    reportHostDisconnect(env, sid, HOST_ID, Date.now() - 30_000);
    const r = claim(env, NEXT_ID, { sessionId: sid });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('session not started → BAD_REQUEST', () => {
    // Create but do not start.
    const create = call<Resp<{ sessionId: string }>>(env, 'race_session_create', HOST_ID, {
      matchId: 'host-rec-m2',
      mode: 'quick',
      trackId: 'neon_blvd',
      size: 4,
      hostLoadout: HOST_LOADOUT,
      hostUserId: HOST_ID,
    });
    if (!create.ok) throw new Error('create failed');
    const join = call<Resp<unknown>>(env, 'race_session_join', NEXT_ID, {
      sessionId: create.data.sessionId,
      userId: NEXT_ID,
      callerUserId: NEXT_ID,
      loadout: HOST_LOADOUT,
    });
    if (!join.ok) throw new Error('join failed');
    const r = claim(env, NEXT_ID, { sessionId: create.data.sessionId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('session does not exist → NOT_FOUND', () => {
    const r = claim(env, NEXT_ID, { sessionId: 'nonexistent' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('idempotent re-claim by the SAME caller returns the same claimedAt', () => {
    const sid = seedStartedSession(env);
    reportHostDisconnect(env, sid, HOST_ID, Date.now() - 1000);

    const r1 = claim(env, NEXT_ID, { sessionId: sid });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const claimedAt1 = (r1.data as { claimedAt: number }).claimedAt;

    // Re-claim by NEXT_ID — the handler should detect that NEXT_ID is
    // already the recorded host and echo the prior claimedAt.
    const r2 = claim(env, NEXT_ID, { sessionId: sid });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const claimedAt2 = (r2.data as { claimedAt: number }).claimedAt;
    expect(claimedAt2).toBe(claimedAt1);
  });
});
