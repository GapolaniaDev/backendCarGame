// Phase 8 Chunk 8 — Unit tests for the events RaceCompleted subscriber.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  subscribeEvents,
  handleRaceCompletedForEvents,
  type EventsSubscriberDeps,
} from '../../modules/src/events/subscriber';
import { resolveXpMultiplier } from '../../modules/src/events/multiplier';
import { EventBus } from '../../modules/src/core/event_bus';
import {
  loadEventsCatalog,
  _resetActiveEventsCatalogForTests,
} from '../../modules/src/core/active_events';
import {
  loadRewardsCatalog,
  _resetRewardsForTests,
} from '../../modules/src/economy/catalog';
import {
  loadLevelsCatalog,
  _resetLevelsForTests,
} from '../../modules/src/progression/catalog';
import {
  _resetStoreForTests,
  loadStoreCatalog,
} from '../../modules/src/store/catalog';
import { RACE_EVENT_RACE_COMPLETED } from '../../modules/src/race/constants';
import type { RaceCompletedEvent } from '../../modules/src/race/types';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import { FakeNakama } from '../e2e/_stubs';
import type { RawEventsFile } from '../../modules/src/events/types';
import type { RawRewardsFile } from '../../modules/src/economy/catalog';
import type { RawLevelsFile } from '../../modules/src/progression/catalog';
import type { RawStoreFile } from '../../modules/src/store/catalog';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
  getFields: () => ({}),
} as unknown as ILogger;

const EVENTS_NO_DOUBLE: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_featured',
      kind: 'featured_track',
      startsAtUtc: '2026-10-05T00:00:00Z',
      endsAtUtc: '2026-11-02T00:00:00Z',
      payload: { trackId: 'stadium_today' },
    },
  ],
};

const EVENTS_XP_DOUBLE: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_xp2',
      kind: 'xp_double',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { multiplier: 2 },
    },
  ],
};

const EVENTS_XP_TRIPLE: RawEventsFile = {
  version: 1,
  events: [
    {
      id: 'evt_xp2',
      kind: 'xp_double',
      startsAtUtc: '2026-10-08T00:00:00Z',
      endsAtUtc: '2026-10-15T00:00:00Z',
      payload: { multiplier: 2 },
    },
    {
      id: 'evt_xp3',
      kind: 'xp_double',
      startsAtUtc: '2026-10-09T00:00:00Z',
      endsAtUtc: '2026-10-12T00:00:00Z',
      payload: { multiplier: 3 },
    },
  ],
};

const REWARDS: RawRewardsFile = {
  version: 1,
  positionBase: { '2': [100, 50], '4': [200, 120, 60, 20], '6': [300, 180, 120, 80, 40, 20] },
  modeMultiplier: { quick: 1, ranked: 1.25, private: 1, time_trial: 1 },
  bonuses: {
    firstWinOfDay: { type: 'coins', amount: 50 },
    noAbandon: { type: 'coins', amount: 25 },
  },
  privateRoomCapPerDay: 5,
  xpFloor: 5,
  xpDivisor: 10,
};

const LEVELS: RawLevelsFile = {
  version: 1,
  maxLevel: 50,
  xpCurve: 'exponential',
  table: Array.from({ length: 50 }, (_, i) => ({
    level: i + 1,
    xpRequired: (i + 1) * 100,
    rewards: { coins: 0, gems: 0 },
    unlocks: [],
  })),
};

const STORE: RawStoreFile = {
  version: 1,
  sections: [
    {
      id: 'permanent',
      displayName: 'Permanent',
      offers: [
        {
          offerId: 'starter_pack',
          kind: 'pack',
          refId: 'starter',
          displayName: 'Starter',
          priceCoins: 1000,
        },
      ],
    },
  ],
  dailyRotationPoolSize: 1,
};

function setupCatalogs(events: RawEventsFile): void {
  _resetActiveEventsCatalogForTests();
  _resetRewardsForTests();
  _resetLevelsForTests();
  _resetStoreForTests();
  loadEventsCatalog(SILENT_LOGGER, events, null);
  loadRewardsCatalog(SILENT_LOGGER, REWARDS, null);
  loadLevelsCatalog(SILENT_LOGGER, LEVELS, null);
  loadStoreCatalog(SILENT_LOGGER, STORE, null);
}

