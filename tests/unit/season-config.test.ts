// Unit tests for the Phase 4 catalog loaders + helpers:
//   - seasons.json validator + findActiveSeason helper
//   - ranked_config.json validator + divisionForRating + ratingWindowFor helpers

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSeasonsCatalog,
  getSeasonsCatalog,
  findActiveSeason,
  validate as validateSeasonsFile,
  type RawSeasonsFile,
} from '../../modules/src/ranked/seasons';
import {
  loadRankedConfig,
  getRankedConfig,
  divisionForRating,
  ratingWindowFor,
  validate as validateRankedConfigFile,
  type RawRankedConfigFile,
} from '../../modules/src/ranked/config';
import { _resetSeasonsForTests } from '../../modules/src/ranked/seasons';
import { _resetRankedConfigForTests } from '../../modules/src/ranked/config';

const VALID_SEASONS: RawSeasonsFile = {
  version: 1,
  seasons: [
    {
      id: 'season_1',
      displayName: 'Season 1',
      startsAt: 1761955200000,
      endsAt: 1764547200000,
      divisions: [
        { id: 'bronce',   displayName: 'Bronce',   ratingMin: 0,    ratingMax: 999 },
        { id: 'plata',    displayName: 'Plata',    ratingMin: 1000, ratingMax: 1199 },
        { id: 'oro',      displayName: 'Oro',      ratingMin: 1200, ratingMax: 1399 },
        { id: 'platino',  displayName: 'Platino',  ratingMin: 1400, ratingMax: 1599 },
        { id: 'diamante', displayName: 'Diamante', ratingMin: 1600, ratingMax: 9999 },
      ],
    },
  ],
};

const VALID_RANKED: RawRankedConfigFile = {
  version: 1,
  kFactorNormal: 24,
  kFactorInitial: 40,
  initialRating: 1000,
  divisions: [
    { id: 'bronce',   displayName: 'Bronce',   minRating: 0,    maxRating: 999 },
    { id: 'plata',    displayName: 'Plata',    minRating: 1000, maxRating: 1199 },
    { id: 'oro',      displayName: 'Oro',      minRating: 1200, maxRating: 1399 },
    { id: 'platino',  displayName: 'Platino',  minRating: 1400, maxRating: 1599 },
    { id: 'diamante', displayName: 'Diamante', minRating: 1600, maxRating: 9999 },
  ],
  ratingWindowBySeconds: [
    { elapsedMax: 30,    window: 100 },
    { elapsedMax: 120,   window: 200 },
    { elapsedMax: 3600,  window: 400 },
    { elapsedMax: 86400, window: 400 },
  ],
  hiddenMarkThreshold: 5,
  graceSeconds: 20,
};

describe('ranked/seasons (Phase 4 Chunk 1)', () => {
  beforeEach(() => {
    _resetSeasonsForTests();
  });

  it('loadSeasonsCatalog accepts the bundled seasons.json shape', () => {
    expect(() => loadSeasonsCatalog(console as never, VALID_SEASONS)).not.toThrow();
    const cat = getSeasonsCatalog();
    expect(cat.version).toBe(1);
    expect(cat.seasons).toHaveLength(1);
    expect(cat.seasons[0]?.id).toBe('season_1');
    expect(cat.seasons[0]?.divisions).toHaveLength(5);
  });

  it('findActiveSeason returns the season whose UTC window contains nowMs', () => {
    loadSeasonsCatalog(console as never, VALID_SEASONS);
    const cat = getSeasonsCatalog();
    const inside = VALID_SEASONS.seasons[0]!.startsAt + 1000;
    const before = VALID_SEASONS.seasons[0]!.startsAt - 1000;
    const after = VALID_SEASONS.seasons[0]!.endsAt + 1000;
    expect(findActiveSeason(cat, inside)?.id).toBe('season_1');
    expect(findActiveSeason(cat, before)).toBeNull();
    expect(findActiveSeason(cat, after)).toBeNull();
  });

  it('validator rejects missing version', () => {
    expect(() => validateSeasonsFile({ ...VALID_SEASONS, version: 2 } as never)).toThrow(/version/);
  });

  it('validator rejects empty seasons array', () => {
    expect(() => validateSeasonsFile({ ...VALID_SEASONS, seasons: [] })).toThrow(/at least one/);
  });

  it('validator rejects duplicate season ids', () => {
    expect(() =>
      validateSeasonsFile({
        ...VALID_SEASONS,
        seasons: [VALID_SEASONS.seasons[0]!, { ...VALID_SEASONS.seasons[0]!, id: 'season_1' }],
      }),
    ).toThrow(/duplicate/);
  });

  it('validator rejects endsAt <= startsAt', () => {
    const bad = { ...VALID_SEASONS, seasons: [{ ...VALID_SEASONS.seasons[0]!, endsAt: VALID_SEASONS.seasons[0]!.startsAt }] };
    expect(() => validateSeasonsFile(bad)).toThrow(/endsAt/);
  });

  it('validator rejects out-of-order division rating ranges', () => {
    const bad = {
      ...VALID_SEASONS,
      seasons: [{
        ...VALID_SEASONS.seasons[0]!,
        divisions: [
          { id: 'a', displayName: 'A', ratingMin: 0,   ratingMax: 999 },
          { id: 'b', displayName: 'B', ratingMin: 800, ratingMax: 1199 },
        ],
      }],
    };
    expect(() => validateSeasonsFile(bad)).toThrow(/previous max/);
  });

  it('validator rejects empty division list', () => {
    const bad = { ...VALID_SEASONS, seasons: [{ ...VALID_SEASONS.seasons[0]!, divisions: [] }] };
    expect(() => validateSeasonsFile(bad)).toThrow(/at least one/);
  });
});

