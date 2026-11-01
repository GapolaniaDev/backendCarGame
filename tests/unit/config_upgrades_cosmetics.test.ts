// T-04 (plan store-garage): upgrades and cosmetics catalogs as config_get serves them (C-01, C-02).

import { describe, it, expect } from 'vitest';
import { toCatalogCosmeticViews, toUpgradesView } from '../../modules/src/garage/catalog';
import type { CosmeticCatalogEntry, UpgradesCatalog } from '../../modules/src/garage/types';
import upgradesJson from '../../modules/src/catalogs/upgrades.json';
import cosmeticsJson from '../../modules/src/catalogs/cosmetics.json';

const UPGRADES = upgradesJson as unknown as UpgradesCatalog;
const COSMETICS = (cosmeticsJson as unknown as { items: CosmeticCatalogEntry[] }).items;

describe('toUpgradesView', () => {
  const view = toUpgradesView(UPGRADES);

  it('serves the max level and the lines with their stat', () => {
    expect(view.maxLevel).toBe(5);
    expect(view.lines).toEqual([
      { line: 'engine', stat: 'speed' },
      { line: 'tires', stat: 'handling' },
      { line: 'nitro', stat: 'nitro' },
      { line: 'handling', stat: 'acceleration' },
    ]);
  });

  it('keeps the wire property order', () => {
    expect(Object.keys(view)).toEqual(['maxLevel', 'lines', 'perCarClass']);
    expect(Object.keys(view.perCarClass)).toEqual(['D', 'C', 'B', 'A', 'S']);
    expect(Object.keys(view.perCarClass.D)).toEqual(['engine', 'tires', 'nitro', 'handling']);
    expect(Object.keys(view.perCarClass.D.engine[0])).toEqual(['level', 'cost', 'delta']);
  });

  it('projects cost and the per-level delta of the line stat', () => {
    expect(view.perCarClass.D.engine).toEqual([
      { level: 1, cost: 500, delta: 2 },
      { level: 2, cost: 800, delta: 3 },
      { level: 3, cost: 1200, delta: 4 },
      { level: 4, cost: 1800, delta: 5 },
      { level: 5, cost: 2500, delta: 6 },
    ]);
  });

  it('has one row per level for every class and line', () => {
    for (const byLine of Object.values(view.perCarClass)) {
      for (const rows of Object.values(byLine)) {
        expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5]);
      }
    }
  });
});

describe('toCatalogCosmeticViews', () => {
  const views = toCatalogCosmeticViews(COSMETICS);

  it('projects every cosmetic in catalog order', () => {
    expect(views).toHaveLength(51);
    expect(views.map((v) => v.id)).toEqual(COSMETICS.map((c) => c.id));
  });

  it('keeps the wire property order', () => {
    for (const v of views) {
      expect(Object.keys(v)).toEqual([
        'id',
        'displayName',
        'displayNameKey',
        'type',
        'rarity',
        'compatibleClasses',
        'priceCoins',
        'priceGems',
      ]);
    }
  });

  it('derives the localization key and defaults missing prices to 0', () => {
    for (const v of views) expect(v.displayNameKey).toBe('cosmetic.' + v.id + '.name');
    COSMETICS.forEach((c, i) => {
      expect(views[i].priceCoins).toBe(c.priceCoins ?? 0);
      expect(views[i].priceGems).toBe(c.priceGems ?? 0);
    });
    expect(COSMETICS.some((c) => c.priceCoins === undefined || c.priceGems === undefined)).toBe(true);
  });

  it('copies the compatible classes instead of sharing them', () => {
    expect(views[0].compatibleClasses).not.toBe(COSMETICS[0].compatibleClasses);
    expect(views[0].compatibleClasses).toEqual(COSMETICS[0].compatibleClasses);
  });
});
