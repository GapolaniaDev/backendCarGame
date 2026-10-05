// Unit tests for `race/validation.ts` — pure, no Nakama I/O.

import { describe, it, expect } from 'vitest';
import {
  validateSubmissionStep1,
  validateSubmissionStep2,
} from '../../modules/src/race/validation';
import type { RaceSession, RosterEntry, RaceReport } from '../../modules/src/race/types';
import type { TrackEntry } from '../../modules/src/core/catalog';

const HOST = '11111111-1111-4111-1111-111111111111';
const PLAYER_A = '22222222-2222-4222-8222-222222222222';
const PLAYER_B = '33333333-3333-4333-8333-333333333333';

function makeSession(overrides: Partial<RaceSession> = {}): RaceSession {
  return {
    schemaVersion: 1,
    id: 'sid',
    matchId: 'match-1',
    mode: 'quick',
    trackId: 'neon_blvd',
    size: 4,
    roster: [
      { userId: HOST, loadout: { classId: 'C', bodyId: 'coupe' }, isBot: false },
      { userId: PLAYER_A, loadout: { classId: 'B', bodyId: 'coupe' }, isBot: false },
    ],
    host: HOST,
    hostSuccession: [HOST],
    state: 'started',
    startedAt: 1_000,
    results: [],
    flags: { needsReview: false },
    version: 4,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<TrackEntry> = {}): TrackEntry {
  return {
    id: 'neon_blvd',
    displayName: 'Neon Boulevard',
    modes: { quick: 3, ranked: 5, private: 3, time_trial: 1 },
    checkpoints: 8,
    minTimeMsByClass: { D: 48000, C: 44000, B: 40000, A: 36000, S: 32000 },
    ...overrides,
  };
}

function makeReport(overrides: Partial<RaceReport> = {}): RaceReport {
  return {
    userId: PLAYER_A,
    totalMs: 120_000,
    laps: [40_000, 40_000, 40_000],
    isBotReport: false,
    ...overrides,
  };
}

function makeRosterEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    userId: PLAYER_A,
    loadout: { classId: 'B', bodyId: 'coupe' },
    isBot: false,
    ...overrides,
  };
}

