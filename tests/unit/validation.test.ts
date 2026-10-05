// Unit tests for `race/validation.ts` — pure, no Nakama I/O.

import { describe, it, expect } from 'vitest';
import { validateSubmissionStep1 } from '../../modules/src/race/validation';
import type { RaceSession } from '../../modules/src/race/types';

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