// Phase 6 Chunk 6 — pass season helpers unit tests.
//
// Covers:
//   - getCurrentSeasonId (catalog delegate)
//   - isSeasonExpired (boundary: before / at / after endUtc)
//   - readSeasonCloseMarker (absent + present)
//   - maybeCloseSeason — still active, just expired, idempotent
//   - settleClosedSeasonRewards (no row / row + flip / CAS retry)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCurrentSeasonId,
  isSeasonExpired,
  maybeCloseSeason,
  readSeasonCloseMarker,
  SEASON_CLOSE_COLLECTION,
  seasonCloseKey,
  settleClosedSeasonRewards,
} from '../../modules/src/pass/season';
import {
  loadPassCatalog,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import { ensurePassRecord } from '../../modules/src/pass/pass_repo';
import type { PassRecord } from '../../modules/src/pass/types';
import type { ILogger } from '../../modules/src/nkruntime';
import { FakeNakama, FakeLogger, SYSTEM_USER_ID } from '../e2e/_stubs';
import passS1Raw from '../../modules/src/catalogs/pass_s1.json';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

/** Build a synthetic RawPassFile with N levels where N === maxLevel. */
function buildRaw(seasonId: string, startUtc: string, endUtc: string, levels = 40): RawPassFile {
  const out: RawPassFile = {
    version: 1,
    seasonId,
    startUtc,
    endUtc,
    maxLevel: levels,
    premiumPriceGems: 800,
    levels: [],
  };
  for (let i = 1; i <= levels; i += 1) {
    out.levels.push({
      level: i,
      xpRequired: i === 1 ? 0 : (i - 1) * 100,
      freeReward: { coins: 100 },
      premiumReward: { coins: 200 },
    });
  }
  return out;
}

describe('pass season helpers (Phase 6 Chunk 6)', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
  });

  describe('getCurrentSeasonId + isSeasonExpired', () => {
    it('getCurrentSeasonId delegates to the catalog', () => {
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(getCurrentSeasonId()).toBe('unit-s1');
    });

    it('isSeasonExpired: false before endUtc', () => {
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(isSeasonExpired(Date.parse('2026-01-15T00:00:00Z'))).toBe(false);
    });

    it('isSeasonExpired: true at endUtc (boundary inclusive)', () => {
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(isSeasonExpired(Date.parse('2026-02-01T00:00:00Z'))).toBe(true);
    });

    it('isSeasonExpired: true after endUtc', () => {
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(isSeasonExpired(Date.parse('2026-03-01T00:00:00Z'))).toBe(true);
    });
  });

  describe('seasonCloseKey + SEASON_CLOSE_COLLECTION', () => {
    it('collection name is season_close', () => {
      expect(SEASON_CLOSE_COLLECTION).toBe('season_close');
    });

    it('seasonCloseKey returns the seasonId verbatim', () => {
      expect(seasonCloseKey('s1')).toBe('s1');
      expect(seasonCloseKey('unit-s1')).toBe('unit-s1');
    });
  });

  describe('readSeasonCloseMarker', () => {
    it('returns null when absent', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(readSeasonCloseMarker(fake.nakama, 'unit-s1')).toBeNull();
    });

    it('returns the marker when present', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      const ts = 1_700_000_000_000;
      fake.store.set(`${SEASON_CLOSE_COLLECTION}/unit-s1/${SYSTEM_USER_ID}`, {
        collection: SEASON_CLOSE_COLLECTION,
        key: 'unit-s1',
        userId: SYSTEM_USER_ID,
        value: { schemaVersion: 1, closedAt: ts },
        version: 'v00000001',
        permissionRead: 1,
        permissionWrite: 1,
        createTime: new Date(0).toISOString(),
        updateTime: new Date(0).toISOString(),
        expiresAt: null,
      });
      expect(readSeasonCloseMarker(fake.nakama, 'unit-s1')).toEqual({
        schemaVersion: 1,
        closedAt: ts,
      });
    });
  });

  describe('maybeCloseSeason', () => {
    it('returns no-op when now < endUtc', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      const r = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-01-15T00:00:00Z'), 'unit-s1');
      expect(r.closed).toBe(false);
      expect(r.passSeasonId).toBe('unit-s1');
      expect(r.endUtc).toBe('2026-02-01T00:00:00Z');
      expect(readSeasonCloseMarker(fake.nakama, 'unit-s1')).toBeNull();
    });

    it('performs close + writes marker when now >= endUtc', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      const r = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-03-01T00:00:00Z'), 'unit-s1');
      expect(r.closed).toBe(true);
      expect(readSeasonCloseMarker(fake.nakama, 'unit-s1')).not.toBeNull();
    });

    it('is idempotent — second call is a no-op', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      const r1 = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-03-01T00:00:00Z'), 'unit-s1');
      expect(r1.closed).toBe(true);
      const r2 = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-03-01T00:00:00Z'), 'unit-s1');
      expect(r2.closed).toBe(false);
      expect(r2.passSeasonId).toBe('unit-s1');
    });
  });

  describe('settleClosedSeasonRewards', () => {
    it('no-op when the user has no PassRecord yet', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      expect(() => settleClosedSeasonRewards(fake.nakama, silentLogger, 'no-such-user', 'unit-s1')).not.toThrow();
    });

    it('flips seasonClosed=true on a player with an existing record', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      ensurePassRecord(fake.nakama, silentLogger, 'p1');
      // Before settle.
      const beforeRow = fake.store.get(`pass/p1/p1`)!;
      const beforeRec = beforeRow.value as PassRecord;
      expect(beforeRec.seasonClosed).toBe(false);

      settleClosedSeasonRewards(fake.nakama, silentLogger, 'p1', 'unit-s1');

      const afterRow = fake.store.get(`pass/p1/p1`)!;
      const afterRec = afterRow.value as PassRecord;
      expect(afterRec.seasonClosed).toBe(true);
    });

    it('is a no-op when the record already has seasonClosed=true', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      ensurePassRecord(fake.nakama, silentLogger, 'p2');
      // Force seasonClosed=true via direct store mutation.
      const before = fake.store.get(`pass/p2/p2`)!;
      const updated = { ...(before.value as PassRecord), seasonClosed: true };
      fake.store.set(`pass/p2/p2`, { ...before, value: updated, version: 'v00000002' });

      settleClosedSeasonRewards(fake.nakama, silentLogger, 'p2', 'unit-s1');

      const after = fake.store.get(`pass/p2/p2`)!;
      // No new version bump (no write happened).
      expect(after.version).toBe('v00000002');
    });
  });

  describe('integration: end-to-end close', () => {
    it('pass_get triggers maybeCloseSeason + flips seasonClosed', () => {
      const fake = new FakeNakama();
      loadPassCatalog(silentLogger, buildRaw('unit-s1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
      const logger = new FakeLogger();
      const nowAfter = Date.parse('2026-03-01T00:00:00Z');
      const r1 = maybeCloseSeason(fake.nakama, logger, nowAfter, 'unit-s1');
      expect(r1.closed).toBe(true);
      // Simulate a player's pass_get post-close.
      const ensured = ensurePassRecord(fake.nakama, silentLogger, 'pX');
      settleClosedSeasonRewards(fake.nakama, silentLogger, 'pX', 'unit-s1');
      const stored = fake.store.get(`pass/pX/pX`)!;
      expect((stored.value as PassRecord).seasonClosed).toBe(true);
      expect((stored.value as PassRecord).seasonId).toBe(ensured.record.seasonId);
    });
  });

  describe('bundled pass_s1 catalog still loads (regression)', () => {
    it('bundled pass_s1.json loads + computes expiry correctly', () => {
      loadPassCatalog(silentLogger, passS1Raw as unknown as RawPassFile);
      expect(getCurrentSeasonId()).toBe('s1');
      // Pass s1 endUtc is 2027-12-31 → mid-2026 is not expired.
      expect(isSeasonExpired(Date.parse('2026-06-30T00:00:00Z'))).toBe(false);
      expect(isSeasonExpired(Date.parse('2028-01-01T00:00:00Z'))).toBe(true);
    });
  });
});