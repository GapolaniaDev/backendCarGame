// Phase 7 Chunk 1 — recent_rivals subscriber unit tests.
// Pure-logic coverage: filterWindow / trimToCap / extractHumans /
// handleRaceCompletedForRecentRivals (with FakeNakama as the storage
// backing store).

import { describe, it, expect, beforeEach } from 'vitest';

import type { INakama, ILogger } from '../../modules/src/nkruntime';
import { EventBus } from '../../modules/src/core/event_bus';
import type { RaceCompletedEvent } from '../../modules/src/race/types';
import {
  handleRaceCompletedForRecentRivals,
  extractHumans,
  filterWindow,
  trimToCap,
} from '../../modules/src/social/recent_rivals';
import {
  readRecentRivals,
  writeRecentRivalsCreate,
} from '../../modules/src/social/friends_repo';
import {
  RECENT_RIVALS_CAP,
  RECENT_RIVALS_COLLECTION,
  RECENT_RIVALS_WINDOW_MS,
  type RecentRivalsRecord,
} from '../../modules/src/social/types';
import { FakeNakama, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';

const NOW = 1_700_000_000_000;
const USER_A = 'user-A';
const USER_B = 'user-B';
const USER_C = 'user-C';

function makeRaceEvent(overrides: Partial<RaceCompletedEvent> = {}): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sid-1',
    mode: 'quick',
    trackId: 'stadium_today',
    size: 4,
    results: [
      { rank: 1, userId: USER_A, isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: USER_B, isBot: false, totalMs: 61_000, abandoned: false },
    ],
    flags: { needsReview: false },
    closedAt: NOW,
    ...overrides,
  };
}

function makeBus(): EventBus {
  // Minimal stub logger for the EventBus constructor.
  const stubLogger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    withField: ((f: string, v: unknown): ILogger => stubLogger) as unknown as ILogger['withField'],
    withFields: ((fs: Record<string, unknown>): ILogger => stubLogger) as unknown as ILogger['withFields'],
    getFields: (): Record<string, unknown> => ({}),
  };
  return new (class extends EventBus {
    constructor() { super(stubLogger); }
  })();
}

function makeDeps(fake: FakeNakamaType) {
  return {
    nk: fake.nakama as INakama,
    logger: fake.logger as ILogger,
    bus: makeBus(),
  };
}

