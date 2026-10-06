// Phase 6 Chunk 2 — pure counter engine tests.

import { describe, it, expect } from 'vitest';
import {
  evaluateIncrement,
  matchesEvent,
  filterMatchesMode,
  filterMatchesSize,
  filterMatchesClass,
  filterMatchesTrack,
} from '../../modules/src/missions/counter';
import {
  extractHumanResults,
  findHumanResult,
  type RaceCompletedEvent,
} from '../../modules/src/missions/event';
import type { MissionKind, MissionFilter } from '../../modules/src/missions/types';

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeResult(opts: {
  userId?: string;
  carId?: string;
  classId?: 'D' | 'C' | 'B' | 'A' | 'S';
  position?: number | null;
  isHuman?: boolean;
  finishedRace?: boolean;
}): import('../../modules/src/missions/event').RaceCompletedResult {
  return {
    userId: opts.userId ?? 'u1',
    carId: opts.carId ?? 'c1',
    classId: opts.classId ?? 'C',
    position: opts.position === undefined ? 1 : opts.position,
    isHuman: opts.isHuman ?? true,
    finishedRace: opts.finishedRace ?? true,
  };
}

function makeEvent(opts: Partial<RaceCompletedEvent> = {}): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sess1',
    raceId: 'race1',
    mode: 'quick',
    trackId: 'track_A',
    size: 4,
    finisherCount: 4,
    abandonedCount: 0,
    durationMs: 60_000,
    confidence: 'high',
    results: [
      makeResult({ userId: 'u1', position: 1, isHuman: true, finishedRace: true }),
      makeResult({ userId: 'u2', position: 2, isHuman: true, finishedRace: true }),
      makeResult({ userId: 'u3', position: 3, isHuman: true, finishedRace: true }),
      makeResult({ userId: 'u4', position: 4, isHuman: true, finishedRace: true }),
    ],
    timestampMs: Date.UTC(2026, 0, 15, 12, 0, 0),
    ...opts,
  };
}

function def(kind: MissionKind, filters: MissionFilter = {}) {
  return { kind, filters: Object.freeze({ ...filters }) as MissionFilter };
}

// ─── race_count ──────────────────────────────────────────────────────────────

describe('counter: race_count', () => {
  it('increments by 1 when user finished', () => {
    const event = makeEvent();
    const d = def('race_count');
    expect(evaluateIncrement(event, d, 'u1')).toBe(1);
  });

  it('does not increment when user abandoned', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'u1', position: null, finishedRace: false }),
        makeResult({ userId: 'u2', position: 1, finishedRace: true }),
        makeResult({ userId: 'u3', position: 2, finishedRace: true }),
        makeResult({ userId: 'u4', position: 3, finishedRace: true }),
      ],
      finisherCount: 3,
      abandonedCount: 1,
    });
    expect(evaluateIncrement(event, def('race_count'), 'u1')).toBe(0);
    expect(evaluateIncrement(event, def('race_count'), 'u2')).toBe(1);
  });

  it('does not increment when user is bot', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'b1', position: 1, isHuman: false, finishedRace: true }),
        makeResult({ userId: 'u1', position: 2, finishedRace: true }),
      ],
      size: 2,
      finisherCount: 2,
    });
    expect(evaluateIncrement(event, def('race_count'), 'b1')).toBe(0);
  });

  it('empty event returns 0', () => {
    const event = makeEvent({ results: [] });
    expect(evaluateIncrement(event, def('race_count'), 'u1')).toBe(0);
  });
});

// ─── race_position ───────────────────────────────────────────────────────────

describe('counter: race_position', () => {
  it('increments when position <= maxPosition', () => {
    const event = makeEvent();
    const d = def('race_position', { maxPosition: 3 });
    expect(evaluateIncrement(event, d, 'u1')).toBe(1); // pos 1
    expect(evaluateIncrement(event, d, 'u2')).toBe(1); // pos 2
    expect(evaluateIncrement(event, d, 'u3')).toBe(1); // pos 3
  });

  it('does not increment when position > maxPosition', () => {
    const event = makeEvent();
    const d = def('race_position', { maxPosition: 3 });
    expect(evaluateIncrement(event, d, 'u4')).toBe(0); // pos 4
  });

  it('does not increment when user abandoned', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'u1', position: null, finishedRace: false }),
        makeResult({ userId: 'u2', position: 1, finishedRace: true }),
        makeResult({ userId: 'u3', position: 2, finishedRace: true }),
        makeResult({ userId: 'u4', position: 3, finishedRace: true }),
      ],
    });
    const d = def('race_position', { maxPosition: 5 });
    expect(evaluateIncrement(event, d, 'u1')).toBe(0);
  });

  it('without maxPosition: position filter must be set; returns 0', () => {
    const event = makeEvent();
    const d = def('race_position', {}); // no maxPosition
    expect(evaluateIncrement(event, d, 'u1')).toBe(0);
  });
});

