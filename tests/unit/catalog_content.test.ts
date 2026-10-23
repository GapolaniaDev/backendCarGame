// Plan T-19 (HT Prog-1): reward items that name a car or cosmetic missing
// from cars.json / cosmetics.json. They are a content decision for the
// user (add the items or re-point the rewards), so they are listed here
// exactly instead of failing the build or being skipped in silence:
//   - the list below is the known gap (Registry row of F5 in the plan);
//   - a NEW missing id fails this test, and so does fixing one (then
//     remove it from the list).
// At runtime the boot logs them once ("catalog content: …") and a claim
// returns them in `undelivered`.

import { describe, it, expect } from 'vitest';
import { unknownPassItems, type RawPassFile } from '../../modules/src/pass/catalog';
import { unknownSeasonRewardItems } from '../../modules/src/core/content_check';
import passS1 from '../../modules/src/catalogs/pass_s1.json';
import carsJson from '../../modules/src/catalogs/cars.json';
import cosmeticsJson from '../../modules/src/catalogs/cosmetics.json';
import type { PassCatalog } from '../../modules/src/pass/types';

const carIds = new Set(((carsJson as { cars: Array<{ id: string }> }).cars).map((c) => c.id));
const cosmeticIds = new Set(((cosmeticsJson as { items: Array<{ id: string }> }).items).map((c) => c.id));

/** Known gap on 2026-10-22: every cosmetic and car of pass_s1.json, and two ranked season cosmetics. */
const KNOWN_MISSING_PASS = [
  'cosmetic:paint_winter01@2/premium',
  'cosmetic:decal_frost@4/premium',
  'cosmetic:trail_arctic@6/free',
  'cosmetic:decal_icicle@8/premium',
  'cosmetic:paint_polar@10/free',
  'cosmetic:trail_blizzard@12/premium',
  'cosmetic:decal_snowflake@15/free',
  'cosmetic:paint_glacial@15/premium',
  'cosmetic:trail_frostwave@18/premium',
  'cosmetic:decal_holiday@20/free',
  'cosmetic:paint_aurora@22/premium',
  'cosmetic:trail_aurora@25/free',
  'cosmetic:decal_aurora@25/premium',
  'cosmetic:paint_aurora02@28/premium',
  'cosmetic:trail_celestial@30/free',
  'cosmetic:decal_celestial@32/premium',
  'cosmetic:paint_celestial@35/free',
  'cosmetic:trail_celestial02@35/premium',
  'cosmetic:decal_celestial02@38/premium',
  'car:titan_s1_x@40/free',
  'car:aurora_aero_x@40/premium',
];
const KNOWN_MISSING_SEASON = [
  'cosmetic:legendary_aether_chassis@season_gold',
  'cosmetic:rare_aether_stripe@season_silver',
];

describe('catalog content: reward items missing from the garage catalogs', () => {
  it('pass_s1.json: exactly the known missing ids', () => {
    const missing = unknownPassItems(passS1 as unknown as PassCatalog, carIds, cosmeticIds);
    expect(missing).toEqual(KNOWN_MISSING_PASS);
  });

  it('ranked season rewards: exactly the known missing ids', () => {
    expect(unknownSeasonRewardItems(cosmeticIds)).toEqual(KNOWN_MISSING_SEASON);
  });

  it('detects an unknown car and cosmetic, and passes known ones', () => {
    const someCar = [...carIds][0] as string;
    const someCosmetic = [...cosmeticIds][0] as string;
    const raw: RawPassFile = {
      version: 1, seasonId: 't', startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-02-01T00:00:00Z',
      maxLevel: 2, premiumPriceGems: 1,
      levels: [
        { level: 1, xpRequired: 0, freeReward: { carId: someCar }, premiumReward: { cosmeticId: someCosmetic } },
        { level: 2, xpRequired: 10, freeReward: { carId: 'no_car' }, premiumReward: { cosmeticId: 'no_paint' } },
      ],
    };
    expect(unknownPassItems(raw as unknown as PassCatalog, carIds, cosmeticIds))
      .toEqual(['car:no_car@2/free', 'cosmetic:no_paint@2/premium']);
  });
});
