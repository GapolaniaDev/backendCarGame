// Phase 8 Chunk 4 — Unit tests for the anti-cheat RaceCompleted subscriber.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  subscribeAntiCheat,
  handleRaceCompletedForAntiCheat,
  type AntiCheatSubscriberDeps,
} from '../../modules/src/anti_cheat/subscriber';
import {
  _resetMarksStateForTests,
  appendMark,
  readMarks,
  type AntiCheatMark,
} from '../../modules/src/anti_cheat/marks';
import { readDailyStats } from '../../modules/src/anti_cheat/stats';
import { _resetAntiCheatStateForTests } from '../../modules/src/anti_cheat/_reset_for_tests';
import { EventBus } from '../../modules/src/core/event_bus';
import {
  loadCatalogs,
  _resetCatalogsForTests,
  type TracksCatalog,
  type ModesCatalog,
} from '../../modules/src/core/catalog';
import { RACE_EVENT_RACE_COMPLETED } from '../../modules/src/race/constants';
import type { RaceCompletedEvent, RaceResult } from '../../modules/src/race/types';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import { FakeNakama } from '../e2e/_stubs';
import { appendAbruptHistory } from '../../modules/src/anti_cheat/abrupt_improvement';
import { appendQuorumMark } from '../../modules/src/anti_cheat/quorum_disagreement';
import { writeRacePartials } from '../../modules/src/anti_cheat/partials';

// ─── Test fixtures ─────────────────────────────────────────────────────────

// `serverNowMs()` reads the real wall clock, so anchor `NOW` to right
// now. Pre-seeded marks use `NOW - offset` so the rolling 7d window
// in `detectQuorumDisagreement` finds them.
const NOW = Date.now();

const TRACKS: TracksCatalog = {
  version: 1,
  tracks: [
    {
      id: 'track-A',
      displayName: 'Test Track',
      modes: { quick: 1, ranked: 1, private: 1, time_trial: 1 },
      checkpoints: 4,
      minTimeMsByClass: { D: 60000, C: 55000, B: 50000, A: 45000, S: 40000 },
      minSectionTimeMs: 2000,
    },
  ],
};

const MODES: ModesCatalog = {
  version: 1,
  modes: [
    {
      id: 'quick',
      displayName: 'Quick',
      allowedSizes: [2, 4, 6],
      scoreMultiplier: 1,
      usesRating: false,
    },
  ],
};

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as ILogger;

function mkDeps(fake: FakeNakama): AntiCheatSubscriberDeps {
  const bus = new EventBus(SILENT_LOGGER);
  return { logger: SILENT_LOGGER, nk: fake.nakama as INakama, bus };
}

function mkResult(overrides: Partial<RaceResult> & { userId: string }): RaceResult {
  return {
    rank: 1,
    isBot: false,
    totalMs: 60_000,
    abandoned: false,
    ...overrides,
  };
}

function mkRaceEvent(overrides: Partial<RaceCompletedEvent> = {}): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'race-1',
    mode: 'quick',
    trackId: 'track-A',
    size: 4,
    results: [],
    closedAt: NOW,
    flags: { needsReview: false },
    ...overrides,
  };
}

beforeEach(() => {
  _resetMarksStateForTests();
  _resetAntiCheatStateForTests();
  _resetCatalogsForTests();
  loadCatalogs(SILENT_LOGGER, { tracks: TRACKS, modes: MODES }, () => 'h');
});

