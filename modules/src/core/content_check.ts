// Catalog content check (plan T-19, HT Prog-1): reward items that name a
// car or cosmetic missing from the garage catalogs. They are content the
// user still has to add (or re-point), so the server neither invents nor
// drops them: the boot logs them once at error level (`CONTENT_CHECK_LOG`)
// and a claim reports them in `undelivered`. The unit test
// `tests/unit/catalog_content.test.ts` lists the exact ids.

import type { ILogger } from '../nkruntime';
import { getCarsCatalog, getCosmeticsCatalog } from '../garage/catalog';
import { getPassCatalog, unknownPassItems } from '../pass/catalog';
import { payloadForTier } from '../ranked/season';

/** Prefix of the boot error line (the live smoke reports it as KNOWN). */
export const CONTENT_CHECK_LOG = 'catalog content';

/** Ranked season reward cosmetics missing from cosmetics.json, as `cosmetic:<id>@season_<tier>`. */
export function unknownSeasonRewardItems(cosmeticIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const tier of ['gold', 'silver', 'bronze'] as const) {
    for (const id of payloadForTier(tier).payload.cosmetics) {
      if (!cosmeticIds.has(id)) out.push(`cosmetic:${id}@season_${tier}`);
    }
  }
  return out;
}

/** Every reward item of the loaded catalogs that the garage catalogs do not define. */
export function catalogContentProblems(): string[] {
  const carIds = new Set(getCarsCatalog().cars.map((c) => c.id));
  const cosmeticIds = new Set(getCosmeticsCatalog().items.map((c) => c.id));
  const pass = getPassCatalog();
  return [
    ...unknownPassItems(pass, carIds, cosmeticIds).map((x) => `pass_${pass.seasonId}:${x}`),
    ...unknownSeasonRewardItems(cosmeticIds).map((x) => `ranked:${x}`),
  ];
}

/** Log the problems once (boot): one error line naming every missing id. */
export function reportCatalogContent(logger: ILogger): void {
  const problems = catalogContentProblems();
  if (problems.length === 0) return;
  logger.error(
    '%s: %d reward item(s) missing from cars.json / cosmetics.json (claims report them as undelivered): %s',
    CONTENT_CHECK_LOG, problems.length, problems.join(', '),
  );
}
