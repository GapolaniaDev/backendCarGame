// Unit tests for the Phase 3 store catalog validator.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadStoreCatalog,
  validate,
  _resetStoreForTests,
  getStoreCatalog,
} from '../../modules/src/store/catalog';
import type { ILogger, INakama } from '../../modules/src/nkruntime';
import type { RawStoreFile } from '../../modules/src/store/catalog';

const SILENT_LOGGER: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withField: () => SILENT_LOGGER,
  withFields: () => SILENT_LOGGER,
} as unknown as ILogger;

const VALID: RawStoreFile = {
  version: 1,
  sections: [
    {
      id: 'permanent',
      displayName: 'Tienda permanente',
      offers: [
        {
          offerId: 'perm_a',
          kind: 'pack',
          refId: 'starter_pack',
          displayName: 'Pack inicial',
          priceCoins: 2500,
          expiresAt: null,
        },
        {
          offerId: 'perm_b',
          kind: 'cosmetic',
          refId: 'paint_matte_black',
          displayName: 'Pintura negro mate',
          priceCoins: 1500,
          expiresAt: null,
        },
      ],
    },
    {
      id: 'daily',
      displayName: 'Oferta del día',
      offers: [
        {
          offerId: 'daily_a',
          kind: 'cosmetic',
          refId: 'paint_red_flame',
          displayName: 'Llama roja (oferta)',
          priceCoins: 250,
          expiresAt: null,
        },
      ],
    },
    {
      id: 'level_gated',
      displayName: 'Por nivel',
      offers: [
        {
          offerId: 'lg_civic_r',
          kind: 'car',
          refId: 'civic_r',
          displayName: 'Civic R',
          priceCoins: 8000,
          requiredLevel: 6,
          expiresAt: null,
        },
      ],
    },
  ],
  dailyRotationPoolSize: 3,
};

describe('store/catalog validator (Chunk 1)', () => {
  beforeEach(() => _resetStoreForTests());

  it('accepts the canonical shape', () => {
    expect(() => validate(VALID)).not.toThrow();
  });

  it('rejects unknown version', () => {
    expect(() => validate({ ...VALID, version: 2 })).toThrow(/version/);
  });

  it('rejects unknown section id', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [
          ...VALID.sections,
          { id: 'flash_sale' as 'permanent', displayName: 'X', offers: [] },
        ],
      }),
    ).toThrow(/sections\[3\]\.id/);
  });

  it('rejects duplicate section ids', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [VALID.sections[0], VALID.sections[0], VALID.sections[2]],
      }),
    ).toThrow(/duplicate section id/);
  });

  it('rejects duplicate offerIds across sections', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [
          VALID.sections[0],
          VALID.sections[1],
          {
            ...VALID.sections[2],
            offers: [{ ...VALID.sections[2].offers[0], offerId: 'perm_a' }],
          },
        ],
      }),
    ).toThrow(/duplicate offerId/);
  });

  it('rejects offer with no price', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [
          {
            ...VALID.sections[0],
            offers: [
              {
                ...VALID.sections[0].offers[0],
                priceCoins: undefined,
                priceGems: undefined,
              } as unknown as typeof VALID.sections[0]['offers'][number],
            ],
          },
          VALID.sections[1],
          VALID.sections[2],
        ],
      }),
    ).toThrow(/must declare at least priceCoins or priceGems/);
  });

  it('rejects unknown offer kind', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [
          {
            ...VALID.sections[0],
            offers: [{ ...VALID.sections[0].offers[0], kind: 'gacha' as 'pack' }],
          },
          VALID.sections[1],
          VALID.sections[2],
        ],
      }),
    ).toThrow(/kind must be one of/);
  });

  it('rejects requiredLevel outside 1..50', () => {
    expect(() =>
      validate({
        ...VALID,
        sections: [
          VALID.sections[0],
          VALID.sections[1],
          {
            ...VALID.sections[2],
            offers: [{ ...VALID.sections[2].offers[0], requiredLevel: 51 }],
          },
        ],
      }),
    ).toThrow(/requiredLevel/);
  });

  it('rejects dailyRotationPoolSize < 1', () => {
    expect(() => validate({ ...VALID, dailyRotationPoolSize: 0 })).toThrow(
      /dailyRotationPoolSize/,
    );
  });
});

describe('store/catalog loader (Chunk 1)', () => {
  beforeEach(() => _resetStoreForTests());

  it('freezes and exposes the runtime state', () => {
    const fakeNk = { localcachePut: () => {} } as unknown as INakama;
    loadStoreCatalog(SILENT_LOGGER, VALID, fakeNk);
    const c = getStoreCatalog();
    expect(c.sections.length).toBe(3);
    expect(c.dailyRotationPoolSize).toBe(3);
    expect(c.sections[0]?.id).toBe('permanent');
  });

  it('throws before load', () => {
    expect(() => getStoreCatalog()).toThrow(/not loaded/);
  });
});