// Unit tests for the Phase 3 economy/rewards catalog validator and
// loader. Mirrors the shape of tests/unit/catalog.test.ts (Phase 1).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadRewardsCatalog,
  validate,
  _resetRewardsForTests,
  getRewardsCatalog,
  sizeKeyFor,
} from '../../modules/src/economy/catalog';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawRewardsFile } from '../../modules/src/economy/catalog';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const VALID: RawRewardsFile = {
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

describe('economy/rewards catalog validator (Chunk 1)', () => {
  beforeEach(() => _resetRewardsForTests());

  it('accepts the canonical Phase 3 file', () => {
    expect(() => validate(VALID)).not.toThrow();
  });

  it('rejects unknown version', () => {
    expect(() => validate({ ...VALID, version: 2 })).toThrow(/version/);
  });

  it('rejects unknown modeMultiplier key', () => {
    expect(() =>
      validate({ ...VALID, modeMultiplier: { ...VALID.modeMultiplier, racing: 1 } }),
    ).toThrow(/modeMultiplier/);
  });

  it('rejects negative modeMultiplier', () => {
    expect(() =>
      validate({
        ...VALID,
        modeMultiplier: { ...VALID.modeMultiplier, quick: -0.5 },
      }),
    ).toThrow(/modeMultiplier\.quick/);
  });

  it('rejects unknown positionBase size key', () => {
    expect(() =>
      validate({ ...VALID, positionBase: { ...VALID.positionBase, '8': [1] } }),
    ).toThrow(/positionBase/);
  });

  it('rejects non-integer positionBase entries', () => {
    expect(() =>
      validate({ ...VALID, positionBase: { '2': [100.5, 50] } }),
    ).toThrow(/positionBase\.2/);
  });

  it('rejects negative positionBase entries', () => {
    expect(() =>
      validate({ ...VALID, positionBase: { '2': [-10, 50] } }),
    ).toThrow(/positionBase\.2/);
  });

  it('rejects unknown bonus type', () => {
    expect(() =>
      validate({
        ...VALID,
        bonuses: {
          firstWinOfDay: { type: 'usd' as 'coins', amount: 100 },
          noAbandon: VALID.bonuses.noAbandon,
        },
      }),
    ).toThrow(/bonuses\.firstWinOfDay\.type/);
  });

  it('rejects negative bonus amount', () => {
    expect(() =>
      validate({
        ...VALID,
        bonuses: {
          firstWinOfDay: { type: 'coins', amount: -5 },
          noAbandon: VALID.bonuses.noAbandon,
        },
      }),
    ).toThrow(/bonuses\.firstWinOfDay\.amount/);
  });

  it('rejects negative privateRoomCapPerDay', () => {
    expect(() => validate({ ...VALID, privateRoomCapPerDay: -1 })).toThrow(
      /privateRoomCapPerDay/,
    );
  });

  it('rejects xpDivisor = 0', () => {
    expect(() => validate({ ...VALID, xpDivisor: 0 })).toThrow(/xpDivisor/);
  });
});

describe('economy/rewards catalog loader', () => {
  beforeEach(() => _resetRewardsForTests());

  it('loadRewardsCatalog freezes the runtime state', () => {
    const fakeNk = {
      localcachePut: () => {},
    } as unknown as INakama;
    loadRewardsCatalog(SILENT_LOGGER, VALID, fakeNk);
    const c = getRewardsCatalog();
    expect(c.positionBase['4']).toEqual([100, 70, 50, 35]);
    expect(c.modeMultiplier.ranked).toBe(1.25);
    expect(c.bonuses.firstWinOfDay.amount).toBe(100);
    expect(c.privateRoomCapPerDay).toBe(3);
    expect(c.xpFloor).toBe(20);
    expect(c.xpDivisor).toBe(2);
  });

  it('getRewardsCatalog throws before load', () => {
    expect(() => getRewardsCatalog()).toThrow(/not loaded/);
  });

  it('rejects invalid input with CATALOG_INVALID-style error', () => {
    expect(() => loadRewardsCatalog(SILENT_LOGGER, { ...VALID, version: 2 })).toThrow(
      /rewards catalog invalid/,
    );
  });
});

describe('economy/catalog helpers (Chunk 1)', () => {
  it('sizeKeyFor maps 2/4/6 to expected keys; 1 fall through', () => {
    expect(sizeKeyFor(2)).toBe('2');
    expect(sizeKeyFor(4)).toBe('4');
    expect(sizeKeyFor(6)).toBe('6');
    expect(sizeKeyFor(1)).toBe('4');
    expect(sizeKeyFor(99)).toBe('4');
  });
});