function makeRaceEvent(overrides: Partial<RaceCompletedEvent> = {}): RaceCompletedEvent {
  return {
    schemaVersion: 1,
    sessionId: 'sid-1',
    mode: 'quick',
    trackId: 'stadium_today',
    size: 4,
    results: [
      { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
      { rank: 2, userId: 'u2', isBot: false, totalMs: 61_000, abandoned: false },
      { rank: 3, userId: 'u3', isBot: false, totalMs: 62_000, abandoned: false },
      { rank: 4, userId: 'u4', isBot: false, totalMs: 63_000, abandoned: false },
    ],
    flags: { needsReview: false },
    closedAt: Date.parse('2026-10-08T12:00:00Z'),
    ...overrides,
  };
}

function seedProfile(fake: FakeNakama, userId: string, level = 1, lastDailyWinAt = 0): void {
  fake.nakama.storageWrite([{
    collection: 'profiles',
    key: userId,
    userId,
    value: {
      schemaVersion: 1,
      userId,
      displayName: userId,
      avatarUrl: null,
      createdAt: 0,
      updatedAt: 0,
      progression: { xp: 0, level, lastDailyWinAt },
      dailyPrivateCount: 0,
    },
    permissionRead: 0,
    permissionWrite: 0,
  }]);
}

function mkDeps(fake: FakeNakama): EventsSubscriberDeps {
  const bus = new EventBus(SILENT_LOGGER);
  return { logger: SILENT_LOGGER, nk: fake.nakama as INakama, bus };
}

describe('events subscriber (Phase 8 Chunk 8)', () => {
  let fake: FakeNakama;
  let deps: EventsSubscriberDeps;

  beforeEach(() => {
    fake = new FakeNakama();
    deps = mkDeps(fake);
  });

  // ─── resolveXpMultiplier pure helper ──────────────────────────────────

  it('resolveXpMultiplier returns 1 when no xp_double active', () => {
    setupCatalogs(EVENTS_NO_DOUBLE);
    const m = resolveXpMultiplier(Date.parse('2026-10-08T12:00:00Z'));
    expect(m).toBe(1);
  });

  it('resolveXpMultiplier returns the active xp_double multiplier', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    const m = resolveXpMultiplier(Date.parse('2026-10-08T12:00:00Z'));
    expect(m).toBe(2);
  });

  it('resolveXpMultiplier picks the highest when multiple overlap (D22)', () => {
    setupCatalogs(EVENTS_XP_TRIPLE);
    const m = resolveXpMultiplier(Date.parse('2026-10-10T00:00:00Z'));
    expect(m).toBe(3);
  });

  // ─── subscriber bonus math ────────────────────────────────────────────

  it('grants 0 bonus when no xp_double active (skip path)', () => {
    setupCatalogs(EVENTS_NO_DOUBLE);
    seedProfile(fake, 'u1');
    const event = makeRaceEvent();
    const summary = handleRaceCompletedForEvents(deps, event);
    expect(summary.perPlayer).toEqual({});
    expect(fake.wallets.get('u1')?.coins ?? 0).toBe(0);
  });

  it('grants baseXp * (multiplier - 1) as coin bonus when xp_double active', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    const event = makeRaceEvent();
    const summary = handleRaceCompletedForEvents(deps, event);
    // Rank 1 in size-4 quick: 200 coins, +50 firstWinOfDay (lastDailyWinAt=0),
    // +25 noAbandon (allReported=true) = 275 coins.
    // xpFromCoins(275, 10, 5) = max(27, 5) = 27.
    // Bonus = 27 * (2 - 1) = 27 coins.
    expect(summary.perPlayer['u1']).toEqual({ baseXp: 27, multiplier: 2, bonusCoins: 27 });
    expect(fake.wallets.get('u1')?.coins).toBe(27);
  });

  it('grants a higher bonus with multiplier 3', () => {
    setupCatalogs(EVENTS_XP_TRIPLE);
    seedProfile(fake, 'u1');
    // Pick a closedAt that falls inside BOTH xp_double events
    // (x2: 2026-10-08..2026-10-15, x3: 2026-10-09..2026-10-12).
    const event = makeRaceEvent({ closedAt: Date.parse('2026-10-10T12:00:00Z') });
    const summary = handleRaceCompletedForEvents(deps, event);
    // 27 baseXp; bonus = 27 * (3 - 1) = 54.
    expect(summary.perPlayer['u1']?.bonusCoins).toBe(54);
    expect(summary.perPlayer['u1']?.multiplier).toBe(3);
  });

  it('skips bots and abandoned finishers', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    seedProfile(fake, 'u4');
    const event: RaceCompletedEvent = {
      ...makeRaceEvent(),
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: 'bot-1', isBot: true, totalMs: 61_000, abandoned: false },
        { rank: 3, userId: 'u3', isBot: false, totalMs: 62_000, abandoned: true },
        { rank: 4, userId: 'u4', isBot: false, totalMs: 63_000, abandoned: false },
      ],
    };
    const summary = handleRaceCompletedForEvents(deps, event);
    expect(Object.keys(summary.perPlayer).sort()).toEqual(['u1', 'u4']);
  });

  it('skips entries with missing userId', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    const event: RaceCompletedEvent = {
      ...makeRaceEvent(),
      results: [
        { rank: 1, userId: 'u1', isBot: false, totalMs: 60_000, abandoned: false },
        { rank: 2, userId: '', isBot: false, totalMs: 61_000, abandoned: false },
      ],
    };
    const summary = handleRaceCompletedForEvents(deps, event);
    expect(Object.keys(summary.perPlayer)).toEqual(['u1']);
  });

  it('sends an event_xp_applied inbox for every paid finisher', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    const event = makeRaceEvent();
    handleRaceCompletedForEvents(deps, event);
    const key = `liveops_inbox/u1/event_xp_applied:${event.sessionId}:u1/u1`;
    const obj = fake.store.get(key);
    expect(obj).toBeDefined();
    const v = obj!.value as { type: string; payload: { coins: number; note: string } };
    expect(v.type).toBe('event_xp_applied');
    expect(v.payload.coins).toBe(27);
    expect(v.payload.note).toMatch(/x2/);
  });

  it('is idempotent across re-fires for the same race (race-tied key)', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    const event = makeRaceEvent();
    handleRaceCompletedForEvents(deps, event);
    handleRaceCompletedForEvents(deps, event);
    expect(fake.wallets.get('u1')?.coins).toBe(27);
    // The wallet should only have a single ledger entry from this race.
    const ledger = fake.ledger.get('u1') ?? [];
    const eventEntries = ledger.filter(
      (e) => (e as { metadata?: { reason?: string } }).metadata?.reason === `event:event_xp_double:${event.sessionId}`,
    );
    expect(eventEntries).toHaveLength(1);
  });

  it('skips when no profile exists (player never authenticated)', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    const event = makeRaceEvent();
    const summary = handleRaceCompletedForEvents(deps, event);
    expect(summary.perPlayer).toEqual({});
  });

  it('skips when race would grant 0 baseXp', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    // xpFloor = 5; no race can produce 0 baseXp in our setup, but
    // sanity-check that the subscriber still handles the no-results
    // case without throwing.
    const event: RaceCompletedEvent = { ...makeRaceEvent(), results: [] };
    const summary = handleRaceCompletedForEvents(deps, event);
    expect(summary.perPlayer).toEqual({});
  });

  // ─── bus integration ──────────────────────────────────────────────────

  it('subscribeEvents wires the bus and never-throws on a broken payload', () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    const bus = new EventBus(SILENT_LOGGER);
    subscribeEvents({ logger: SILENT_LOGGER, nk: fake.nakama as INakama, bus });
    expect(bus.subscriberCount('RaceCompleted')).toBe(1);
    // Fire a malformed payload — subscriber swallows it.
    expect(() => bus.publish('RaceCompleted', { bad: true } as unknown)).not.toThrow();
  });

  it('handles a real RACE_EVENT_RACE_COMPLETED publish end-to-end', async () => {
    setupCatalogs(EVENTS_XP_DOUBLE);
    seedProfile(fake, 'u1');
    const bus = new EventBus(SILENT_LOGGER);
    subscribeEvents({ logger: SILENT_LOGGER, nk: fake.nakama as INakama, bus });
    await bus.publish(RACE_EVENT_RACE_COMPLETED, makeRaceEvent());
    expect(fake.wallets.get('u1')?.coins).toBe(27);
  });
});
