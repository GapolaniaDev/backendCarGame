// Race reports are owned by the system user (plan fishnet-fixes T-01, D-05, P-10).
//
// A quick_bots race has bots whose ids (`bot_qb_d4_0`) are not user UUIDs, so a
// report stored with the bot as owner is rejected by the real server ("invalid
// user ID") and the session never closed. The FakeNakama now rejects such
// owners too, so these tests fail on the old report layout.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, seedRaceGarage, SYSTEM_USER_ID, type LoadedBundle } from './_stubs';
import type { RaceSession } from '../../modules/src/race/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const HOST_ID = '5a1b2c3d-1111-4222-8333-444455556666';
const LAPS = [48_100, 48_100, 48_100];
const TOTAL_MS = LAPS.reduce((a, b) => a + b, 0);

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, JSON.stringify(payload))) as Resp<T>;
}

function stored(env: LoadedBundle, sid: string): RaceSession {
  return env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`)?.value as unknown as RaceSession;
}

function startQuickBots(env: LoadedBundle): string {
  const r = call<{ sessionId: string }>(env, 'race_session_quick_bots', HOST_ID, {
    callerUserId: HOST_ID,
    size: 4,
    trackId: 'neon_blvd',
    hostLoadout: { classId: 'D', bodyId: 'starter_viper' },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  // Inside the abandon window, past the minimum lap time.
  stored(env, r.data.sessionId).startedAt = Date.now() - 200_000;
  return r.data.sessionId;
}

/** The host submits a report on behalf of `userId` (its own, or a bot's). */
function submit(env: LoadedBundle, sid: string, userId: string, isBot: boolean, requestId?: string) {
  return call<{ confidence: string }>(env, 'race_submit_result', HOST_ID, {
    sessionId: sid,
    report: { userId, totalMs: TOTAL_MS, laps: LAPS, isBotReport: isBot },
    ...(requestId ? { requestId } : {}),
  });
}

describe('race reports owned by the system user (P-10)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    seedRaceGarage(env.nak, HOST_ID, 'D');
  });

  it('a quick_bots race of 4 closes once the host sends its report and the three bot reports, and the human is paid', () => {
    const sid = startQuickBots(env);
    const bots = stored(env, sid).roster.filter((e) => e.isBot).map((e) => e.userId);
    expect(bots).toHaveLength(3);

    for (const bot of bots) {
      const r = submit(env, sid, bot, true);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect(stored(env, sid).state).toBe('started');
    const last = submit(env, sid, HOST_ID, false);
    expect(last.ok, JSON.stringify(last)).toBe(true);

    expect(stored(env, sid).state).toBe('closed');
    expect(env.fakeNakama.wallets.get(HOST_ID)?.['coins'] ?? 0).toBeGreaterThan(0);
    // Every report is owned by the system user, bots and human alike.
    for (const id of [HOST_ID, ...bots]) {
      expect(env.fakeNakama.store.has(`race_sessions/${sid}/reports/${id}/${SYSTEM_USER_ID}`)).toBe(true);
    }
  });

  it('a report written by the old layout (human owner) is still read: a retried requestId replays', () => {
    const sid = startQuickBots(env);
    const first = submit(env, sid, HOST_ID, false, 'req-legacy');
    expect(first.ok).toBe(true);

    // Move the report to where a previous version stored it: owned by the human.
    const key = `race_sessions/${sid}/reports/${HOST_ID}`;
    const row = env.fakeNakama.store.get(`${key}/${SYSTEM_USER_ID}`);
    expect(row).toBeDefined();
    env.fakeNakama.store.delete(`${key}/${SYSTEM_USER_ID}`);
    env.fakeNakama.store.set(`${key}/${HOST_ID}`, { ...row!, userId: HOST_ID });

    const retry = submit(env, sid, HOST_ID, false, 'req-legacy');
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
  });
});