describe('ranked/config (Phase 4 Chunk 1)', () => {
  beforeEach(() => {
    _resetRankedConfigForTests();
  });

  it('loadRankedConfig accepts the bundled ranked_config.json shape', () => {
    expect(() => loadRankedConfig(console as never, VALID_RANKED)).not.toThrow();
    const cfg = getRankedConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.kFactorNormal).toBe(24);
    expect(cfg.kFactorInitial).toBe(40);
    expect(cfg.initialRating).toBe(1000);
    expect(cfg.divisions).toHaveLength(5);
    expect(cfg.ratingWindowBySeconds).toHaveLength(4);
    expect(cfg.hiddenMarkThreshold).toBe(5);
    expect(cfg.graceSeconds).toBe(20);
  });

  it('divisionForRating maps each rating band to its division id', () => {
    loadRankedConfig(console as never, VALID_RANKED);
    const cfg = getRankedConfig();
    expect(divisionForRating(cfg, 0)).toBe('bronce');
    expect(divisionForRating(cfg, 500)).toBe('bronce');
    expect(divisionForRating(cfg, 1000)).toBe('plata');
    expect(divisionForRating(cfg, 1199)).toBe('plata');
    expect(divisionForRating(cfg, 1200)).toBe('oro');
    expect(divisionForRating(cfg, 1600)).toBe('diamante');
    expect(divisionForRating(cfg, 9999)).toBe('diamante');
    // Above the highest band stays at diamante.
    expect(divisionForRating(cfg, 50000)).toBe('diamante');
    // Below the lowest band also lands at bronce.
    expect(divisionForRating(cfg, -1)).toBe('bronce');
  });

  it('ratingWindowFor picks the largest elapsedMax less than or equal to elapsedSec', () => {
    loadRankedConfig(console as never, VALID_RANKED);
    const cfg = getRankedConfig();
    expect(ratingWindowFor(cfg, 0)).toBe(100);
    expect(ratingWindowFor(cfg, 30)).toBe(100);
    expect(ratingWindowFor(cfg, 31)).toBe(200);
    expect(ratingWindowFor(cfg, 120)).toBe(200);
    expect(ratingWindowFor(cfg, 121)).toBe(400);
    expect(ratingWindowFor(cfg, 3600)).toBe(400);
    expect(ratingWindowFor(cfg, 99999)).toBe(400); // falls through to the last entry
  });

  it('validator rejects out-of-range K-factor', () => {
    expect(() => loadRankedConfig(console as never, { ...VALID_RANKED, kFactorNormal: 0 })).toThrow(/kFactorNormal/);
    expect(() => loadRankedConfig(console as never, { ...VALID_RANKED, kFactorInitial: 9999 })).toThrow(/kFactorInitial/);
  });

  it('validator rejects out-of-order division rating ranges', () => {
    expect(() =>
      validateRankedConfigFile({
        ...VALID_RANKED,
        divisions: [
          { id: 'a', displayName: 'A', minRating: 0,   maxRating: 999 },
          { id: 'b', displayName: 'B', minRating: 800, maxRating: 1199 },
        ],
      }),
    ).toThrow(/previous max/);
  });

  it('validator rejects non-monotonic elapsedMax in rating windows', () => {
    expect(() =>
      validateRankedConfigFile({
        ...VALID_RANKED,
        ratingWindowBySeconds: [
          { elapsedMax: 60, window: 100 },
          { elapsedMax: 30, window: 200 },
        ],
      }),
    ).toThrow(/elapsedMax/);
  });

  it('validator rejects graceSeconds out of [1, 300]', () => {
    expect(() => loadRankedConfig(console as never, { ...VALID_RANKED, graceSeconds: 0 })).toThrow(/graceSeconds/);
    expect(() => loadRankedConfig(console as never, { ...VALID_RANKED, graceSeconds: 600 })).toThrow(/graceSeconds/);
  });
});