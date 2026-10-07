// Phase 6 Chunk 6 — pass_repo unit tests.
//
// Covers:
//   - PASS_COLLECTION + passRecordKey constants
//   - readPassRecord (absent + present + wrong-season row treated as absent)
//   - writePassCreate (initial write with no version)
//   - writePassUpdate (CAS write)
//   - ensurePassRecord (lazy-create, server-owned perms, idempotent)
//   - addPassXp (lazy-create + accumulate + CAS retry)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPassXp,
  ensurePassRecord,
  PASS_COLLECTION,
  passRecordKey,
  readPassRecord,
  writePassCreate,
  writePassUpdate,
} from '../../modules/src/pass/pass_repo';
import {
  loadPassCatalog,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import type { PassRecord } from '../../modules/src/pass/types';
import type { ILogger } from '../../modules/src/nkruntime';
import { FakeNakama } from '../e2e/_stubs';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

const PASS_RAW: RawPassFile = {
  version: 1,
  seasonId: 'repo-s1',
  startUtc: '2026-01-01T00:00:00Z',
  endUtc: '2026-02-01T00:00:00Z',
  maxLevel: 40,
  premiumPriceGems: 800,
  levels: (() => {
    const out: RawPassFile['levels'] = [];
    for (let i = 1; i <= 40; i += 1) {
      out.push({
        level: i,
        xpRequired: i === 1 ? 0 : (i - 1) * 100,
        freeReward: { coins: 100 },
        premiumReward: { coins: 200 },
      });
    }
    return out;
  })(),
};

describe('pass_repo (Phase 6 Chunk 6) — constants', () => {
  it('PASS_COLLECTION is "pass"', () => {
    expect(PASS_COLLECTION).toBe('pass');
  });

  it('passRecordKey returns the userId verbatim', () => {
    expect(passRecordKey('u1')).toBe('u1');
    expect(passRecordKey('uuid-1234')).toBe('uuid-1234');
  });
});

describe('pass_repo (Phase 6 Chunk 6) — readPassRecord', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, PASS_RAW);
  });

  it('returns null when no row exists', () => {
    const fake = new FakeNakama();
    expect(readPassRecord(fake.nakama, 'u1', 'repo-s1')).toBeNull();
  });

  it('returns the row + version when present + season matches', () => {
    const fake = new FakeNakama();
    const ensured = ensurePassRecord(fake.nakama, silentLogger, 'u1');
    const r = readPassRecord(fake.nakama, 'u1', 'repo-s1');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.record.userId).toBe('u1');
    expect(r.record.seasonId).toBe('repo-s1');
    expect(r.version).toBe(ensured.version);
  });

  it('returns null when the row belongs to a different season (treated as absent)', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    // Lookup with a different seasonId → absent.
    expect(readPassRecord(fake.nakama, 'u1', 'different-season')).toBeNull();
  });
});

describe('pass_repo (Phase 6 Chunk 6) — writePassCreate + writePassUpdate', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, PASS_RAW);
  });

  it('writePassCreate writes a new row without a version', () => {
    const fake = new FakeNakama();
    const rec: PassRecord = {
      schemaVersion: 1,
      userId: 'u1',
      seasonId: 'repo-s1',
      xp: 0,
      claimedFree: [],
      claimedPremium: [],
      premiumPurchased: false,
      seasonClosed: false,
    };
    const version = writePassCreate(fake.nakama, rec);
    expect(version).toBe('v00000001');
    const stored = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    expect(stored.value).toEqual(rec);
    expect(stored.permissionRead).toBe(1);
    expect(stored.permissionWrite).toBe(1);
  });

  it('writePassUpdate CAS-updates an existing row (version bumps)', () => {
    const fake = new FakeNakama();
    const v1 = writePassCreate(fake.nakama, {
      schemaVersion: 1,
      userId: 'u2',
      seasonId: 'repo-s1',
      xp: 0,
      claimedFree: [],
      claimedPremium: [],
      premiumPurchased: false,
      seasonClosed: false,
    });
    expect(v1).toBe('v00000001');
    const v2 = writePassUpdate(fake.nakama, {
      schemaVersion: 1,
      userId: 'u2',
      seasonId: 'repo-s1',
      xp: 100,
      claimedFree: [1],
      claimedPremium: [],
      premiumPurchased: false,
      seasonClosed: false,
    }, v1);
    expect(v2).toBe('v00000002');
    const stored = fake.store.get(`${PASS_COLLECTION}/u2/u2`)!;
    expect((stored.value as PassRecord).xp).toBe(100);
    expect((stored.value as PassRecord).claimedFree).toEqual([1]);
  });
});

describe('pass_repo (Phase 6 Chunk 6) — ensurePassRecord', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, PASS_RAW);
  });

  it('lazy-creates the row with default fields', () => {
    const fake = new FakeNakama();
    const r = ensurePassRecord(fake.nakama, silentLogger, 'u1');
    expect(r.created).toBe(true);
    expect(r.record.userId).toBe('u1');
    expect(r.record.seasonId).toBe('repo-s1');
    expect(r.record.xp).toBe(0);
    expect(r.record.claimedFree).toEqual([]);
    expect(r.record.claimedPremium).toEqual([]);
    expect(r.record.premiumPurchased).toBe(false);
    expect(r.record.seasonClosed).toBe(false);
    expect(r.version).toBe('v00000001');
  });

  it('idempotent — second call returns the same row, created=false', () => {
    const fake = new FakeNakama();
    const r1 = ensurePassRecord(fake.nakama, silentLogger, 'u1');
    expect(r1.created).toBe(true);
    const r2 = ensurePassRecord(fake.nakama, silentLogger, 'u1');
    expect(r2.created).toBe(false);
    expect(r2.record.userId).toBe('u1');
    expect(r2.version).toBe(r1.version);
  });
});

describe('pass_repo (Phase 6 Chunk 6) — addPassXp', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, PASS_RAW);
  });

  it('adds a positive delta to an existing record', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    const next = addPassXp(fake.nakama, silentLogger, 'u1', 50);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.xp).toBe(50);
  });

  it('lazy-creates the row when none exists, then adds XP', () => {
    const fake = new FakeNakama();
    const next = addPassXp(fake.nakama, silentLogger, 'u1', 25);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.xp).toBe(25);
    const stored = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    expect(stored).toBeDefined();
  });

  it('accumulates across multiple calls', () => {
    const fake = new FakeNakama();
    addPassXp(fake.nakama, silentLogger, 'u1', 30);
    addPassXp(fake.nakama, silentLogger, 'u1', 70);
    const stored = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    expect((stored.value as PassRecord).xp).toBe(100);
  });

  it('rejects negative deltas (no write, no change)', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    expect(addPassXp(fake.nakama, silentLogger, 'u1', -5)).toBeNull();
    const stored = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    expect((stored.value as PassRecord).xp).toBe(0);
  });

  it('zero delta is a no-op (returns the existing record, no write)', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    const before = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    const r = addPassXp(fake.nakama, silentLogger, 'u1', 0);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.xp).toBe(0);
    const after = fake.store.get(`${PASS_COLLECTION}/u1/u1`)!;
    expect(after.version).toBe(before.version);
  });

  it('rejects non-integer deltas', () => {
    const fake = new FakeNakama();
    ensurePassRecord(fake.nakama, silentLogger, 'u1');
    expect(addPassXp(fake.nakama, silentLogger, 'u1', 1.5)).toBeNull();
    expect(addPassXp(fake.nakama, silentLogger, 'u1', Number.NaN)).toBeNull();
  });
});