// ─── race_track ──────────────────────────────────────────────────────────────

describe('counter: race_track', () => {
  it('matches when trackId equals filter trackId', () => {
    const event = makeEvent({ trackId: 'track_A' });
    const d = def('race_track', { trackId: 'track_A' });
    expect(evaluateIncrement(event, d, 'u1')).toBe(1);
  });

  it('does not match when trackId differs', () => {
    const event = makeEvent({ trackId: 'track_A' });
    const d = def('race_track', { trackId: 'track_B' });
    expect(evaluateIncrement(event, d, 'u1')).toBe(0);
  });

  it('with maxPosition=1 increments only for winner', () => {
    const event = makeEvent();
    const d = def('race_track', { trackId: 'track_A', maxPosition: 1 });
    expect(evaluateIncrement(event, d, 'u1')).toBe(1); // winner
    expect(evaluateIncrement(event, d, 'u2')).toBe(0); // pos 2
  });

  it('without maxPosition: anyone who finished on the right track increments', () => {
    const event = makeEvent();
    const d = def('race_track', { trackId: 'track_A' });
    expect(evaluateIncrement(event, d, 'u4')).toBe(1);
  });
});

// ─── race_class ──────────────────────────────────────────────────────────────

describe('counter: race_class', () => {
  it('matches when classId equals filter classId', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'u1', classId: 'A', position: 1, finishedRace: true }),
        makeResult({ userId: 'u2', classId: 'B', position: 2, finishedRace: true }),
      ],
    });
    expect(evaluateIncrement(event, def('race_class', { classId: 'A' }), 'u1')).toBe(1);
    expect(evaluateIncrement(event, def('race_class', { classId: 'A' }), 'u2')).toBe(0);
  });

  it('does not increment when player abandoned', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'u1', classId: 'A', position: null, finishedRace: false }),
      ],
    });
    expect(evaluateIncrement(event, def('race_class', { classId: 'A' }), 'u1')).toBe(0);
  });

  it('handles each car class classId', () => {
    for (const cls of ['D', 'C', 'B', 'A', 'S'] as const) {
      const event = makeEvent({
        results: [
          makeResult({ userId: 'u1', classId: cls, position: 1, finishedRace: true }),
        ],
      });
      expect(evaluateIncrement(event, def('race_class', { classId: cls }), 'u1')).toBe(1);
    }
  });
});

// ─── wins_quick ──────────────────────────────────────────────────────────────

describe('counter: wins_quick', () => {
  it('increments for winner in quick mode', () => {
    const event = makeEvent({ mode: 'quick' });
    expect(evaluateIncrement(event, def('wins_quick'), 'u1')).toBe(1);
  });

  it('does NOT increment in ranked mode', () => {
    const event = makeEvent({ mode: 'ranked' });
    expect(evaluateIncrement(event, def('wins_quick'), 'u1')).toBe(0);
  });

  it('does NOT increment for non-winners', () => {
    const event = makeEvent({ mode: 'quick' });
    expect(evaluateIncrement(event, def('wins_quick'), 'u2')).toBe(0);
  });

  it('does NOT increment when winner abandoned', () => {
    const event = makeEvent({
      mode: 'quick',
      results: [
        makeResult({ userId: 'u1', position: null, finishedRace: false }),
        makeResult({ userId: 'u2', position: 1, finishedRace: true }),
      ],
      size: 2,
    });
    expect(evaluateIncrement(event, def('wins_quick'), 'u1')).toBe(0);
  });
});

// ─── wins_ranked ─────────────────────────────────────────────────────────────

describe('counter: wins_ranked', () => {
  it('increments for winner in ranked mode', () => {
    const event = makeEvent({ mode: 'ranked' });
    expect(evaluateIncrement(event, def('wins_ranked'), 'u1')).toBe(1);
  });

  it('does NOT increment in quick mode', () => {
    const event = makeEvent({ mode: 'quick' });
    expect(evaluateIncrement(event, def('wins_ranked'), 'u1')).toBe(0);
  });
});

// ─── race_no_abandon ─────────────────────────────────────────────────────────

describe('counter: race_no_abandon', () => {
  it('increments when abandonedCount = 0', () => {
    const event = makeEvent({ abandonedCount: 0 });
    expect(evaluateIncrement(event, def('race_no_abandon'), 'u1')).toBe(1);
  });

  it('does NOT increment when abandonedCount >= 1', () => {
    const event = makeEvent({ abandonedCount: 1 });
    expect(evaluateIncrement(event, def('race_no_abandon'), 'u1')).toBe(0);
  });

  it('does NOT increment when player themselves abandoned', () => {
    const event = makeEvent({
      abandonedCount: 0,
      results: [
        makeResult({ userId: 'u1', position: null, finishedRace: false }),
        makeResult({ userId: 'u2', position: 1, finishedRace: true }),
      ],
      size: 2,
    });
    expect(evaluateIncrement(event, def('race_no_abandon'), 'u1')).toBe(0);
  });
});

