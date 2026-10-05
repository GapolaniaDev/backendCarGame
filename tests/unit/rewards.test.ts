// Unit tests for the Phase 3 reward computation.
//
// Covers `computeRewardForResult` and `computeRewardForResultWithContext`
// against the rewards catalog — pure functions, no storage / Nakama.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadRewardsCatalog,
  validate,
  _resetRewardsForTests,
  getRewardsCatalog,
} from '../../modules/src/economy/catalog';
import {
  computeRewardForResultWithContext,
  isPrivateRacePaid,
  sizeKeyForEvent,
} from '../../modules/src/economy/rewards';
import type { ILogger } from '../../modules/src/nkruntime';
import type { RawRewardsFile } from '../../modules/src/economy/catalog';
import type { RaceResult } from '../../modules/src/race/types';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const CATALOG: RawRewardsFile = {
  version: 1,
  positionBase: {
    '2': [100, 50],
    '4': [100, 70, 50, 35],
    '6': [100, 80, 65, 50, 40, 30],
  },
  modeMultiplier: { quick: 1.0, ranked: 1.25, private: 0.25, time_trial: 1.0 },
  bonuses: {
    firstWinOfDay: { type: 'coins', amount: 100 },
    noAbandon: { type: 'coins', amount: 10 },
  },
  privateRoomCapPerDay: 3,
  xpFloor: 20,
  xpDivisor: 2,
};

function mkResult(overrides: Partial<RaceResult> = {}): RaceResult {
  return {
    rank: 1,
    userId: 'u-1',
    isBot: false,
    totalMs: 60_000,
    abandoned: false,
    ...overrides,
  };
}

describe('economy/rewards — computeRewardForResultWithContext (size 4)', () => {
  beforeEach(() => {
    _resetRewardsForTests();
    loadRewardsCatalog(SILENT_LOGGER, CATALOG, { localcachePut: () => {} } as unknown as Parameters<typeof loadRewardsCatalog>[2]);
  });

  it('awards positionBase × modeMultiplier for rank 1 quick', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 1 }),
      'quick',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    // size 4, rank 1 → base 100 × quick 1.0 = 100; no first-win bonus; noAbandon bonus 10 → 110
    expect(r).toEqual([
      { kind: 'coins', amount: 100 },
      { kind: 'coins', amount: 10 },
    ]);
  });

  it('multiplies by mode (ranked = ×1.25)', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 1 }),
      'ranked',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    // 100 × 1.25 = 125 floor + 10 noAbandon = 135
    expect(r).toEqual([
      { kind: 'coins', amount: 125 },
      { kind: 'coins', amount: 10 },
    ]);
  });

  it('applies the private multiplier (×0.25)', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 1 }),
      'private',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    // 100 × 0.25 = 25 + 10 noAbandon = 35
    expect(r).toEqual([
      { kind: 'coins', amount: 25 },
      { kind: 'coins', amount: 10 },
    ]);
  });

  it('omits noAbandon when not all players reported', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 1 }),
      'quick',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      false,
      getRewardsCatalog(),
    );
    expect(r).toEqual([{ kind: 'coins', amount: 100 }]);
  });

  it('stacks first-win-of-day bonus on top of position coins', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 2 }),
      'quick',
      { isFirstWinOfDay: true, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    // size 4, rank 2 → 70 + firstWin 100 + noAbandon 10 = 180
    expect(r).toEqual([
      { kind: 'coins', amount: 70 },
      { kind: 'coins', amount: 100 },
      { kind: 'coins', amount: 10 },
    ]);
  });

  it('returns no rewards for abandoned results', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ abandoned: true }),
      'quick',
      { isFirstWinOfDay: true, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    expect(r).toEqual([]);
  });

  it('returns no rewards for bot results', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ isBot: true }),
      'quick',
      { isFirstWinOfDay: true, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
    );
    expect(r).toEqual([]);
  });

  it('handles size 6: rank 4 → 50 coins', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 4 }),
      'quick',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
      6,
    );
    expect(r[0]).toEqual({ kind: 'coins', amount: 50 });
  });

  it('size 6: rank 6 → 30 coins (last place)', () => {
    const r = computeRewardForResultWithContext(
      mkResult({ rank: 6 }),
      'quick',
      { isFirstWinOfDay: false, dailyPrivateCount: 0, finished: true },
      true,
      getRewardsCatalog(),
      6,
    );
    expect(r[0]).toEqual({ kind: 'coins', amount: 30 });
  });
});

describe('economy/rewards — sizeKeyForEvent', () => {
  it('maps race sizes 2/4/6 to their catalog keys; size 1 falls through to 4', () => {
    expect(sizeKeyForEvent(2)).toBe('2');
    expect(sizeKeyForEvent(4)).toBe('4');
    expect(sizeKeyForEvent(6)).toBe('6');
    expect(sizeKeyForEvent(1)).toBe('4');
  });
});

describe('economy/rewards — isPrivateRacePaid', () => {
  beforeEach(() => {
    _resetRewardsForTests();
    loadRewardsCatalog(SILENT_LOGGER, CATALOG, { localcachePut: () => {} } as unknown as Parameters<typeof loadRewardsCatalog>[2]);
  });

  it('returns true for non-private modes regardless of counter', () => {
    expect(isPrivateRacePaid(getRewardsCatalog(), 'quick', 999)).toBe(true);
    expect(isPrivateRacePaid(getRewardsCatalog(), 'ranked', 999)).toBe(true);
    expect(isPrivateRacePaid(getRewardsCatalog(), 'time_trial', 999)).toBe(true);
  });

  it('returns true when private counter is below cap', () => {
    expect(isPrivateRacePaid(getRewardsCatalog(), 'private', 0)).toBe(true);
    expect(isPrivateRacePaid(getRewardsCatalog(), 'private', 2)).toBe(true);
  });

  it('returns false when private counter equals or exceeds cap', () => {
    expect(isPrivateRacePaid(getRewardsCatalog(), 'private', 3)).toBe(false);
    expect(isPrivateRacePaid(getRewardsCatalog(), 'private', 4)).toBe(false);
  });
});