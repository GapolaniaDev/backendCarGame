// Phase 4 Chunk 5 unit tests for the division helpers in
// `modules/src/ranked/division.ts`. The helpers reuse
// `divisionForRating` from `ranked/config.ts` (Chunk 1) and add
// `divisionAtBoundary`, `promotionBoundary`, `topDivision`,
// `isInDivision`, and a throwing variant `divisionForRatingStrict`.
//
// Tests:
//   - rating bands (boundaries inclusive)
//   - underflow (rating < lowest band) → lowest band
//   - overflow (rating > highest band) → highest band
//   - empty divisions → throw (strict variant)
//   - single division → all ratings map to that one
//   - `divisionAtBoundary` semantics
//   - `promotionBoundary` errors on top division + unknown id
//   - re-export sanity (division.ts divisionForRating matches config.ts)

import { describe, it, expect } from 'vitest';
import {
  divisionForRating,
  divisionForRatingStrict,
  divisionAtBoundary,
  promotionBoundary,
  topDivision,
  isInDivision,
} from '../../modules/src/ranked/division';
import { divisionForRating as configDivisionForRating } from '../../modules/src/ranked/config';
import type { RankedConfig } from '../../modules/src/ranked/config';

const FIVE_DIVISIONS: RankedConfig = {
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

const SINGLE_DIVISION: RankedConfig = {
  ...FIVE_DIVISIONS,
  divisions: [{ id: 'unica', displayName: 'Única', minRating: 0, maxRating: 9999 }],
};

const EMPTY_DIVISIONS: RankedConfig = {
  ...FIVE_DIVISIONS,
  divisions: [],
};

describe('division (Phase 4 Chunk 5) — divisionForRating() re-export', () => {
  it('matches the Chunk 1 helper byte-for-byte', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1500)).toBe(configDivisionForRating(FIVE_DIVISIONS, 1500));
    expect(divisionForRating(FIVE_DIVISIONS, -100)).toBe(configDivisionForRating(FIVE_DIVISIONS, -100));
    expect(divisionForRating(FIVE_DIVISIONS, 100_000)).toBe(configDivisionForRating(FIVE_DIVISIONS, 100_000));
  });

  it('rating=0 → bronce', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 0)).toBe('bronce');
  });

  it('rating=500 → bronce (mid-band)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 500)).toBe('bronce');
  });

  it('rating=999 → bronce (upper boundary, inclusive)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 999)).toBe('bronce');
  });

  it('rating=1000 → plata (lower boundary, inclusive)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1000)).toBe('plata');
  });

  it('rating=1199 → plata (upper boundary, inclusive)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1199)).toBe('plata');
  });

  it('rating=1200 → oro (boundary)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1200)).toBe('oro');
  });

  it('rating=1300 → oro (mid-band)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1300)).toBe('oro');
  });

  it('rating=1900 → diamante (mid-band)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 1900)).toBe('diamante');
  });

  it('rating=10000 → diamante (overflow)', () => {
    expect(divisionForRating(FIVE_DIVISIONS, 10_000)).toBe('diamante');
  });

  it('single division → all ratings map to that one', () => {
    expect(divisionForRating(SINGLE_DIVISION, 0)).toBe('unica');
    expect(divisionForRating(SINGLE_DIVISION, 1000)).toBe('unica');
    expect(divisionForRating(SINGLE_DIVISION, 99_999)).toBe('unica');
    expect(divisionForRating(SINGLE_DIVISION, -100)).toBe('unica');
  });
});

describe('division (Phase 4 Chunk 5) — divisionForRatingStrict()', () => {
  it('throws on empty divisions', () => {
    expect(() => divisionForRatingStrict(EMPTY_DIVISIONS, 1000)).toThrow(/no divisions/);
  });

  it('delegates to the non-strict helper for valid configs', () => {
    expect(divisionForRatingStrict(FIVE_DIVISIONS, 1300)).toBe('oro');
  });
});

