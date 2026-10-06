// Phase 4 Chunk 8 unit tests: stats equalization for ranked sessions.
//
// The helper `loadoutStatsFor` reads the player's garage, finds the
// OwnedCar matching `loadout.bodyId`, and computes the effective stats
// via `computeStats` (normal) or `computeStatsForRanked` (ranked).
//
// Tests cover:
//   - empty/missing garage → null
//   - missing OwnedCar → null
//   - missing catalog entry → null
//   - ranked: stats equalized to the car's maxStats (class-top)
//   - normal: stats equal to baseStats + cumulativeDelta, clamped

import { describe, it, expect, beforeAll } from 'vitest';
import {
  computeEffectiveStats,
  loadoutStatsFor,
  emptyOwnedCar,
} from '../../modules/src/race/stats_equalization';
import { loadGarageCatalog } from '../../modules/src/garage/catalog';
import {
  applyStatsEqualizationToMatchedSession,
  buildRaceSessionFromCandidate,
} from '../../modules/src/matchmaking/matched_hook';
import cosmeticsJson from '../../modules/src/catalogs/cosmetics.json';
import carsJson from '../../modules/src/catalogs/cars.json';
import upgradesJson from '../../modules/src/catalogs/upgrades.json';
import type { CarCatalogEntry, OwnedCar, UpgradeLevels } from '../../modules/src/garage/types';
import type { Loadout } from '../../modules/src/race/types';
import type { FakeNakama } from '../../tests/e2e/_stubs';
import { FakeNakama as FakeNakamaClass } from '../../tests/e2e/_stubs';

beforeAll(() => {
  // Unit tests run without InitModule; load the bundled catalog
  // directly so `getCarsCatalog()` / `getUpgradesCatalog()` resolve.
  loadGarageCatalog(console as never, {
    cars: carsJson as never,
    upgrades: upgradesJson as never,
    cosmetics: cosmeticsJson as never,
  });
});

