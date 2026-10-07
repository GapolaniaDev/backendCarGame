// Unit tests for the catalog loader + validators.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadCatalogs,
  validateTracks,
  validateModes,
  getTrack,
  getMode,
  getTracks,
  getModes,
  getCatalogsHash,
  catalogErrorResponse,
  _resetCatalogsForTests,
  type TracksCatalog,
  type ModesCatalog,
} from '../../modules/src/core/catalog';
import type { ILogger } from '../../modules/src/nkruntime';

function makeLogger(): { logger: ILogger; lines: string[] } {
  const lines: string[] = [];
  const sub = (format: string, args: unknown[]): string => {
    let i = 0;
    return format.replace(/%[sd]/g, () => String(args[i++] ?? ''));
  };
  const logger = {
    debug: () => {},
    info: (f: string, ...a: unknown[]) => {
      lines.push(sub(f, a));
    },
    warn: () => {},
    error: () => {},
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  } as unknown as ILogger;
  return { logger, lines };
}

const VALID_TRACKS: TracksCatalog = {
  version: 1,
  tracks: [
    {
      id: 't1',
      displayName: 'Track 1',
      modes: { quick: 3, ranked: 5, private: 3, time_trial: 1 },
      checkpoints: 8,
      minTimeMsByClass: { D: 48000, C: 44000, B: 40000, A: 36000, S: 32000 },
      minSectionTimeMs: 2200,
    },
  ],
};

const VALID_MODES: ModesCatalog = {
  version: 1,
  modes: [
    {
      id: 'quick',
      displayName: 'Quick',
      allowedSizes: [2, 4, 6],
      scoreMultiplier: 1.0,
      usesRating: false,
    },
  ],
};

describe('catalog validators', () => {
  beforeEach(() => _resetCatalogsForTests());

  it('accepts a valid tracks catalog', () => {
    expect(() => validateTracks(VALID_TRACKS)).not.toThrow();
  });

  it('rejects tracks catalog with wrong version', () => {
    expect(() => validateTracks({ ...VALID_TRACKS, version: 2 })).toThrow(
      /version must be 1/,
    );
  });

  it('rejects empty tracks array', () => {
    expect(() => validateTracks({ version: 1, tracks: [] })).toThrow(
      /non-empty array/,
    );
  });

  it('rejects tracks array that is not actually an array', () => {
    expect(() => validateTracks({ version: 1, tracks: 'nope' })).toThrow(
      /not an object|tracks must/,
    );
  });

  it('rejects duplicate track ids', () => {
    expect(() =>
      validateTracks({
        version: 1,
        tracks: [
          VALID_TRACKS.tracks[0],
          { ...VALID_TRACKS.tracks[0] },
        ],
      }),
    ).toThrow(/duplicate track id/);
  });

  it('rejects out-of-range mode lap count', () => {
    const bad = {
      ...VALID_TRACKS,
      tracks: [
        {
          ...VALID_TRACKS.tracks[0],
          modes: { quick: 0, ranked: 5, private: 3, time_trial: 1 },
        },
      ],
    };
    expect(() => validateTracks(bad)).toThrow(/modes\.quick/);
  });

  it('rejects sub-1s minTime values', () => {
    const bad = {
      ...VALID_TRACKS,
      tracks: [
        {
          ...VALID_TRACKS.tracks[0],
          minTimeMsByClass: { D: 500, C: 44000, B: 40000, A: 36000, S: 32000 },
        },
      ],
    };
    expect(() => validateTracks(bad)).toThrow(/minTimeMsByClass\.D/);
  });

  it('accepts a valid modes catalog', () => {
    expect(() => validateModes(VALID_MODES)).not.toThrow();
  });

  it('rejects unknown mode id', () => {
    const bad: unknown = {
      version: 1,
      modes: [
        {
          id: 'garage',
          displayName: 'Garage',
          allowedSizes: [2],
          scoreMultiplier: 1.0,
          usesRating: false,
        },
      ],
    };
    expect(() => validateModes(bad)).toThrow(/id must be one of/);
  });

  it('rejects invalid allowedSizes value', () => {
    const bad: unknown = {
      version: 1,
      modes: [
        {
          id: 'quick',
          displayName: 'Quick',
          allowedSizes: [3],
          scoreMultiplier: 1.0,
          usesRating: false,
        },
      ],
    };
    expect(() => validateModes(bad)).toThrow(/allowedSizes/);
  });

  it('rejects negative scoreMultiplier', () => {
    const bad: unknown = {
      version: 1,
      modes: [
        {
          id: 'quick',
          displayName: 'Quick',
          allowedSizes: [2],
          scoreMultiplier: -1,
          usesRating: false,
        },
      ],
    };
    expect(() => validateModes(bad)).toThrow(/scoreMultiplier/);
  });

  it('rejects missing usesRating flag', () => {
    const bad: unknown = {
      version: 1,
      modes: [
        {
          id: 'quick',
          displayName: 'Quick',
          allowedSizes: [2],
          scoreMultiplier: 1.0,
        },
      ],
    };
    expect(() => validateModes(bad)).toThrow(/usesRating/);
  });
});

describe('loadCatalogs', () => {
  beforeEach(() => _resetCatalogsForTests());

  it('populates lookups and reports the hash', () => {
    const { logger, lines } = makeLogger();
    loadCatalogs(
      logger,
      { tracks: VALID_TRACKS, modes: VALID_MODES },
      () => 'fixedhash123',
    );
    expect(getTracks()).toHaveLength(1);
    expect(getModes()).toHaveLength(1);
    expect(getTrack('t1')?.id).toBe('t1');
    expect(getMode('quick')?.id).toBe('quick');
    expect(getCatalogsHash()).toBe('fixedhash123');
    expect(lines.some((l) => /catalogs loaded: tracks=1 modes=1/.test(l))).toBe(true);
  });

  it('freezes catalog entries (mutation throws in strict mode)', () => {
    const { logger } = makeLogger();
    loadCatalogs(
      logger,
      { tracks: VALID_TRACKS, modes: VALID_MODES },
      () => 'h',
    );
    const track = getTrack('t1');
    expect(track).toBeDefined();
    expect(() => {
      (track as { displayName: string }).displayName = 'hacked';
    }).toThrow();
  });

  it('throws and never replaces catalog when validation fails', () => {
    const { logger } = makeLogger();
    expect(() =>
      loadCatalogs(
        logger,
        {
          tracks: { version: 99, tracks: [] },
          modes: VALID_MODES,
        },
        () => 'h',
      ),
    ).toThrow(/catalogs\.tracks/);
    // State must remain null (catalogs must not be half-loaded).
    expect(() => getTracks()).toThrow(/catalogs not loaded/);
  });

  it('catalogErrorResponse wraps the error message with CATALOG_INVALID code', () => {
    const resp = catalogErrorResponse(new Error('bad json'));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('CATALOG_INVALID');
    expect(resp.error.message).toBe('bad json');
  });
});