// ─── Filter helpers ──────────────────────────────────────────────────────────

describe('filterMatchesMode', () => {
  it('returns false when filter mode does not match', () => {
    expect(filterMatchesMode({ mode: 'ranked' }, 'quick')).toBe(false);
  });
  it('returns true when filter mode is undefined (no filter applied)', () => {
    expect(filterMatchesMode({}, 'quick')).toBe(true);
  });
  it('returns true when filter mode equals event mode', () => {
    expect(filterMatchesMode({ mode: 'quick' }, 'quick')).toBe(true);
  });
});

describe('filterMatchesSize', () => {
  it('returns false when filter size differs', () => {
    expect(filterMatchesSize({ size: 2 }, 6)).toBe(false);
  });
  it('returns true when filter size is undefined', () => {
    expect(filterMatchesSize({}, 6)).toBe(true);
  });
});

describe('filterMatchesClass', () => {
  it('returns false when filter classId differs', () => {
    expect(filterMatchesClass({ classId: 'A' }, 'B')).toBe(false);
  });
  it('returns true when filter classId is undefined', () => {
    expect(filterMatchesClass({}, 'A')).toBe(true);
  });
});

describe('filterMatchesTrack', () => {
  it('returns false when filter trackId differs', () => {
    expect(filterMatchesTrack({ trackId: 't1' }, 't2')).toBe(false);
  });
  it('returns true when filter trackId is undefined', () => {
    expect(filterMatchesTrack({}, 't1')).toBe(true);
  });
});

// ─── Bots filtering ──────────────────────────────────────────────────────────

describe('bots excluded', () => {
  it('extractHumanResults skips bots', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'b1', isHuman: false, position: 1 }),
        makeResult({ userId: 'u1', position: 2 }),
        makeResult({ userId: 'b2', isHuman: false, position: 3 }),
        makeResult({ userId: 'u2', position: 4 }),
      ],
    });
    const humans = extractHumanResults(event);
    expect(humans.map((h) => h.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('multiple humans each get independent increment', () => {
    const event = makeEvent({
      mode: 'quick',
      size: 6,
      results: [
        makeResult({ userId: 'u1', position: 1, finishedRace: true }),
        makeResult({ userId: 'u2', position: 2, finishedRace: true }),
        makeResult({ userId: 'u3', position: 3, finishedRace: true }),
        makeResult({ userId: 'b1', position: 4, isHuman: false, finishedRace: true }),
      ],
      finisherCount: 4,
    });
    expect(evaluateIncrement(event, def('race_count'), 'u1')).toBe(1);
    expect(evaluateIncrement(event, def('race_count'), 'u2')).toBe(1);
    expect(evaluateIncrement(event, def('race_count'), 'u3')).toBe(1);
    expect(evaluateIncrement(event, def('race_count'), 'b1')).toBe(0);
  });

  it('findHumanResult returns null for bot or absent user', () => {
    const event = makeEvent({
      results: [
        makeResult({ userId: 'b1', isHuman: false, position: 1 }),
        makeResult({ userId: 'u1', position: 2 }),
      ],
    });
    expect(findHumanResult(event, 'b1')).toBeNull();
    expect(findHumanResult(event, 'unknown')).toBeNull();
    expect(findHumanResult(event, 'u1')?.position).toBe(2);
  });
});

// ─── matchesEvent ────────────────────────────────────────────────────────────

describe('matchesEvent', () => {
  it('true when conditions met', () => {
    const event = makeEvent({ mode: 'quick' });
    expect(matchesEvent(event, def('wins_quick'), 'u1')).toBe(true);
  });
  it('false when conditions fail', () => {
    const event = makeEvent({ mode: 'ranked' });
    expect(matchesEvent(event, def('wins_quick'), 'u1')).toBe(false);
  });
});

// ─── Defensive / immutability ────────────────────────────────────────────────

describe('defensive behaviour', () => {
  it('returns 0 (no throw) for an unknown kind', () => {
    const event = makeEvent();
    const d = { kind: 'MADE_UP' as unknown as MissionKind, filters: {} };
    expect(evaluateIncrement(event, d, 'u1')).toBe(0);
  });

  it('does NOT mutate the def', () => {
    const event = makeEvent();
    const filters: MissionFilter = { mode: 'quick', trackId: 'track_A' };
    const d = { kind: 'race_count' as MissionKind, filters };
    const before = JSON.stringify(d);
    evaluateIncrement(event, d, 'u1');
    expect(JSON.stringify(d)).toBe(before);
  });

  it('does NOT mutate frozen filters', () => {
    const event = makeEvent();
    const frozen = Object.freeze({ mode: 'quick' as const });
    const d = { kind: 'race_count' as MissionKind, filters: frozen as MissionFilter };
    expect(() => evaluateIncrement(event, d, 'u1')).not.toThrow();
    expect(frozen.mode).toBe('quick');
  });
});