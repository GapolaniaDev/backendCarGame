// Plan T-19 (HT Prog-1): reward items that name a car or cosmetic missing
// from cars.json / cosmetics.json. Since plan B (2026-10-30) there are no
// known gaps: the lists below are empty, so a NEW id that is missing from
// the garage catalogs fails this test instead of being skipped in silence.
// At runtime the boot logs any missing id once ("catalog content: …") and a
// claim returns them in `undelivered`.

import { describe, it, expect } from 'vitest';
import { unknownPassItems, type RawPassFile } from '../../modules/src/pass/catalog';
import { unknownSeasonRewardItems } from '../../modules/src/core/content_check';
import passS1 from '../../modules/src/catalogs/pass_s1.json';
import carsJson from '../../modules/src/catalogs/cars.json';
import cosmeticsJson from '../../modules/src/catalogs/cosmetics.json';
import type { PassCatalog } from '../../modules/src/pass/types';

const carIds = new Set(((carsJson as { cars: Array<{ id: string }> }).cars).map((c) => c.id));
const cosmeticIds = new Set(((cosmeticsJson as { items: Array<{ id: string }> }).items).map((c) => c.id));

/** Known gaps in pass_s1.json: none since plan B (2026-10-30). */
const KNOWN_MISSING_PASS: string[] = [];
/** Known gaps in the ranked season cosmetics: none since plan B (2026-10-30). */
const KNOWN_MISSING_SEASON: string[] = [];

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
