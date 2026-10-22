// E2E tests for the F1 race fixes of the audit plan (cards T-06…T-10):
// active-session index, garage loadout, close with grace, reachable host
// claim, matchmaker session, quorum and durable submit retries.
//
// Unlike the older race suites this file does NOT auto-seed garages from
// the declared loadout: every player gets an explicit garage, so the
// loadout the server derives (T-10) is the one under test.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeContext,
  loadBundleForTest,
  SYSTEM_USER_ID,
  seedRaceGarage,
  type LoadedBundle,
} from './_stubs';
import type { RaceSession } from '../../modules/src/race/types';

type Resp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const A = 'f1-player-a';
const B = 'f1-player-b';
const C = 'f1-player-c';

// neon_blvd private = 3 laps; class D >= 48 000 ms per lap.
const D_LAPS = [48_100, 48_100, 48_100];
const D_TOTAL = D_LAPS.reduce((x, y) => x + y, 0);
// Valid for a class-S car (32 000 ms per lap), below the class-D floor.
const S_LAPS = [32_100, 32_100, 32_100];

function call<T>(env: LoadedBundle, rpc: string, caller: string, payload: unknown): Resp<T> {
  const handler = env.resolver(rpc);
  if (!handler) throw new Error(`no rpc: ${rpc}`);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(handler({ ...FakeContext, userId: caller }, env.logger, env.nak, body)) as Resp<T>;
}

function storedSession(env: LoadedBundle, sid: string): RaceSession {
  const obj = env.fakeNakama.store.get(`race_sessions/${sid}/${SYSTEM_USER_ID}`);
  if (!obj) throw new Error(`no session ${sid}`);
  return obj.value as unknown as RaceSession;
}

/** Shift the stored session's clock back so full-length reports pass. */
function backdate(env: LoadedBundle, sid: string, ms: number): void {
  const s = storedSession(env, sid);
  s.startedAt = (s.startedAt ?? Date.now()) - ms;
  if (s.claimedAt !== undefined) s.claimedAt -= ms;
}

function createPrivate(env: LoadedBundle, host: string, size: 2 | 4 = 4, classId = 'D'): string {
  const r = call<{ sessionId: string }>(env, 'race_session_create', host, {
    matchId: `m-${host}`,
    mode: 'private',
    trackId: 'neon_blvd',
    size,
    hostLoadout: { classId, bodyId: 'starter_viper' },
    hostUserId: host,
  });
  if (!r.ok) throw new Error(`create: ${JSON.stringify(r.error)}`);
  return r.data.sessionId;
}

function join(env: LoadedBundle, sid: string, user: string, classId = 'D'): Resp<unknown> {
  return call(env, 'race_session_join', user, {
    sessionId: sid,
    userId: user,
    loadout: { classId, bodyId: 'starter_viper' },
  });
}

function start(env: LoadedBundle, sid: string, host: string): void {
  const r = call(env, 'race_session_start', host, { sessionId: sid });
  if (!r.ok) throw new Error(`start: ${JSON.stringify(r.error)}`);
}

function submit(env: LoadedBundle, sid: string, user: string, laps = D_LAPS, extra: Record<string, unknown> = {}) {
  return call<{ accepted: boolean; confidence: string; officialResults?: unknown[] }>(
    env, 'race_submit_result', user, {
      sessionId: sid,
      report: { userId: user, totalMs: laps.reduce((x, y) => x + y, 0), laps, isBotReport: false },
      ...extra,
    },
  );
}

/** Move every report (and the start) back so the close grace has expired. */
function expireGrace(env: LoadedBundle, sid: string): void {
  const s = storedSession(env, sid);
  for (const e of s.roster) if (e.reportedAt !== undefined) e.reportedAt -= 31_000;
}

function getById(env: LoadedBundle, user: string, sid: string) {
  return call<{ session: RaceSession }>(env, 'race_session_get', user, { sessionId: sid });
}

function getActive(env: LoadedBundle, user: string) {
  return call<{ session: RaceSession; lastClosed?: RaceSession }>(env, 'race_session_get', user, {});
}

