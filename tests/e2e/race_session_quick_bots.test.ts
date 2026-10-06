// E2E tests for the Phase 4 Chunk 3 RPC: race_session_quick_bots.
//
//   - size=2 with 1 human → 1 human + 1 bot
//   - size=4 with 1 human → 1 human + 3 bots
//   - size=4 with 4 humans → 4 humans + 0 bots
//   - size=3 → BAD_REQUEST
//   - size=4, excludeTrackIds covers the entire catalog → fallback (still picks a track)
//   - explicit trackId is honored (and unknown trackId → NOT_FOUND)
//   - cross-user humanRoster (caller not first) → FORBIDDEN
//   - bot entries have isBot=true and botDifficulty populated
//   - host is the caller (humans only ever host)
//   - session is persisted with state='started' so race_submit_result can proceed

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest } from './_stubs';

const HOST_ID = 'user-host';
const OTHER_ID = 'user-other';

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

function quickBots(
  env: ReturnType<typeof loadBundleForTest>,
  caller: string,
  payload: Record<string, unknown>,
): Resp<unknown> {
  return call<Resp<unknown>>(env, 'race_session_quick_bots', caller, {
    callerUserId: caller,
    ...payload,
  });
}

const HOST_LOADOUT = { classId: 'C', bodyId: 'viper' };

describe('race_session_quick_bots (Phase 4 Chunk 3)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('size=2 with 1 human → 1 human + 1 bot', () => {
    const r = quickBots(env, HOST_ID, { size: 2, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { roster: Array<{ isBot: boolean }>; botCount: number; mode: string };
    expect(data.roster).toHaveLength(2);
    expect(data.roster.filter((e) => e.isBot)).toHaveLength(1);
    expect(data.botCount).toBe(1);
    expect(data.mode).toBe('quick_bots');
  });

  it('size=4 with 1 human → 1 human + 3 bots', () => {
    const r = quickBots(env, HOST_ID, { size: 4, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { roster: Array<{ isBot: boolean }>; botCount: number };
    expect(data.roster).toHaveLength(4);
    expect(data.roster.filter((e) => e.isBot)).toHaveLength(3);
    expect(data.botCount).toBe(3);
  });

  it('size=4 with 4 humans → 4 humans + 0 bots (full lobby)', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      humanRoster: [
        { userId: HOST_ID, rttMs: 30, rating: 1200 },
        { userId: 'user-b', rttMs: 60, rating: 1100 },
        { userId: 'user-c', rttMs: 90, rating: 1000 },
        { userId: 'user-d', rttMs: 120, rating: 1000 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { roster: Array<{ isBot: boolean; userId: string }>; botCount: number; host: string };
    expect(data.roster).toHaveLength(4);
    expect(data.roster.every((e) => !e.isBot)).toBe(true);
    expect(data.botCount).toBe(0);
    // Host = lowest-rtt human (HOST_ID with 30ms).
    expect(data.host).toBe(HOST_ID);
  });

  it('size=3 → BAD_REQUEST (size must be 2|4|6)', () => {
    const r = quickBots(env, HOST_ID, { size: 3 as never, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
    expect(r.error.message).toMatch(/size/);
  });

  it('size=1 → BAD_REQUEST', () => {
    const r = quickBots(env, HOST_ID, { size: 1 as never, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('humanRoster where caller is not first → FORBIDDEN (host must be the caller)', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      humanRoster: [
        { userId: OTHER_ID, rttMs: 30 },
        { userId: HOST_ID, rttMs: 60 },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN');
  });

  it('humanRoster with duplicate userIds → BAD_REQUEST', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      humanRoster: [
        { userId: HOST_ID, rttMs: 30 },
        { userId: HOST_ID, rttMs: 50 },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BAD_REQUEST');
    expect(r.error.message).toMatch(/duplicate/);
  });

  it('unknown trackId → NOT_FOUND', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      trackId: 'not_a_real_track',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('explicit trackId is honored and persisted', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      trackId: 'neon_blvd',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { trackId: string };
    expect(data.trackId).toBe('neon_blvd');
  });

  it('excludeTrackIds that cover every catalog track falls back gracefully (D2)', () => {
    // Pass an exclude list larger than the catalog so the intersection
    // is empty; pickTrack falls back to the full catalog so the
    // session still creates.
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      excludeTrackIds: ['neon_blvd', 'reef_run', 'mountain_pass', 'canyon_drift', 'harbor_sprint', 'factory_loop', '__nonexistent__'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { trackId: string };
    expect(typeof data.trackId).toBe('string');
    expect(data.trackId.length).toBeGreaterThan(0);
  });

  it('bot entries have isBot=true and a botDifficulty', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      callerRating: 1200,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { roster: Array<{ isBot: boolean; botDifficulty?: number }>; botDifficulty: number };
    const bots = data.roster.filter((e) => e.isBot);
    expect(bots.length).toBe(3);
    for (const b of bots) {
      expect(b.botDifficulty).toBe(data.botDifficulty);
    }
  });

  it('host is always a human (never a bot)', () => {
    const r = quickBots(env, HOST_ID, { size: 4, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { host: string; roster: Array<{ userId: string; isBot: boolean }> };
    expect(data.host).toBe(HOST_ID);
    const hostEntry = data.roster.find((e) => e.userId === data.host);
    expect(hostEntry?.isBot).toBe(false);
  });

  it('default callerRating=1000 yields bot difficulty 2 (silver)', () => {
    const r = quickBots(env, HOST_ID, { size: 4, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { botDifficulty: number };
    expect(data.botDifficulty).toBe(2);
  });

  it('callerRating=0 yields bot difficulty 0 (clamped)', () => {
    const r = quickBots(env, HOST_ID, {
      size: 4,
      hostLoadout: HOST_LOADOUT,
      callerRating: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { botDifficulty: number };
    expect(data.botDifficulty).toBe(0);
  });

  it('session is persisted with state=started and startedAt populated', () => {
    const r = quickBots(env, HOST_ID, { size: 4, hostLoadout: HOST_LOADOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { sessionId: string; startedAt: number };
    expect(typeof data.sessionId).toBe('string');
    expect(data.startedAt).toBeGreaterThan(0);

    // Read back from storage to confirm state=started. FakeNakama
    // keys are `collection/key/userId` (see _stubs.storageKeyString).
    const storeKey = `race_sessions/${data.sessionId}/00000000-0000-0000-0000-000000000000`;
    const stored = env.fakeNakama.store.get(storeKey);
    expect(stored).toBeDefined();
    const session = stored as unknown as { value: { state: string; startedAt: number; flags: { botSession?: boolean } } };
    expect(session.value.state).toBe('started');
    expect(session.value.startedAt).toBe(data.startedAt);
    expect(session.value.flags.botSession).toBe(true);
  });
});