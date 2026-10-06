// Phase 6 Chunk 4 — first_win_of_day stamping tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeNakama, FakeLogger } from '../e2e/_stubs';
import type {
  RaceCompletedEvent,
  RaceCompletedResult,
} from '../../modules/src/missions/event';
import {
  FIRST_WIN_TODAY_COLLECTION,
  stampFirstWinOfDay,
  stampFirstWinOfDayForAll,
} from '../../modules/src/missions/event_bridge_extensions';

function makeEvent(
  results: RaceCompletedResult[],
  timestampMs = 1_700_000_000_000,
): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sid-1',
    raceId: 'sid-1',
    mode: 'quick',
    trackId: 'stadium_today',
    size: 4,
    finisherCount: results.filter((r) => r.finishedRace).length,
    abandonedCount: results.filter((r) => !r.finishedRace && r.isHuman).length,
    durationMs: 60_000,
    confidence: 'high',
    results,
    timestampMs,
  };
}

function makeResult(
  userId: string,
  position: number | null,
  isHuman = true,
  finishedRace = position !== null,
): RaceCompletedResult {
  return {
    userId,
    carId: `body-${userId}`,
    classId: 'C',
    position,
    isHuman,
    finishedRace,
  };
}

describe('first_win_of_day (Phase 6 Chunk 4)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
  });

  describe('stampFirstWinOfDay', () => {
    it('first call of day → true + writes row', () => {
      const event = makeEvent([makeResult('u1', 1)]);
      const r = stampFirstWinOfDay(fake.nakama, logger, event, 'u1', '2026-10-07');
      expect(r).toBe(true);
      const stored = fake.store.get(
        `${FIRST_WIN_TODAY_COLLECTION}/u1/2026-10-07/u1`,
      );
      expect(stored).toBeDefined();
      expect((stored!.value as { firstWinAt: number }).firstWinAt).toBe(1_700_000_000_000);
    });

    it('second call same day → false (already stamped)', () => {
      const event = makeEvent([makeResult('u1', 1)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event, 'u1', '2026-10-07')).toBe(true);
      // Fresh event, same day, same user
      const event2 = makeEvent([makeResult('u1', 1)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event2, 'u1', '2026-10-07')).toBe(false);
    });

    it('different dateUtc → true (new day)', () => {
      const event = makeEvent([makeResult('u1', 1)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event, 'u1', '2026-10-07')).toBe(true);
      const event2 = makeEvent([makeResult('u1', 1)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event2, 'u1', '2026-10-08')).toBe(true);
    });

    it('non-winner (position > 1) → false, no write', () => {
      const event = makeEvent([makeResult('u1', 2)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event, 'u1', '2026-10-07')).toBe(false);
      const stored = fake.store.get(
        `${FIRST_WIN_TODAY_COLLECTION}/u1/2026-10-07/u1`,
      );
      expect(stored).toBeUndefined();
    });

    it('abandoned user → false (finishedRace=false)', () => {
      const event = makeEvent([makeResult('u1', null)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event, 'u1', '2026-10-07')).toBe(false);
    });

    it('bot win (isHuman=false, position=1) → false', () => {
      const event = makeEvent([makeResult('bot-1', 1, false, true)]);
      expect(stampFirstWinOfDay(fake.nakama, logger, event, 'bot-1', '2026-10-07')).toBe(false);
    });
  });

  describe('stampFirstWinOfDayForAll', () => {
    it('returns Map<userId, true> only for fresh first-win stamps', () => {
      const event = makeEvent([
        makeResult('u1', 1),
        makeResult('u2', 2),
        makeResult('u3', 1),
      ]);
      const map = stampFirstWinOfDayForAll(fake.nakama, logger, event);
      expect(map).toEqual({ u1: true, u3: true });

      // Second pass → already stamped → empty
      const map2 = stampFirstWinOfDayForAll(fake.nakama, logger, event);
      expect(map2).toEqual({});
    });

    it('bots excluded', () => {
      const event = makeEvent([
        makeResult('u1', 1),
        makeResult('bot-A', 1, false, true),
        makeResult('bot-B', 2, false, true),
      ]);
      const map = stampFirstWinOfDayForAll(fake.nakama, logger, event);
      expect(map).toEqual({ u1: true });
      // bot rows never written
      const botA = fake.store.get(`${FIRST_WIN_TODAY_COLLECTION}/bot-A/2026-10-07/bot-A`);
      expect(botA).toBeUndefined();
    });

    it('multi-human race stamps each independently', () => {
      const event = makeEvent([
        makeResult('u1', 1),
        makeResult('u2', 1), // tie at rank 1
        makeResult('u3', 3),
      ]);
      const map = stampFirstWinOfDayForAll(fake.nakama, logger, event);
      expect(map).toEqual({ u1: true, u2: true });
    });

    it('lazy creation: storage row created on first stamp', () => {
      const ts = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC
      const dateUtc = '2023-11-14';
      const before = fake.store.get(
        `${FIRST_WIN_TODAY_COLLECTION}/u1/${dateUtc}/u1`,
      );
      expect(before).toBeUndefined();
      const event = makeEvent([makeResult('u1', 1)], ts);
      stampFirstWinOfDayForAll(fake.nakama, logger, event);
      const after = fake.store.get(
        `${FIRST_WIN_TODAY_COLLECTION}/u1/${dateUtc}/u1`,
      );
      expect(after).toBeDefined();
    });
  });
});