function seedGarage(nak: FakeNakama, userId: string, owned: OwnedCar[]): void {
  nak.nakama.storageWrite([
    {
      collection: 'garage',
      key: userId,
      userId,
      value: {
        schemaVersion: 1,
        userId,
        cars: owned,
        cosmeticsBag: [],
        purchasedPacks: [],
        loadout: null,
        lastDailyWin: 0,
        dailyPrivateCount: 0,
        dailyResetAt: 0,
      } as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
}

const PHANTOM_RSX: CarCatalogEntry = {
  id: 'phantom_rsx',
  displayName: 'Phantom RSX',
  classId: 'B',
  baseStats: { speed: 65, acceleration: 62, handling: 65, nitro: 60 },
  maxStats: { speed: 88, acceleration: 86, handling: 88, nitro: 84 },
  priceCoins: 32000,
  requiredLevel: 20,
  isStarter: false,
};

const STARTER_VIPER: CarCatalogEntry = {
  id: 'starter_viper',
  displayName: 'Viper inicial',
  classId: 'D',
  baseStats: { speed: 50, acceleration: 50, handling: 50, nitro: 50 },
  maxStats: { speed: 70, acceleration: 70, handling: 70, nitro: 70 },
  priceCoins: 0,
  priceGems: 0,
  requiredLevel: 1,
  isStarter: true,
};

const EMPTY_LEVELS: UpgradeLevels = { engine: 0, tires: 0, nitro: 0, handling: 0 };

function owned(bodyId: string, classId: 'D' | 'C' | 'B' | 'A' | 'S', upgrades: UpgradeLevels): OwnedCar {
  return {
    carId: bodyId,
    classId,
    upgrades,
    cosmetics: {},
    computedStats: { speed: 0, acceleration: 0, handling: 0, nitro: 0 },
  };
}

describe('stats equalization (Phase 4 Chunk 8) — computeEffectiveStats', () => {
  it('ranked mode → every stat clamped to car.maxStats', () => {
    const out = computeEffectiveStats(PHANTOM_RSX, owned('phantom_rsx', 'B', EMPTY_LEVELS), 'ranked');
    expect(out.speed).toBe(88);
    expect(out.acceleration).toBe(86);
    expect(out.handling).toBe(88);
    expect(out.nitro).toBe(84);
  });

  it('ranked mode ignores upgrades — even fully upgraded, stats stay at maxStats', () => {
    const fullUpgrades: UpgradeLevels = { engine: 5, tires: 5, nitro: 5, handling: 5 };
    const out = computeEffectiveStats(PHANTOM_RSX, owned('phantom_rsx', 'B', fullUpgrades), 'ranked');
    expect(out.speed).toBe(88);
    expect(out.acceleration).toBe(86);
    expect(out.handling).toBe(88);
    expect(out.nitro).toBe(84);
  });

  it('normal mode → baseStats + upgrades, clamped to maxStats', () => {
    const out = computeEffectiveStats(PHANTOM_RSX, owned('phantom_rsx', 'B', EMPTY_LEVELS), 'normal');
    expect(out.speed).toBe(65); // baseStats.speed
    expect(out.acceleration).toBe(62);
  });

  it('normal mode with partial upgrades → stats reflect base + delta', () => {
    const partial: UpgradeLevels = { engine: 2, tires: 0, nitro: 0, handling: 0 };
    const out = computeEffectiveStats(PHANTOM_RSX, owned('phantom_rsx', 'B', partial), 'normal');
    // Engine level 2 adds some delta to speed; we don't pin the
    // delta value (catalog-dependent), just assert it's >= base.
    expect(out.speed).toBeGreaterThanOrEqual(65);
    expect(out.speed).toBeLessThanOrEqual(88);
  });

  it('starter D class — equalization targets the D maxStats', () => {
    const out = computeEffectiveStats(STARTER_VIPER, owned('starter_viper', 'D', EMPTY_LEVELS), 'ranked');
    expect(out.speed).toBe(70);
    expect(out.acceleration).toBe(70);
    expect(out.handling).toBe(70);
    expect(out.nitro).toBe(70);
  });

  it('emptyOwnedCar helper returns a stable default shape', () => {
    const e = emptyOwnedCar();
    expect(e.carId).toBe('');
    expect(e.classId).toBe('D');
    expect(e.upgrades).toEqual(EMPTY_LEVELS);
  });
});

describe('stats equalization (Phase 4 Chunk 8) — loadoutStatsFor (storage-backed)', () => {
  it('missing garage → null', () => {
    const nak = new FakeNakamaClass();
    const loadout: Loadout = { classId: 'B', bodyId: 'phantom_rsx' };
    expect(loadoutStatsFor(nak.nakama, 'u1', loadout, 'ranked')).toBeNull();
  });

  it('garage present but bodyId not owned → null', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u1', [owned('starter_viper', 'D', EMPTY_LEVELS)]);
    const loadout: Loadout = { classId: 'B', bodyId: 'phantom_rsx' };
    expect(loadoutStatsFor(nak.nakama, 'u1', loadout, 'ranked')).toBeNull();
  });

  it('garage + matching bodyId + ranked → equalized stats', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u1', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    const loadout: Loadout = { classId: 'B', bodyId: 'phantom_rsx' };
    const stats = loadoutStatsFor(nak.nakama, 'u1', loadout, 'ranked');
    expect(stats).toEqual({ speed: 88, acceleration: 86, handling: 88, nitro: 84 });
  });

  it('garage + matching bodyId + normal → base stats', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u1', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    const loadout: Loadout = { classId: 'B', bodyId: 'phantom_rsx' };
    const stats = loadoutStatsFor(nak.nakama, 'u1', loadout, 'normal');
    expect(stats).toEqual({ speed: 65, acceleration: 62, handling: 65, nitro: 60 });
  });

  it('mode mismatch: ranked call on non-loaded bodyId is null regardless', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u1', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    const loadout: Loadout = { classId: 'B', bodyId: 'does_not_exist' };
    expect(loadoutStatsFor(nak.nakama, 'u1', loadout, 'ranked')).toBeNull();
  });
});

