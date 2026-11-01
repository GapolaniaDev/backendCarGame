// T-01 (plan backend-metagame): car catalog served by config_get, hash coverage and localization keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { locKey } from '../../modules/src/core/loc_keys';
import { toCatalogCarViews } from '../../modules/src/garage/catalog';
import type { CarCatalogEntry } from '../../modules/src/garage/types';
import {
  loadCatalogs,
  getCatalogsHash,
  _resetCatalogsForTests,
  type TracksCatalog,
  type ModesCatalog,
} from '../../modules/src/core/catalog';
import type { ILogger } from '../../modules/src/nkruntime';
import carsJson from '../../modules/src/catalogs/cars.json';
import tracksJson from '../../modules/src/catalogs/tracks.json';
import modesJson from '../../modules/src/catalogs/modes.json';

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogger;

const CARS = (carsJson as unknown as { cars: CarCatalogEntry[] }).cars;
const TRACKS = tracksJson as unknown as TracksCatalog;
const MODES = modesJson as unknown as ModesCatalog;

describe('locKey', () => {
  it('joins kind, id and field', () => {
    expect(locKey('car', 'civic_r', 'name')).toBe('car.civic_r.name');
  });
});

describe('toCatalogCarViews', () => {
  const views = toCatalogCarViews(CARS);

  it('projects every catalog car in catalog order', () => {
    expect(views.map((v) => v.id)).toEqual([
      'starter_viper',
      'civic_r',
      'coupe_gt',
      'phantom_rsx',
      'aurora_aero',
      'titan_s1',
    ]);
  });

  it('keeps the wire property order', () => {
    for (const v of views) {
      expect(Object.keys(v)).toEqual([
        'id',
        'displayName',
        'classId',
        'baseStats',
        'maxStats',
        'priceCoins',
        'priceGems',
        'requiredLevel',
        'isStarter',
        'displayNameKey',
      ]);
    }
  });

  it('defaults a missing priceGems to 0 and flags only the starter', () => {
    expect(views.find((v) => v.id === 'civic_r')?.priceGems).toBe(0);
    expect(views.filter((v) => v.isStarter).map((v) => v.id)).toEqual(['starter_viper']);
  });

  it('derives the localization key of the display name', () => {
    expect(views.find((v) => v.id === 'civic_r')?.displayNameKey).toBe('car.civic_r.name');
  });

  it('copies the stats instead of sharing them', () => {
    expect(views[0].baseStats).not.toBe(CARS[0].baseStats);
    expect(views[0].baseStats).toEqual(CARS[0].baseStats);
  });
});

describe('loadCatalogs hash coverage', () => {
  beforeEach(() => _resetCatalogsForTests());

  it('covers cars when they are given', () => {
    loadCatalogs(SILENT_LOGGER, { tracks: TRACKS, modes: MODES, cars: carsJson }, (s) => s);
    expect(getCatalogsHash()).toContain('"cars":');
  });

  it('covers upgrades and cosmetics after cars when they are given', () => {
    loadCatalogs(
      SILENT_LOGGER,
      { tracks: TRACKS, modes: MODES, cars: carsJson, upgrades: { u: 1 }, cosmetics: { c: 1 } },
      (s) => s,
    );
    expect(getCatalogsHash()).toBe(
      JSON.stringify({ tracks: TRACKS, modes: MODES, cars: carsJson, upgrades: { u: 1 }, cosmetics: { c: 1 } }),
    );
  });

  it('covers tracks and modes only when cars are absent', () => {
    loadCatalogs(SILENT_LOGGER, { tracks: TRACKS, modes: MODES }, (s) => s);
    expect(getCatalogsHash()).toBe(JSON.stringify({ tracks: TRACKS, modes: MODES }));
  });
});