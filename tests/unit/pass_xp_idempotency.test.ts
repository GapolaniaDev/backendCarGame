// Phase 6 Chunk 7 — addPassXp idempotency tests (pass_xp_ledger).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPassXp,
  ensurePassRecord,
  isXpLedgerApplied,
  PASS_XP_LEDGER_COLLECTION,
  passXpLedgerKey,
} from '../../modules/src/pass/pass_repo';
import {
  loadPassCatalog,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import { FakeNakama } from '../e2e/_stubs';
import type { ILogger } from '../../modules/src/nkruntime';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

/** 40-level synthetic catalog matching the bundled shape. */
const PASS_RAW: RawPassFile = (() => {
  const out: RawPassFile = {
    version: 1,
    seasonId: 'unit-s1',
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2027-12-31T00:00:00Z',
    maxLevel: 40,
    premiumPriceGems: 800,
    levels: [],
  };
  for (let i = 1; i <= 40; i += 1) {
    out.levels.push({
      level: i,
      xpRequired: i === 1 ? 0 : (i - 1) * 200,
      freeReward: { coins: 100 },
      premiumReward: { coins: 200 },
    });
  }
  return out;
})();

describe('addPassXp idempotency (Phase 6 Chunk 7)', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, PASS_RAW);
  });

  it('first call with dedupeKey → XP applied', () => {
    const fake = new FakeNakama();
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 25, {
      source: 'race_quick', id: 'session-A',
    });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.applied).toBe(true);
    expect(r.record.xp).toBe(25);
    expect(isXpLedgerApplied(fake.nakama, 'u1', 'race_quick', 'session-A')).toBe(true);
  });

  it('second call with the SAME dedupeKey → applied=false, no XP added', () => {
    const fake = new FakeNakama();
    addPassXp(fake.nakama, silentLogger, 'u1', 25, {
      source: 'race_quick', id: 'session-A',
    });
    const r2 = addPassXp(fake.nakama, silentLogger, 'u1', 25, {
      source: 'race_quick', id: 'session-A',
    });
    expect(r2).not.toBeNull();
    if (!r2) return;
    expect(r2.applied).toBe(false);
    expect(r2.record.xp).toBe(25); // unchanged
  });

  it('different dedupeKey on the same user → 2 distinct applies', () => {
    const fake = new FakeNakama();
    addPassXp(fake.nakama, silentLogger, 'u1', 25, {
      source: 'race_quick', id: 'session-A',
    });
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 30, {
      source: 'race_quick', id: 'session-B',
    });
    expect(r?.applied).toBe(true);
    expect(r?.record.xp).toBe(55);
  });

  it('without dedupeKey, every call applies (legacy subscribers / claim XP)', () => {
    const fake = new FakeNakama();
    const a = addPassXp(fake.nakama, silentLogger, 'u1', 25);
    const b = addPassXp(fake.nakama, silentLogger, 'u1', 30);
    expect(a?.applied).toBe(true);
    expect(b?.applied).toBe(true);
    expect(b?.record.xp).toBe(55);
  });

  it('levelUps array includes every level crossed in one grant', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    // xpRequired(1)=0, (2)=200, (3)=400, (4)=600, (5)=800, (6)=1000
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 1000);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.applied).toBe(true);
    expect(r.record.xp).toBe(1000);
    expect(r.newLevel).toBe(6);
    expect(r.levelUps).toEqual([2, 3, 4, 5, 6]);
  });

  it('XP past maxLevel caps at maxLevel XP — never negative', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 10_000_000);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.record.xp).toBe(10_000_000);
    expect(r.newLevel).toBe(40);
    // 2..40 = 39 level-ups (capped).
    expect(r.levelUps.length).toBe(39);
  });

  it('lazy-creates the PassRecord when none exists', () => {
    const fake = new FakeNakama();
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 50, {
      source: 'mission_claim', id: 'm1',
    });
    expect(r?.applied).toBe(true);
    expect(r?.record.xp).toBe(50);
    const stored = fake.store.get(`pass/u1/u1`);
    expect(stored).toBeDefined();
    const ledger = fake.store.get(
      `${PASS_XP_LEDGER_COLLECTION}/${passXpLedgerKey('u1', 'mission_claim', 'm1')}/u1`,
    );
    expect(ledger).toBeDefined();
  });

  it('isXpLedgerApplied is true after a grant, false before', () => {
    const fake = new FakeNakama();
    expect(isXpLedgerApplied(fake.nakama, 'u1', 'race_quick', 'sX')).toBe(false);
    addPassXp(fake.nakama, silentLogger, 'u1', 10, { source: 'race_quick', id: 'sX' });
    expect(isXpLedgerApplied(fake.nakama, 'u1', 'race_quick', 'sX')).toBe(true);
  });
});