describe('F1 races (plan T-06…T-10)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    for (const u of [A, B, C]) seedRaceGarage(env.nak, u, 'D');
  });

  describe('T-08 active-session index', () => {
    it('race_session_get without sessionId returns the session the caller created or joined', () => {
      const sid = createPrivate(env, A);
      expect(join(env, sid, B).ok).toBe(true);

      for (const u of [A, B]) {
        const got = getActive(env, u);
        expect(got.ok, JSON.stringify(got)).toBe(true);
        if (got.ok) expect(got.data.session.id).toBe(sid);
      }
      start(env, sid, A);
      const got = getActive(env, B);
      expect(got.ok && got.data.session.state).toBe('started');
    });

    it('a player outside every session still gets NOT_FOUND', () => {
      createPrivate(env, A);
      const got = getActive(env, C);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
    });

    it('after the close the index is released and the last closed session is returned', () => {
      const sid = createPrivate(env, A, 2);
      start(env, sid, A);
      backdate(env, sid, 200_000);
      expect(submit(env, sid, A).ok).toBe(true);

      expect(env.fakeNakama.store.has(`race_active/${A}/${SYSTEM_USER_ID}`)).toBe(false);
      const got = getActive(env, A);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.data.session.state).toBe('closed');
        expect(got.data.lastClosed?.id).toBe(sid);
      }
    });

    it('a newer session replaces the pointer; closing the old one keeps it', () => {
      const old = createPrivate(env, A, 2);
      start(env, old, A);
      const newer = createPrivate(env, A, 4);
      backdate(env, old, 200_000);
      expect(submit(env, old, A).ok).toBe(true);

      const got = getActive(env, A);
      expect(got.ok && got.data.session.id).toBe(newer);
    });
  });

  describe('T-06 close with absent players', () => {
    function threePlayerRace(): string {
      const sid = createPrivate(env, A, 4);
      expect(join(env, sid, B).ok).toBe(true);
      expect(join(env, sid, C).ok).toBe(true);
      start(env, sid, A);
      backdate(env, sid, 200_000);
      return sid;
    }

    it('stays open while the grace runs, then closes on read with the absent player DNF', () => {
      const sid = threePlayerRace();
      expect(submit(env, sid, A).ok).toBe(true);
      expect(submit(env, sid, B, [48_200, 48_200, 48_200]).ok).toBe(true);

      const during = getById(env, A, sid);
      expect(during.ok && during.data.session.state).toBe('started');

      expireGrace(env, sid);
      const after = getById(env, B, sid);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const session = after.data.session;
      expect(session.state).toBe('closed');
      const byUser = new Map(session.results.map((r) => [r.userId, r]));
      expect(byUser.get(A)?.rank).toBe(1);
      expect(byUser.get(B)?.rank).toBe(2);
      expect(byUser.get(C)?.abandoned).toBe(true);
      expect(session.roster.find((e) => e.userId === C)?.abandoned).toBe(true);
      // The lazy close paid the two finishers.
      expect(env.fakeLogger.lines.some((l) => l.includes(`economy payouts sid=${sid} paid=2`))).toBe(true);
      expect(env.fakeNakama.store.has(`race_open/${sid}/${SYSTEM_USER_ID}`)).toBe(false);
    });

    it('a late report after the grace gets CONFLICT and the session closes first', () => {
      const sid = threePlayerRace();
      expect(submit(env, sid, A).ok).toBe(true);
      expireGrace(env, sid);

      const late = submit(env, sid, C);
      expect(late.ok).toBe(false);
      if (!late.ok) {
        expect(late.error.code).toBe('CONFLICT');
        expect(late.error.details?.['reason']).toBe('BAD_STATE');
      }
      expect(storedSession(env, sid).state).toBe('closed');
    });

    it('a report inside the grace is still accepted and the last one closes the race', () => {
      const sid = threePlayerRace();
      expect(submit(env, sid, A).ok).toBe(true);
      expect(submit(env, sid, B).ok).toBe(true);
      const last = submit(env, sid, C);
      expect(last.ok).toBe(true);
      if (last.ok) expect(last.data.officialResults).toHaveLength(3);
    });

    it('a started session with no human report closes after ABANDONED_SESSION_MS', () => {
      const sid = createPrivate(env, A, 2);
      start(env, sid, A);
      backdate(env, sid, 31 * 60_000);
      const got = getById(env, A, sid);
      expect(got.ok && got.data.session.state).toBe('closed');
      if (got.ok) expect(got.data.session.results.every((r) => r.abandoned)).toBe(true);
    });
  });

  describe('T-07 host claim by last contact', () => {
    function runningRace(): string {
      const sid = createPrivate(env, A, 4);
      expect(join(env, sid, B).ok).toBe(true);
      expect(join(env, sid, C).ok).toBe(true);
      start(env, sid, A);
      backdate(env, sid, 60_000);
      return sid;
    }

    function claim(user: string, sid: string) {
      return call<{ newHost: string }>(env, 'race_host_claim', user, { sessionId: sid });
    }

    it('race_session_get records the caller and returns lastSeenMs per player', () => {
      const sid = runningRace();
      expect(getById(env, B, sid).ok).toBe(true);
      const got = getById(env, C, sid);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const seen = new Map(got.data.session.roster.map((e) => [e.userId, e.lastSeenMs]));
      expect(typeof seen.get(B)).toBe('number');
      expect(typeof seen.get(C)).toBe('number');
      expect(seen.get(A)).toBeUndefined();
      // Never written into the stored session (it would race the CAS).
      expect(storedSession(env, sid).roster.some((e) => e.lastSeenMs !== undefined)).toBe(false);
    });

    it('with the host still polling the claim is FORBIDDEN NOT_HOST', () => {
      const sid = runningRace();
      expect(getById(env, A, sid).ok).toBe(true);
      const r = claim(B, sid);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('FORBIDDEN');
        expect(r.error.details?.['reason']).toBe('NOT_HOST');
      }
    });

    it('a host silent for HOST_STALE_MS is claimed by the next live player', () => {
      const sid = runningRace();
      expect(getById(env, B, sid).ok).toBe(true);
      // C is behind B in the succession and B is live: C may not jump it.
      const early = claim(C, sid);
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.error.code).toBe('BAD_REQUEST');

      const r = claim(B, sid);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.data.newHost).toBe(B);
      expect(storedSession(env, sid).host).toBe(B);
    });
  });

  describe('T-10 loadout from the garage', () => {
    it('a declared car the player does not own is replaced by the garage car', () => {
      const r = call<{ sessionId: string }>(env, 'race_session_create', A, {
        matchId: 'm-t10',
        mode: 'private',
        trackId: 'neon_blvd',
        size: 2,
        hostLoadout: { classId: 'S', bodyId: 'titan_s1' },
        hostUserId: A,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(join(env, r.data.sessionId, B, 'S').ok).toBe(true);

      const roster = storedSession(env, r.data.sessionId).roster;
      for (const e of roster) {
        expect(e.loadout.classId).toBe('D');
        expect(e.loadout.bodyId).toBe('starter_viper');
      }
      expect(env.fakeLogger.lines.some((l) => /declared loadout titan_s1\/S ignored/.test(l))).toBe(true);
    });

    it('the min-time floor is the garage car class, not the declared one', () => {
      const r = call<{ sessionId: string }>(env, 'race_session_create', A, {
        matchId: 'm-t10b',
        mode: 'private',
        trackId: 'neon_blvd',
        size: 2,
        hostLoadout: { classId: 'S', bodyId: 'titan_s1' },
        hostUserId: A,
      });
      if (!r.ok) throw new Error('create failed');
      start(env, r.data.sessionId, A);
      backdate(env, r.data.sessionId, 200_000);

      const fast = submit(env, r.data.sessionId, A, S_LAPS);
      expect(fast.ok).toBe(false);
      if (!fast.ok) {
        expect(fast.error.code).toBe('INVALID_RESULT');
        expect(fast.error.details?.['reason']).toBe('BELOW_MIN_TIME');
        expect(fast.error.details?.['classId']).toBe('D');
      }
    });

    it('an owned declared car is used with its catalog class', () => {
      seedRaceGarage(env.nak, A, 'S');
      seedRaceGarage(env.nak, A, 'D'); // owns both, active = D
      const r = call<{ sessionId: string }>(env, 'race_session_create', A, {
        matchId: 'm-t10c',
        mode: 'private',
        trackId: 'neon_blvd',
        size: 2,
        hostLoadout: { classId: 'D', bodyId: 'titan_s1' },
        hostUserId: A,
      });
      if (!r.ok) throw new Error('create failed');
      const host = storedSession(env, r.data.sessionId).roster[0]!;
      expect(host.loadout.bodyId).toBe('titan_s1');
      expect(host.loadout.classId).toBe('S');
    });
  });
});
