// Phase 6 Chunk 4 — pure event bridge tests.

import { describe, it, expect } from 'vitest';
import type {
  RaceCompletedEvent,
  RaceResult,
} from '../../modules/src/race/types';
import type {
  RaceCompletedEvent as MissionEvent,
  MissionCarClass,
} from '../../modules/src/missions/event';
import { bridgeToMissionEvent } from '../../modules/src/missions/event_bridge';

function makeRaceEvent(overrides: Partial<RaceCompletedEvent> = {}): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sid-1',
    mode: 'quick',
    trackId: 'stadium_today',
    size: 4,
    results: [],
    flags: { needsReview: false },
    closedAt: 1_000_000,
    ...overrides,
  };
}

function makeCtx(userIds: string[], classId: MissionCarClass = 'C'): {
  classes: Map<string, MissionCarClass>;
  cars: Map<string, string>;
  startedAt: number;
} {
  const classes = new Map<string, MissionCarClass>();
  const cars = new Map<string, string>();
  for (const u of userIds) {
    classes.set(u, classId);
    cars.set(u, `body-${u}`);
  }
  return { classes, cars, startedAt: 999_000 };
}

describe('event_bridge (Phase 6 Chunk 4)', () => {
  it('converts all fields (sessionId, raceId, mode, trackId, size)', () => {
    const race = makeRaceEvent({ sessionId: 'sid-X' });
    const out = bridgeToMissionEvent(race, makeCtx(['u1']));
    expect(out.sessionId).toBe('sid-X');
    expect(out.raceId).toBe('sid-X');
    expect(out.mode).toBe('quick');
    expect(out.trackId).toBe('stadium_today');
    expect(out.size).toBe(4);
  });

  it('sanitizes size=1 to size=2 (defensive for test fixtures)', () => {
    const race = makeRaceEvent({ size: 1 });
    const out = bridgeToMissionEvent(race, makeCtx(['u1']));
    expect(out.size).toBe(2);
  });

  it('maps each RaceResult to a RaceCompletedResult with correct shape', () => {
    const race = makeRaceEvent({
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: 'u2', isBot: false, totalMs: 61_000, abandoned: false },
        { rank: 3, userId: 'u3', isBot: false, totalMs: 62_000, abandoned: false },
      ],
    });
    const out = bridgeToMissionEvent(race, makeCtx(['u1', 'u2', 'u3']));
    expect(out.results.length).toBe(3);
    expect(out.results[0]).toMatchObject({
      userId: 'u1', isHuman: true, finishedRace: true,
      position: 1, classId: 'C', carId: 'body-u1',
    });
  });

  it('bot results kept in results array (filtering happens downstream)', () => {
    const race = makeRaceEvent({
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: 'bot-1', isBot: true, totalMs: 61_000, abandoned: false },
      ],
    });
    const out = bridgeToMissionEvent(race, makeCtx(['u1']));
    const bot = out.results.find((r) => r.userId === 'bot-1');
    expect(bot?.isHuman).toBe(false);
    expect(bot?.finishedRace).toBe(false);
  });

  it('abandoned race → position=null + finishedRace=false (humans only)', () => {
    const race = makeRaceEvent({
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 4, userId: 'u2', isBot: false, totalMs: 0, abandoned: true },
      ],
    });
    const out = bridgeToMissionEvent(race, makeCtx(['u1', 'u2']));
    const u2 = out.results.find((r) => r.userId === 'u2')!;
    expect(u2.position).toBeNull();
    expect(u2.finishedRace).toBe(false);
  });

  it('finisherCount counts only non-abandoned humans; abandonedCount counts abandons', () => {
    const race = makeRaceEvent({
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 4, userId: 'u2', isBot: false, totalMs: 0, abandoned: true },
        { rank: 5, userId: 'bot-1', isBot: true, totalMs: 0, abandoned: true },
      ],
    });
    const out = bridgeToMissionEvent(race, makeCtx(['u1', 'u2']));
    expect(out.finisherCount).toBe(1);
    expect(out.abandonedCount).toBe(1);
  });

  it('confidence: needsReview=true → low, otherwise high', () => {
    const raceClean = makeRaceEvent({ flags: { needsReview: false } });
    const raceDirty = makeRaceEvent({ flags: { needsReview: true, reviewReason: 'conflict' } });
    expect(bridgeToMissionEvent(raceClean, makeCtx([])).confidence).toBe('high');
    expect(bridgeToMissionEvent(raceDirty, makeCtx([])).confidence).toBe('low');
  });

  it('timestampMs is passed through unchanged (= race.closedAt)', () => {
    const race = makeRaceEvent({ closedAt: 9_999_999 });
    const out = bridgeToMissionEvent(race, makeCtx([]));
    expect(out.timestampMs).toBe(9_999_999);
  });

  it('durationMs = closedAt - startedAt (clamped to 0)', () => {
    const race = makeRaceEvent({ closedAt: 1_500 });
    const out = bridgeToMissionEvent(race, { ...makeCtx([]), startedAt: 1_000 });
    expect(out.durationMs).toBe(500);
    // Negative guard (defensive — closedAt before startedAt)
    const out2 = bridgeToMissionEvent(
      { ...race, closedAt: 500 },
      { ...makeCtx([]), startedAt: 1_000 },
    );
    expect(out2.durationMs).toBe(0);
  });

  it('human with no loadout entry defaults to classId=D', () => {
    const race = makeRaceEvent({
      results: [
        { rank: 1, userId: 'ghost', isBot: false, totalMs: 60_000, abandoned: false },
      ],
    });
    const ctx: ReturnType<typeof makeCtx> = {
      classes: new Map(), cars: new Map(), startedAt: 0,
    };
    const out = bridgeToMissionEvent(race, ctx);
    expect(out.results[0]!.classId).toBe('D');
    expect(out.results[0]!.carId).toBe('');
  });

  it('returns MissionEvent with schemaVersion=1', () => {
    const out = bridgeToMissionEvent(makeRaceEvent(), makeCtx([]));
    expect(out.schemaVersion).toBe(1);
  });
});