describe('recent_rivals (Phase 7 Chunk 1)', () => {
  describe('extractHumans', () => {
    it('filters out bot results', () => {
      const out = extractHumans([
        { rank: 1, userId: USER_A, isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: 'bot1', isBot: true, totalMs: 60_500, abandoned: false },
        { rank: 3, userId: USER_B, isBot: false, totalMs: 61_000, abandoned: false },
      ]);
      expect(out.length).toBe(2);
      expect(out.map((r) => r.userId)).toEqual([USER_A, USER_B]);
    });

    it('returns empty when all bots', () => {
      const out = extractHumans([
        { rank: 1, userId: 'bot1', isBot: true, totalMs: 60_000, abandoned: false },
      ]);
      expect(out.length).toBe(0);
    });
  });

  describe('filterWindow', () => {
    it('drops entries older than the window', () => {
      const now = NOW;
      const out = filterWindow([
        { userId: 'fresh', lastRaceAt: now - 1_000, raceCount: 1 },
        { userId: 'edge', lastRaceAt: now - RECENT_RIVALS_WINDOW_MS + 1, raceCount: 1 },
        { userId: 'old', lastRaceAt: now - RECENT_RIVALS_WINDOW_MS - 1, raceCount: 1 },
      ], now);
      expect(out.map((e) => e.userId).sort()).toEqual(['edge', 'fresh']);
    });

    it('keeps entries when the window is empty', () => {
      const out = filterWindow([], NOW);
      expect(out.length).toBe(0);
    });
  });

  describe('trimToCap', () => {
    it('drops entries beyond the cap', () => {
      const arr = Array.from({ length: 25 }, (_, i) => ({
        userId: `u${i}`,
        lastRaceAt: NOW - i * 1000,
        raceCount: 1,
      }));
      const out = trimToCap(arr, RECENT_RIVALS_CAP);
      expect(out.length).toBe(RECENT_RIVALS_CAP);
      expect(out[0]?.userId).toBe('u0'); // most recent first
    });

    it('returns a copy when under the cap', () => {
      const arr = [{ userId: 'u1', lastRaceAt: NOW, raceCount: 1 }];
      const out = trimToCap(arr, RECENT_RIVALS_CAP);
      expect(out).not.toBe(arr);
      expect(out.length).toBe(1);
    });
  });

  describe('handleRaceCompletedForRecentRivals', () => {
    let fake: FakeNakamaType;

    beforeEach(() => {
      fake = new FakeNakama();
    });

    it('returns reason=no_humans when all results are bots', () => {
      const event = makeRaceEvent({
        results: [
          { rank: 1, userId: 'bot1', isBot: true, totalMs: 60_000, abandoned: false },
          { rank: 2, userId: 'bot2', isBot: true, totalMs: 60_500, abandoned: false },
        ],
      });
      const deps = makeDeps(fake);
      const out = handleRaceCompletedForRecentRivals(deps, event);
      expect(out.processed).toBe(false);
      expect(out.reason).toBe('no_humans');
    });

    it('returns reason=event_missing when payload is missing required fields', () => {
      const deps = makeDeps(fake);
      // @ts-expect-error — testing the defensive path
      const out = handleRaceCompletedForRecentRivals(deps, {});
      expect(out.processed).toBe(false);
      expect(out.reason).toBe('event_missing');
    });

    it('creates a recent_rivals row on first race', () => {
      const event = makeRaceEvent();
      const deps = makeDeps(fake);
      const out = handleRaceCompletedForRecentRivals(deps, event);
      expect(out.processed).toBe(true);
      expect(out.humans.length).toBe(2);

      // USER_A's row should mention USER_B
      const aRow = readRecentRivals(fake.nakama, USER_A);
      expect(aRow).not.toBeNull();
      const aIds = aRow!.record.entries.map((e) => e.userId);
      expect(aIds).toContain(USER_B);
      // USER_B's row should mention USER_A
      const bRow = readRecentRivals(fake.nakama, USER_B);
      expect(bRow).not.toBeNull();
      const bIds = bRow!.record.entries.map((e) => e.userId);
      expect(bIds).toContain(USER_A);
    });

    it('increments raceCount on a re-race', () => {
      // Pre-seed USER_A's row with one entry for USER_B, raceCount=3.
      const seed: RecentRivalsRecord = {
        schemaVersion: 1,
        userId: USER_A,
        entries: [{ userId: USER_B, lastRaceAt: NOW - 5_000, raceCount: 3 }],
      };
      writeRecentRivalsCreate(fake.nakama, seed);

      const out = handleRaceCompletedForRecentRivals(makeDeps(fake), makeRaceEvent());
      expect(out.processed).toBe(true);

      const row = readRecentRivals(fake.nakama, USER_A);
      const entry = row!.record.entries.find((e) => e.userId === USER_B);
      expect(entry).toBeDefined();
      expect(entry!.raceCount).toBe(4);
      expect(entry!.lastRaceAt).toBe(NOW);
    });

    it('skips opponents that are outside the rolling window', () => {
      // Pre-seed USER_A with an entry that's 31 days old.
      const seed: RecentRivalsRecord = {
        schemaVersion: 1,
        userId: USER_A,
        entries: [{ userId: USER_B, lastRaceAt: NOW - 31 * 86_400_000, raceCount: 1 }],
      };
      writeRecentRivalsCreate(fake.nakama, seed);

      handleRaceCompletedForRecentRivals(makeDeps(fake), makeRaceEvent());

      const row = readRecentRivals(fake.nakama, USER_A);
      // The old entry is dropped on this update; the fresh race re-adds B.
      expect(row!.record.entries.find((e) => e.userId === USER_B)?.raceCount).toBe(1);
    });

    it('caps the entries array at RECENT_RIVALS_CAP', () => {
      // Pre-seed USER_A with 20 opponents including B.
      const seedEntries = Array.from({ length: RECENT_RIVALS_CAP }, (_, i) => ({
        userId: i === 5 ? USER_B : `u-${i}`,
        lastRaceAt: NOW - (RECENT_RIVALS_CAP - i + 1) * 1000, // all older than B's slot
        raceCount: 1,
      }));
      // Add USER_B with the highest lastRaceAt to land at the top of the LRU.
      seedEntries[0] = { userId: USER_B, lastRaceAt: NOW - 100, raceCount: 5 };
      const seed: RecentRivalsRecord = {
        schemaVersion: 1,
        userId: USER_A,
        entries: seedEntries,
      };
      writeRecentRivalsCreate(fake.nakama, seed);

      // New race with USER_C → A's row has B + 19 others; adding C bumps cap to 20.
      // USER_C was not in the seed; adding bumps us to 21 → trimmed.
      const event = makeRaceEvent({
        results: [
          { rank: 1, userId: USER_A, isBot: false, totalMs: 60_000, abandoned: false },
          { rank: 2, userId: USER_C, isBot: false, totalMs: 61_000, abandoned: false },
        ],
      });
      handleRaceCompletedForRecentRivals(makeDeps(fake), event);

      const row = readRecentRivals(fake.nakama, USER_A);
      expect(row!.record.entries.length).toBe(RECENT_RIVALS_CAP);
      // USER_C is now in the list (lastRaceAt=NOW, top of LRU)
      expect(row!.record.entries.find((e) => e.userId === USER_C)).toBeDefined();
      // USER_B is still in the list (lastRaceAt was bumped to NOW by CAS re-read)
      // Note: the CAS path re-reads after first conflict and may include B at a different count.
      expect(row!.record.entries.some((e) => e.userId === USER_B)).toBe(true);
    });

    it('persists the correct collection name', () => {
      handleRaceCompletedForRecentRivals(makeDeps(fake), makeRaceEvent());
      const keys = Array.from(fake.store.keys()).filter((k) =>
        k.startsWith(`${RECENT_RIVALS_COLLECTION}/`),
      );
      expect(keys.length).toBe(2);
    });
  });
});