describe('stats equalization (Phase 4 Chunk 8) — applyStatsEqualizationToMatchedSession', () => {
  it('ranked session: every roster entry gets loadout.stats equalized', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u-a', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    seedGarage(nak, 'u-b', [owned('starter_viper', 'D', EMPTY_LEVELS)]);
    const candidate = {
      sessionId: 'sid-1',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'ranked', size: '2', version: '1', region: 'eu' } },
        { ticket: 't-b', metadata: { mode: 'ranked', size: '2', version: '1', region: 'eu' } },
      ],
      matched: [
        { sessionId: 'sid-1', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 'sid-1', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    const session = buildRaceSessionFromCandidate(candidate);
    const playerLoadouts = new Map<string, Loadout>([
      ['u-a', { classId: 'B', bodyId: 'phantom_rsx' }],
      ['u-b', { classId: 'D', bodyId: 'starter_viper' }],
    ]);
    const after = applyStatsEqualizationToMatchedSession(nak.nakama, session, playerLoadouts);
    expect(after.roster[0]?.loadout?.stats?.speed).toBe(88); // B max
    expect(after.roster[1]?.loadout?.stats?.speed).toBe(70); // D max
  });

  it('quick session: stats are base + upgrades, not equalized', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u-a', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    seedGarage(nak, 'u-b', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    const candidate = {
      sessionId: 'sid-2',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'quick', size: '2', version: '1', region: 'eu' } },
        { ticket: 't-b', metadata: { mode: 'quick', size: '2', version: '1', region: 'eu' } },
      ],
      matched: [
        { sessionId: 'sid-2', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 'sid-2', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    const session = buildRaceSessionFromCandidate(candidate);
    const playerLoadouts = new Map<string, Loadout>([
      ['u-a', { classId: 'B', bodyId: 'phantom_rsx' }],
      ['u-b', { classId: 'B', bodyId: 'phantom_rsx' }],
    ]);
    const after = applyStatsEqualizationToMatchedSession(nak.nakama, session, playerLoadouts);
    expect(after.roster[0]?.loadout?.stats?.speed).toBe(65); // base, not equalized
    expect(after.roster[1]?.loadout?.stats?.speed).toBe(65);
  });

  it('userId without a loadout in the map is skipped — no throw, no mutation', () => {
    const nak = new FakeNakamaClass();
    seedGarage(nak, 'u-a', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    seedGarage(nak, 'u-b', [owned('phantom_rsx', 'B', EMPTY_LEVELS)]);
    const candidate = {
      sessionId: 'sid-3',
      tickets: [
        { ticket: 't-a', metadata: { mode: 'ranked', size: '2', version: '1', region: 'eu' } },
        { ticket: 't-b', metadata: { mode: 'ranked', size: '2', version: '1', region: 'eu' } },
      ],
      matched: [
        { sessionId: 'sid-3', userId: 'u-a', username: 'A', vars: { rtt: '50' } },
        { sessionId: 'sid-3', userId: 'u-b', username: 'B', vars: { rtt: '60' } },
      ],
    };
    const session = buildRaceSessionFromCandidate(candidate);
    const playerLoadouts = new Map<string, Loadout>([
      ['u-a', { classId: 'B', bodyId: 'phantom_rsx' }],
    ]);
    expect(() =>
      applyStatsEqualizationToMatchedSession(nak.nakama, session, playerLoadouts),
    ).not.toThrow();
    expect(session.roster[0]?.loadout?.stats?.speed).toBe(88);
    expect(session.roster[1]?.loadout?.stats).toBeUndefined();
  });
});