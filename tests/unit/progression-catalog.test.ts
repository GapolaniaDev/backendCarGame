// Unit tests for the Phase 3 progression/levels catalog.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLevelsCatalog,
  validate,
  _resetLevelsForTests,
  getLevelsCatalog,
} from '../../modules/src/progression/catalog';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawLevelsFile } from '../../modules/src/progression/catalog';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

function buildTable(n: number) {
  const out = [];
  let xp = 0;
  for (let i = 1; i <= n; i++) {
    out.push({
      level: i,
      xpRequired: xp,
      rewards: { coins: i * 10 },
      unlocks: i === 5 ? ['ranked_queue'] : [],
    });
    xp += 100 + i * 10;
  }
  return out;
}

const VALID: RawLevelsFile = {
  version: 1,
  maxLevel: 50,
  xpCurve: 'table',
  table: buildTable(50) as RawLevelsFile['table'],
};

describe('progression/levels catalog validator (Chunk 1)', () => {
  beforeEach(() => _resetLevelsForTests());

  it('accepts the canonical Phase 3 file', () => {
    expect(() => validate(VALID)).not.toThrow();
  });

  it('rejects unknown version', () => {
    expect(() => validate({ ...VALID, version: 2 })).toThrow(/version/);
  });

  it('rejects wrong maxLevel', () => {
    expect(() => validate({ ...VALID, maxLevel: 99 })).toThrow(/maxLevel/);
  });

  it('rejects unknown xpCurve', () => {
    expect(() => validate({ ...VALID, xpCurve: 'linear' as 'table' })).toThrow(/xpCurve/);
  });

  it('rejects table with fewer than 50 rows', () => {
    expect(() =>
      validate({ ...VALID, table: buildTable(49) as RawLevelsFile['table'] }),
    ).toThrow(/table must have exactly 50/);
  });

  it('rejects table with non-monotonic xpRequired', () => {
    const bad = buildTable(50);
    (bad[10] as { xpRequired: number }).xpRequired = 5; // lower than previous
    expect(() => validate({ ...VALID, table: bad as RawLevelsFile['table'] })).toThrow(
      /strictly increasing/,
    );
  });

  it('rejects negative rewards.coins', () => {
    const bad = buildTable(50);
    (bad[0] as { rewards: { coins: number } }).rewards.coins = -1;
    expect(() => validate({ ...VALID, table: bad as RawLevelsFile['table'] })).toThrow(
      /rewards\.coins/,
    );
  });

  it('rejects non-string unlocks entries', () => {
    const bad = buildTable(50);
    (bad[4] as { unlocks: unknown[] }).unlocks = [42];
    expect(() => validate({ ...VALID, table: bad as RawLevelsFile['table'] })).toThrow(
      /unlocks/,
    );
  });

  it('rejects duplicate level numbers', () => {
    const bad = buildTable(50);
    (bad[3] as { level: number }).level = 2; // duplicate of row 1
    expect(() => validate({ ...VALID, table: bad as RawLevelsFile['table'] })).toThrow(
      /duplicate level/,
    );
  });
});

describe('progression/levels catalog loader', () => {
  beforeEach(() => _resetLevelsForTests());

  it('freezes and exposes the table', () => {
    const fakeNk = { localcachePut: () => {} } as unknown as INakama;
    loadLevelsCatalog(SILENT_LOGGER, VALID, fakeNk);
    const c = getLevelsCatalog();
    expect(c.maxLevel).toBe(50);
    expect(c.table.length).toBe(50);
    expect(c.table[0]?.level).toBe(1);
    expect(c.table[49]?.level).toBe(50);
  });

  it('throws before load', () => {
    expect(() => getLevelsCatalog()).toThrow(/not loaded/);
  });
});