describe('anti_cheat subscriber (Phase 8 Chunk 4)', () => {
  it('returns processed=false + reason=no_humans when only bots are present', () => {
    const fake = new FakeNakama();
    const deps = mkDeps(fake);
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      results: [
        mkResult({ userId: 'bot-1', isBot: true, rank: 1 }),
        mkResult({ userId: 'bot-2', isBot: true, rank: 2 }),
      ],
    }));
    expect(out.processed).toBe(false);
    expect(out.reason).toBe('no_humans');
  });

  it('skips hidden users (shouldExcludeFromLeaderboards)', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Manually seed a high mark for u1 → marks them as hidden.
    const m: AntiCheatMark = {
      id: 'pre-existing-high',
      userId: 'u1',
      raceId: 'old-race',
      kind: 'abrupt_improvement',
      severity: 'high',
      detectedAt: NOW - 1000,
      confirmed: false,
      dismissed: false,
    };
    readMarks(nk, 'u1'); // warm
    appendMark(nk, 'u1', m);

    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-2',
      results: [
        mkResult({ userId: 'u1', rank: 1, totalMs: 50_000 }),
      ],
    }));
    expect(out.processed).toBe(true);
    expect(out.humans).toHaveLength(1);
    expect(out.humans[0]).toEqual({
      userId: 'u1', excluded: true, partialMark: false, abruptMark: false, quorumMark: false,
    });
    // No new marks were appended for u1.
    const after = readMarks(nk, 'u1');
    expect(after).toHaveLength(1);
  });

  it('appends partial_impossible when validatePartials flags a violation', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Pre-seed partials: a sector of 800ms vs 2000ms floor.
    writeRacePartials(nk, 'race-3', [
      { index: 0, timeMs: 0 },
      { index: 1, timeMs: 800 }, // sector 0→1 = 800ms, below 2000 floor.
      { index: 2, timeMs: 4000 },
      { index: 3, timeMs: 8000 },
    ]);
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-3',
      results: [mkResult({ userId: 'u-partial', rank: 1, totalMs: 8000 })],
    }));
    expect(out.humans[0]?.partialMark).toBe(true);
    const marks = readMarks(nk, 'u-partial');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.kind).toBe('partial_impossible');
  });

  it('appends abrupt_improvement when the new time beats the median by >30%', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Pre-seed 5 entries of 30s each (median = 30000ms).
    const ts = NOW - 60_000;
    for (let i = 0; i < 5; i += 1) {
      appendAbruptHistory(nk, 'u-abrupt', {
        raceId: `r-${i}`,
        bestTimeMs: 30_000,
        ts: ts - i * 1_000,
      });
    }
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-abrupt',
      results: [mkResult({ userId: 'u-abrupt', rank: 1, totalMs: 15_000 })], // 50% faster
    }));
    expect(out.humans[0]?.abruptMark).toBe(true);
    const marks = readMarks(nk, 'u-abrupt');
    expect(marks.find((m) => m.kind === 'abrupt_improvement')).toBeDefined();
  });

  it('skips partial validation when race_partials row is absent', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // No partials row → should skip partials check entirely.
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-no-partials',
      results: [mkResult({ userId: 'u-x', rank: 1, totalMs: 50_000 })],
    }));
    expect(out.humans[0]?.partialMark).toBe(false);
    expect(readMarks(nk, 'u-x')).toHaveLength(0);
  });

  it('appends quorum_disagreement when confidence is client AND position gap is large', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Pre-seed 4 rolling-window marks so the next one trips the 5/7d gate.
    for (let i = 0; i < 4; i += 1) {
      appendQuorumMark(nk, 'u-q', { ts: NOW - (i + 1) * 60_000, kind: 'quorum_disagreement' });
    }
    // Race was low-confidence (needsReview=true); this user is rank 1,
    // the next nearest human is rank 5 → position gap = 4 ≥ 3.
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-q',
      flags: { needsReview: true, reviewReason: 'low-conf' },
      results: [
        mkResult({ userId: 'u-q', rank: 1, totalMs: 30_000 }),
        mkResult({ userId: 'u-other', rank: 5, totalMs: 90_000 }),
      ],
    }));
    expect(out.humans[0]?.quorumMark).toBe(true);
    const marks = readMarks(nk, 'u-q');
    expect(marks.find((m) => m.kind === 'quorum_disagreement')).toBeDefined();
  });

  it('does NOT append quorum_disagreement when race is high-confidence', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Pre-seed 4 rolling-window marks; if the detector fired again it
    // would trip — but high-confidence races skip the path entirely.
    for (let i = 0; i < 4; i += 1) {
      appendQuorumMark(nk, 'u-q2', { ts: NOW - (i + 1) * 60_000, kind: 'quorum_disagreement' });
    }
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-q2',
      flags: { needsReview: false },
      results: [
        mkResult({ userId: 'u-q2', rank: 1, totalMs: 30_000 }),
        mkResult({ userId: 'u-other', rank: 5, totalMs: 90_000 }),
      ],
    }));
    expect(out.humans[0]?.quorumMark).toBe(false);
    expect(readMarks(nk, 'u-q2')).toHaveLength(0);
  });

  it('does NOT append quorum_disagreement when position gap is small', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // u-q3 is rank 1; u-other is rank 2 → gap = 1, below the 3+ threshold.
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-q3',
      flags: { needsReview: true, reviewReason: 'low-conf' },
      results: [
        mkResult({ userId: 'u-q3', rank: 1, totalMs: 30_000 }),
        mkResult({ userId: 'u-other', rank: 2, totalMs: 32_000 }),
      ],
    }));
    expect(out.humans[0]?.quorumMark).toBe(false);
  });

  it('increments anti_cheat_stats/{today} per detected mark', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Trigger a partial_impossible mark.
    writeRacePartials(nk, 'race-stats', [
      { index: 0, timeMs: 0 },
      { index: 1, timeMs: 100 }, // below 2000ms floor
      { index: 2, timeMs: 4000 },
    ]);
    handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-stats',
      results: [mkResult({ userId: 'u-stats', rank: 1, totalMs: 4000 })],
    }));
    const stats = readDailyStats(nk, new Date(NOW).toISOString().slice(0, 10)); // utcDate(NOW)
    expect(stats.marksTotal).toBeGreaterThanOrEqual(1);
    expect(stats.marksByKind.partial_impossible).toBeGreaterThanOrEqual(1);
  });

  it('handles bots AND humans together — only humans get checked', () => {
    const fake = new FakeNakama();
    const nk = fake.nakama as INakama;
    const deps = mkDeps(fake);
    // Set up a partials violation.
    writeRacePartials(nk, 'race-mix', [
      { index: 0, timeMs: 0 },
      { index: 1, timeMs: 100 },
      { index: 2, timeMs: 4000 },
    ]);
    const out = handleRaceCompletedForAntiCheat(deps, mkRaceEvent({
      sessionId: 'race-mix',
      results: [
        mkResult({ userId: 'bot-1', isBot: true, rank: 1, totalMs: 4000 }),
        mkResult({ userId: 'u-human', rank: 2, totalMs: 8000 }),
      ],
    }));
    expect(out.humans).toHaveLength(1);
    expect(out.humans[0]?.userId).toBe('u-human');
    expect(out.humans[0]?.partialMark).toBe(true);
    // Bot has no marks.
    expect(readMarks(nk, 'bot-1')).toHaveLength(0);
  });

  it('subscribeAntiCheat wraps the handler in try/catch — never throws', async () => {
    const fake = new FakeNakama();
    const deps = mkDeps(fake);
    // Pre-poison storage: wrap nk.storageRead so it explodes.
    const orig = (fake.nakama as INakama).storageRead;
    let calls = 0;
    (fake.nakama as INakama).storageRead = (keys) => {
      calls += 1;
      if (calls > 2) throw new Error('boom');
      return orig.call(fake.nakama, keys);
    };
    deps.bus.subscribe(RACE_EVENT_RACE_COMPLETED, () => {
      // A throwing subscriber would normally break the publish loop,
      // but the anti-cheat subscriber has its own try/catch.
      throw new Error('unrelated subscriber boom');
    });
    subscribeAntiCheat(deps);

    // Publish must not throw even though one subscriber throws.
    await expect(
      deps.bus.publish(RACE_EVENT_RACE_COMPLETED, mkRaceEvent({
        results: [mkResult({ userId: 'u-throw', rank: 1, totalMs: 50_000 })],
      })),
    ).resolves.toBeUndefined();
    // And the anti-cheat subscriber swallowed its own internal boom
    // (storageRead fails after 2 calls).
    expect(calls).toBeGreaterThan(2);
  });
});