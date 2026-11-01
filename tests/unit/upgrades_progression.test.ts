// Plan B3 (D-01, D-02): upgrade progression invariant over the real catalogs.
// For every car and every line the stat rises strictly at each level 0..5 and
// baseStats + sum(delta_1..5) never exceeds maxStats (no clamping). A new car
// with a smaller margin fails here instead of silently flattening upgrades.

import { describe, it, expect } from 'vitest';
import carsJson from '../../modules/src/catalogs/cars.json';
import upgradesJson from '../../modules/src/catalogs/upgrades.json';
import { computeStats } from '../../modules/src/garage/stats';
import { validateUpgrades } from '../../modules/src/garage/catalog';
import type {
  CarCatalogEntry,
  CarStats,
  UpgradeLevels,
  UpgradeLine,
  UpgradesCatalog,
} from '../../modules/src/garage/types';

const CARS = (carsJson as unknown as { cars: CarCatalogEntry[] }).cars;
const UPGRADES = upgradesJson as unknown as UpgradesCatalog;
const LINES: UpgradeLine[] = ['engine', 'tires', 'nitro', 'handling'];
const LINE_STAT: Record<UpgradeLine, keyof CarStats> = {
  engine: 'speed',
  tires: 'handling',
  nitro: 'nitro',
  handling: 'acceleration',
};
const MAX_LEVEL = 5;

function levelsFor(line: UpgradeLine, level: number): UpgradeLevels {
  return { engine: 0, tires: 0, nitro: 0, handling: 0, [line]: level } as UpgradeLevels;
}

function statSeries(car: CarCatalogEntry, line: UpgradeLine): number[] {
  const series: number[] = [];
  for (let level = 0; level <= MAX_LEVEL; level += 1) {
    series.push(computeStats(car, UPGRADES, levelsFor(line, level))[LINE_STAT[line]]);
  }
  return series;
}

describe('upgrades progression: strictly increasing, never clamped', () => {
  for (const car of CARS) {
    for (const line of LINES) {
      it(`${car.id} / ${line}: rises at every level and fits the margin`, () => {
        const stat = LINE_STAT[line];
        const series = statSeries(car, line);
        expect(series[0]).toBe(car.baseStats[stat]);
        for (let level = 1; level <= MAX_LEVEL; level += 1) {
          expect(series[level] as number).toBeGreaterThan(series[level - 1] as number);
        }
        const total = UPGRADES.perCarClass[car.classId][line].reduce((acc, e) => acc + (e.delta[stat] ?? 0), 0);
        expect(car.baseStats[stat] + total).toBeLessThanOrEqual(car.maxStats[stat]);
      });
    }
  }
});

describe('upgrades progression: literal expected values (level 0..5)', () => {
  const byId = (id: string): CarCatalogEntry => CARS.find((c) => c.id === id) as CarCatalogEntry;

  it('starter_viper (D) has the same series on every line', () => {
    for (const line of LINES) {
      expect(statSeries(byId('starter_viper'), line)).toEqual([50, 52, 55, 59, 64, 70]);
    }
  });

  it('other classes match the planned tables', () => {
    expect(statSeries(byId('civic_r'), 'engine')).toEqual([55, 57, 60, 64, 69, 75]);
    expect(statSeries(byId('civic_r'), 'nitro')).toEqual([48, 50, 53, 57, 62, 68]);
    expect(statSeries(byId('coupe_gt'), 'engine')).toEqual([60, 62, 65, 69, 75, 82]);
    expect(statSeries(byId('phantom_rsx'), 'engine')).toEqual([65, 67, 71, 76, 82, 88]);
    expect(statSeries(byId('aurora_aero'), 'tires')).toEqual([70, 72, 75, 80, 86, 92]);
    expect(statSeries(byId('titan_s1'), 'engine')).toEqual([80, 82, 85, 89, 94, 100]);
  });

  it('class D engine costs are unchanged', () => {
    expect(UPGRADES.perCarClass.D.engine.map((e) => e.cost)).toEqual([500, 800, 1200, 1800, 2500]);
  });
});

describe('validateUpgrades: delta shape', () => {
  function withDelta(delta: Record<string, number>): unknown {
    const copy = JSON.parse(JSON.stringify(upgradesJson)) as {
      perCarClass: { D: { engine: Array<{ delta: Record<string, number> }> } };
    };
    copy.perCarClass.D.engine[0]!.delta = delta;
    return copy;
  }

  it('accepts the real catalog', () => {
    expect(() => validateUpgrades(upgradesJson)).not.toThrow();
  });

  it('rejects a delta keyed by another stat', () => {
    expect(() => validateUpgrades(withDelta({ handling: 2 }))).toThrow(/exactly the key "speed"/);
  });

  it('rejects a delta with two keys', () => {
    expect(() => validateUpgrades(withDelta({ speed: 2, nitro: 1 }))).toThrow(/exactly the key/);
  });

  it('rejects zero, negative and non-integer deltas', () => {
    expect(() => validateUpgrades(withDelta({ speed: 0 }))).toThrow(/integer > 0/);
    expect(() => validateUpgrades(withDelta({ speed: -3 }))).toThrow(/integer > 0/);
    expect(() => validateUpgrades(withDelta({ speed: 2.5 }))).toThrow(/integer > 0/);
  });
});