describe('division (Phase 4 Chunk 5) — divisionAtBoundary()', () => {
  it('true at the upper boundary (rating === max of the band)', () => {
    // bronce max is 999 → 999 is at the boundary.
    expect(divisionAtBoundary(FIVE_DIVISIONS, 999, 'bronce')).toBe(true);
    // plata max is 1199 → 1199 is at the boundary.
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1199, 'plata')).toBe(true);
  });

  it('false below the upper boundary (more wins needed)', () => {
    expect(divisionAtBoundary(FIVE_DIVISIONS, 998, 'bronce')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1100, 'plata')).toBe(false);
  });

  it('false above the upper boundary (not in that band at all)', () => {
    // 1100 is NOT in bronce, so it's not "at bronce's boundary".
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1100, 'bronce')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 2000, 'plata')).toBe(false);
  });

  it('false for the top division (no promotion possible)', () => {
    expect(divisionAtBoundary(FIVE_DIVISIONS, 9999, 'diamante')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 999_999, 'diamante')).toBe(false);
  });

  it('false for an unknown division id', () => {
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1000, 'mythic')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 9999, 'mythic')).toBe(false);
  });

  it('false for non-boundary values in each mid-band', () => {
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1200, 'oro')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1300, 'oro')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1400, 'platino')).toBe(false);
    expect(divisionAtBoundary(FIVE_DIVISIONS, 1500, 'platino')).toBe(false);
  });
});

describe('division (Phase 4 Chunk 5) — promotionBoundary()', () => {
  it('returns the upper edge of the named division', () => {
    expect(promotionBoundary(FIVE_DIVISIONS, 'bronce')).toBe(999);
    expect(promotionBoundary(FIVE_DIVISIONS, 'plata')).toBe(1199);
    expect(promotionBoundary(FIVE_DIVISIONS, 'oro')).toBe(1399);
    expect(promotionBoundary(FIVE_DIVISIONS, 'platino')).toBe(1599);
  });

  it('throws for the top division (no promotion possible)', () => {
    expect(() => promotionBoundary(FIVE_DIVISIONS, 'diamante')).toThrow(/top division/);
  });

  it('throws for an unknown division id', () => {
    expect(() => promotionBoundary(FIVE_DIVISIONS, 'mythic')).toThrow(/unknown division/);
  });
});

describe('division (Phase 4 Chunk 5) — topDivision()', () => {
  it('returns the id of the last entry in config.divisions', () => {
    expect(topDivision(FIVE_DIVISIONS)).toBe('diamante');
    expect(topDivision(SINGLE_DIVISION)).toBe('unica');
  });

  it('throws on empty divisions', () => {
    expect(() => topDivision(EMPTY_DIVISIONS)).toThrow(/no divisions/);
  });
});

describe('division (Phase 4 Chunk 5) — isInDivision()', () => {
  it('true when rating is inside the band', () => {
    expect(isInDivision(FIVE_DIVISIONS, 500, 'bronce')).toBe(true);
    expect(isInDivision(FIVE_DIVISIONS, 1100, 'plata')).toBe(true);
    expect(isInDivision(FIVE_DIVISIONS, 1500, 'platino')).toBe(true);
    expect(isInDivision(FIVE_DIVISIONS, 1300, 'oro')).toBe(true);
  });

  it('true at the boundaries (inclusive)', () => {
    expect(isInDivision(FIVE_DIVISIONS, 0, 'bronce')).toBe(true);
    expect(isInDivision(FIVE_DIVISIONS, 999, 'bronce')).toBe(true);
    expect(isInDivision(FIVE_DIVISIONS, 1000, 'plata')).toBe(true);
  });

  it('false when rating is outside the band', () => {
    expect(isInDivision(FIVE_DIVISIONS, 1100, 'bronce')).toBe(false);
    expect(isInDivision(FIVE_DIVISIONS, 999, 'plata')).toBe(false);
  });

  it('false for an unknown division id', () => {
    expect(isInDivision(FIVE_DIVISIONS, 1000, 'mythic')).toBe(false);
  });
});