describe('validateSubmissionStep1', () => {
  it('accepts a roster member submitting in started', () => {
    const r = validateSubmissionStep1({
      session: makeSession(),
      reporterId: PLAYER_A,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a non-roster user with INVALID_RESULT / NOT_IN_ROSTER', () => {
    const r = validateSubmissionStep1({
      session: makeSession(),
      reporterId: PLAYER_B,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'NOT_IN_ROSTER' });
  });

  it('rejects a session in created state with CONFLICT / BAD_STATE', () => {
    const r = validateSubmissionStep1({
      session: makeSession({ state: 'created' }),
      reporterId: PLAYER_A,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.details).toMatchObject({ reason: 'BAD_STATE', state: 'created' });
  });

  it('accepts a session in closing state', () => {
    const r = validateSubmissionStep1({
      session: makeSession({ state: 'closing' }),
      reporterId: PLAYER_A,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a session in closed state with CONFLICT', () => {
    const r = validateSubmissionStep1({
      session: makeSession({ state: 'closed' }),
      reporterId: PLAYER_A,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.details).toMatchObject({ reason: 'BAD_STATE', state: 'closed' });
  });

  it('rejects a player who has already submitted with CONFLICT / ALREADY_REPORTED', () => {
    const session = makeSession();
    session.roster = session.roster.map((e) =>
      e.userId === PLAYER_A ? { ...e, reportedAt: 1500 } : e,
    );
    const r = validateSubmissionStep1({ session, reporterId: PLAYER_A });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.details).toMatchObject({ reason: 'ALREADY_REPORTED' });
  });
});

describe('validateSubmissionStep2 (Chunk 8)', () => {
  const TRACK = makeTrack();

  function step2Input(overrides: {
    session?: Partial<RaceSession>;
    reporter?: Partial<RosterEntry>;
    report?: Partial<RaceReport>;
    track?: TrackEntry;
    nowMs?: number;
  } = {}) {
    return {
      session: makeSession(overrides.session),
      reporter: makeRosterEntry(overrides.reporter),
      report: makeReport(overrides.report),
      track: overrides.track ?? TRACK,
      nowMs: overrides.nowMs ?? 121_500, // 500ms after totalMs
    };
  }

  // ── Clock ──────────────────────────────────────────────────────────────

  it('accepts a report within the clock window', () => {
    const r = validateSubmissionStep2(step2Input());
    expect(r.ok).toBe(true);
  });

  it('accepts a report with totalMs up to CLOCK_SKEW_TOLERANCE_MS past the wall clock', () => {
    // 1000 (started) + 120_000 (totalMs) = 121_000. nowMs = 121_500 → 500ms slack.
    const r = validateSubmissionStep2(step2Input({ nowMs: 121_500 }));
    expect(r.ok).toBe(true);
  });

  it('rejects when totalMs exceeds the wall clock by more than the tolerance (TIME_EXCEEDS_CLOCK)', () => {
    // 1000 + 120_000 = 121_000. nowMs = 120_000 → 1000ms late, exceeds 500ms.
    const r = validateSubmissionStep2(step2Input({ nowMs: 120_000 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'TIME_EXCEEDS_CLOCK' });
  });

  it('rejects when startedAt is null (CLOCK_UNSET)', () => {
    const r = validateSubmissionStep2(step2Input({ session: { startedAt: null } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'CLOCK_UNSET' });
  });

  // ── Min-time ───────────────────────────────────────────────────────────

  it('accepts a report exactly at the min-time threshold', () => {
    // quick/neon_blvd = 3 laps; class B minTimeMs = 40000. min total = 120_000.
    const r = validateSubmissionStep2(step2Input({ report: { totalMs: 120_000 } }));
    expect(r.ok).toBe(true);
  });

  it('rejects a report below the min-time threshold (BELOW_MIN_TIME)', () => {
    const r = validateSubmissionStep2(
      step2Input({ report: { totalMs: 119_999, laps: [40_000, 40_000, 39_999] } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'BELOW_MIN_TIME' });
  });

  it('scales the min-time with the player class (D class has the highest min)', () => {
    // D class on neon_blvd/quick: 3 * 48_000 = 144_000.
    // totalMs = 130_000 is below D's threshold but above B (120_000)
    // and S (96_000), proving the check is class-aware.
    const r = validateSubmissionStep2(
      step2Input({
        reporter: { loadout: { classId: 'D', bodyId: 'van' } },
        report: { totalMs: 130_000, laps: [43_334, 43_333, 43_333] },
        nowMs: 131_500,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({
      reason: 'BELOW_MIN_TIME',
      classId: 'D',
    });
  });

  // ── Lap count ──────────────────────────────────────────────────────────

  it('rejects when laps.length does not match the track/mode lap count (LAP_COUNT_MISMATCH)', () => {
    // quick/neon_blvd = 3 laps.
    const r = validateSubmissionStep2(
      step2Input({ report: { laps: [60_000, 60_000], totalMs: 120_000 } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'LAP_COUNT_MISMATCH', expected: 3, actual: 2 });
  });

  // ── Lap sum ────────────────────────────────────────────────────────────

  it('rejects when sum(laps) !== totalMs (LAP_SUM_MISMATCH)', () => {
    // Lap sum 120_000 but totalMs 130_000 — above the min-time floor
    // (B class × 3 laps = 120_000) so the LAP_SUM_MISMATCH branch fires
    // before BELOW_MIN_TIME. nowMs is set well past totalMs+startedAt
    // so the clock check doesn't preempt.
    const r = validateSubmissionStep2(
      step2Input({
        report: { laps: [40_000, 40_000, 40_000], totalMs: 130_000 },
        nowMs: 131_500,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESULT');
    expect(r.error.details).toMatchObject({ reason: 'LAP_SUM_MISMATCH' });
  });

  it('accepts a time_trial session with a single 60_000ms lap', () => {
    // time_trial on neon_blvd = 1 lap; class B min = 40_000. 60_000 above.
    const r = validateSubmissionStep2(
      step2Input({
        session: { mode: 'time_trial', startedAt: 1_000 },
        report: { totalMs: 60_000, laps: [60_000] },
        nowMs: 61_500,
      }),
    );
    expect(r.ok).toBe(true);
  });
});