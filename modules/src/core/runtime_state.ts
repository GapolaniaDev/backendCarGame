// Per-VM runtime state: game-data catalogs + the race EventBus (plan card
// T-29, decision D-11; audit N8 and PC-14 / Audit 04 f5).
//
// Nakama 3.27 runs `InitModule` once, in a throwaway goja VM
// (`evalRuntimeModules`). Every pool VM that serves RPCs and hooks, and
// every match VM, only re-evaluates the top level of the bundle: whatever
// `InitModule` left in module variables does not exist there. So each VM
// loads its own state, once, on the first call it serves:
//   - RPC bindings are `export const x: RpcHandler = withRuntime(x_impl)`
//     (still a top-level `var` the registration scanner accepts);
//   - hooks are wrapped with `withRuntimeHook` in main.ts;
//   - match handlers call `ensureRuntimeState` from `matchInit`.
// `InitModule` calls the same function first, so an invalid catalog still
// aborts the boot instead of surfacing later inside an envelope.
//
// The bus subscribers close over the `nk` and `logger` of the first call.
// Both are per-VM singletons in 3.27 (the runtime hands the same module
// and logger objects to every call of a VM), so that is safe.

import type { IContext, ILogger, INakama, RpcFunction } from '../nkruntime';
import { err, toJson } from './response';
import { EventBus } from './event_bus';
import { loadCatalogs, type TracksCatalog, type ModesCatalog } from './catalog';
import { loadEventsCatalog } from './active_events';
import { RACE_EVENT_RACE_COMPLETED } from '../race/constants';
import type { RaceCompletedEvent } from '../race/types';
import { loadLeaderboardsCatalog, type RawTablesFile } from '../leaderboards/catalog';
import { loadProfilesCatalog, type RawProfilesFile } from '../profiles/catalog';
import { loadRewardsCatalog, type RawRewardsFile } from '../economy/catalog';
import { loadLevelsCatalog, type RawLevelsFile } from '../progression/catalog';
import { loadGarageCatalog, type RawGarageFiles } from '../garage/catalog';
import { getStoreCatalog, loadStoreCatalog, type RawStoreFile } from '../store/catalog';
import { loadRankedConfig, type RawRankedConfigFile } from '../ranked/config';
import { loadSeasonsCatalog, type RawSeasonsFile } from '../ranked/seasons';
import { loadLiveOpsConfig, type RawLiveOpsFile } from '../liveops/mm_config';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
  type RawMissionsFile,
  type RawAchievementsFile,
} from '../missions/catalog';
import { loadPassCatalog, type RawPassFile } from '../pass/catalog';
import { reportCatalogContent } from './content_check';
import { loadEmblemasCatalog } from '../clubs/catalog';
import type { EmblemDef } from '../clubs/types';
import { loadBlockedWordsCatalog, type RawBlockedWordsFile } from '../chat/blocked_words';
import type { RawEventsFile } from '../events/types';
import { validateTournamentsFile } from '../tournaments/types';
import { loadTournamentsCatalog } from '../tournaments/catalog';
import { validateMarkThresholdsFile } from '../anti_cheat/types';
import { loadIapPacksCatalog } from '../iap/catalog';
import { loadAdRewardsCatalog } from '../ads/catalog';
import { subscribeLeaderboardWriter } from '../leaderboards/subscriber';
import { subscribeEconomyRewards } from '../economy/subscriber';
import { subscribeProgressionRewards } from '../progression/subscriber';
import { subscribeRankedRewards } from '../ranked/subscriber';
import { subscribeMissionsProgress } from '../missions/subscriber';
import { subscribeRecentRivals } from '../social/recent_rivals';
import { subscribeClubWeek } from '../clubs/club_week_subscriber';
import { subscribeAntiCheat } from '../anti_cheat/subscriber';
import { subscribeTournaments } from '../tournaments/subscriber';
import { subscribeEvents } from '../events/subscriber';
import tracksJson from '../catalogs/tracks.json';
import modesJson from '../catalogs/modes.json';
import leaderboardsJson from '../catalogs/leaderboards.json';
import profilesJson from '../catalogs/profiles.json';
import rewardsJson from '../catalogs/rewards.json';
import levelsJson from '../catalogs/levels.json';
import carsJson from '../catalogs/cars.json';
import upgradesJson from '../catalogs/upgrades.json';
import cosmeticsJson from '../catalogs/cosmetics.json';
import storeJson from '../catalogs/store.json';
import rankedConfigJson from '../catalogs/ranked_config.json';
import seasonsJson from '../catalogs/seasons.json';
import liveopsConfigJson from '../catalogs/liveops_config.json';
import missionsDailyJson from '../catalogs/missions_daily.json';
import missionsWeeklyJson from '../catalogs/missions_weekly.json';
import achievementsJson from '../catalogs/achievements.json';
import passS1Json from '../catalogs/pass_s1.json';
import emblemasJson from '../catalogs/emblemas.json';
import blockedWordsJson from '../catalogs/blocked_words.json';
import tournamentsJson from '../catalogs/tournaments.json';
import markThresholdsJson from '../catalogs/mark_thresholds.json';
import eventsJson from '../catalogs/events.json';
import iapPacksJson from '../catalogs/iap_packs.json';
import adRewardsJson from '../catalogs/ad_rewards.json';

/** The VM's race bus; non-null once this VM's state is fully loaded. */
let vmBus: EventBus | null = null;

/** Line logged once per VM when its state is ready (the smoke reads it, R-07). */
export const RUNTIME_STATE_READY_LOG = 'runtime state ready';

/**
 * Load every catalog into this VM, in the order `InitModule` always used,
 * so a malformed catalog surfaces as the same boot error. Throws on the
 * first invalid catalog.
 */
function loadRuntimeCatalogs(logger: ILogger, nk: INakama): void {
  loadCatalogs(
    logger,
    {
      tracks: tracksJson as unknown as TracksCatalog,
      modes: modesJson as unknown as ModesCatalog,
      cars: carsJson,
      upgrades: upgradesJson,
      cosmetics: cosmeticsJson,
    },
    (s: string): string => nk.sha256Hash(s),
    nk,
  );
  loadLeaderboardsCatalog(logger, leaderboardsJson as unknown as RawTablesFile, nk);
  loadProfilesCatalog(logger, profilesJson as unknown as RawProfilesFile, nk);
  loadRewardsCatalog(logger, rewardsJson as unknown as RawRewardsFile, nk);
  loadLevelsCatalog(logger, levelsJson as unknown as RawLevelsFile, nk);
  loadGarageCatalog(
    logger,
    {
      cars: carsJson as unknown as RawGarageFiles['cars'],
      upgrades: upgradesJson as unknown as RawGarageFiles['upgrades'],
      cosmetics: cosmeticsJson as unknown as RawGarageFiles['cosmetics'],
    },
    nk,
  );
  loadStoreCatalog(logger, storeJson as unknown as RawStoreFile, nk);
  loadRankedConfig(logger, rankedConfigJson as unknown as RawRankedConfigFile, nk);
  loadSeasonsCatalog(logger, seasonsJson as unknown as RawSeasonsFile, nk);
  // Reads the storage override, so a VM picks up the current liveops copy.
  loadLiveOpsConfig(logger, liveopsConfigJson as unknown as RawLiveOpsFile, nk);
  loadMissionsDailyCatalog(logger, missionsDailyJson as unknown as RawMissionsFile, nk);
  loadMissionsWeeklyCatalog(logger, missionsWeeklyJson as unknown as RawMissionsFile, nk);
  loadAchievementsCatalog(logger, achievementsJson as unknown as RawAchievementsFile, nk);
  loadPassCatalog(logger, passS1Json as unknown as RawPassFile, nk);
  loadEmblemasCatalog(logger, emblemasJson as unknown as EmblemDef[]);
  loadBlockedWordsCatalog(logger, blockedWordsJson as unknown as RawBlockedWordsFile, nk);

  const tCat = validateTournamentsFile(tournamentsJson);
  if (!tCat.ok) {
    throw new Error(`tournaments catalog invalid: ${tCat.reason}`);
  }
  logger.info('tournaments catalog loaded: version=%d templates=%d',
    tCat.value.version, tCat.value.templates.length);
  const mtCat = validateMarkThresholdsFile(markThresholdsJson);
  if (!mtCat.ok) {
    throw new Error(`mark_thresholds catalog invalid: ${mtCat.reason}`);
  }
  logger.info('mark_thresholds catalog loaded: version=%d low=%d medium=%d high=%d cooldownDays=%d',
    mtCat.value.version,
    mtCat.value.severityThresholds.low,
    mtCat.value.severityThresholds.medium,
    mtCat.value.severityThresholds.high,
    mtCat.value.cooldownDays);

  // After the store: a special offer must name a store offer (T-12).
  loadEventsCatalog(logger, eventsJson as unknown as RawEventsFile, nk, storeOfferIds());
  loadTournamentsCatalog(logger, tournamentsJson);
  loadIapPacksCatalog(logger, iapPacksJson);
  loadAdRewardsCatalog(logger, adRewardsJson);
}

/** Offer ids of the loaded store catalog. */
function storeOfferIds(): Set<string> {
  const ids = new Set<string>();
  for (const section of getStoreCatalog().sections) {
    for (const offer of section.offers) ids.add(offer.offerId);
  }
  return ids;
}

/** Build the race bus with the default `RaceCompleted` subscribers. */
function buildRaceBus(logger: ILogger, nk: INakama): EventBus {
  const bus = new EventBus(logger);
  bus.subscribe(RACE_EVENT_RACE_COMPLETED, (payload) => {
    const e = payload as RaceCompletedEvent;
    logger.info(
      'RaceCompleted sid=%s mode=%s track=%s size=%d results=%d needsReview=%s',
      e.sessionId,
      e.mode,
      e.trackId,
      e.size,
      e.results.length,
      String(e.flags.needsReview),
    );
  });
  // Order matters: each subscriber runs after the ones it must not delay
  // (leaderboards, wallet + XP, ranked, missions, recent rivals, club
  // week, anti-cheat, then tournaments and events last).
  subscribeLeaderboardWriter(logger, bus, nk);
  subscribeEconomyRewards({ logger, nk, bus });
  subscribeProgressionRewards({ logger, nk, bus });
  subscribeRankedRewards({ logger, nk, bus });
  subscribeMissionsProgress({ logger, nk, bus });
  subscribeRecentRivals({ logger, nk, bus });
  subscribeClubWeek({ logger, nk, bus });
  subscribeAntiCheat({ logger, nk, bus });
  subscribeTournaments({ logger, nk, bus });
  subscribeEvents({ logger, nk, bus });
  return bus;
}

/**
 * Logger for a pool/match VM's load: the per-catalog lines drop to debug
 * so each VM adds one info line to the log, not twenty.
 */
function quietLogger(logger: ILogger): ILogger {
  // Explicit forwarding: the goja logger is a host object and the test
  // logger a class instance, so neither can be spread.
  return {
    debug: (format: string, ...args: unknown[]) => logger.debug(format, ...args),
    info: (format: string, ...args: unknown[]) => logger.debug(format, ...args),
    warn: (format: string, ...args: unknown[]) => logger.warn(format, ...args),
    error: (format: string, ...args: unknown[]) => logger.error(format, ...args),
    withField: (format: string, key: string, value: unknown) => logger.withField(format, key, value),
    withFields: (format: string, fields: Record<string, unknown>) => logger.withFields(format, fields),
    getFields: () => logger.getFields(),
  } as ILogger;
}

/**
 * Make sure this VM has its catalogs and race bus; returns the bus.
 * Idempotent and cheap after the first successful call. Throws when a
 * catalog fails to load (the next call retries).
 *
 * `opts.boot` (InitModule only) keeps the per-catalog info lines.
 */
export function ensureRuntimeState(
  nk: INakama,
  logger: ILogger,
  opts?: { boot?: boolean },
): EventBus {
  if (vmBus !== null) return vmBus;
  const startedMs = Date.now();
  const loadLogger = opts?.boot === true ? logger : quietLogger(logger);
  loadRuntimeCatalogs(loadLogger, nk);
  // Reward items missing from the garage catalogs: logged once, at boot
  // (plan T-19); every VM would repeat the same line.
  if (opts?.boot === true) reportCatalogContent(logger);
  const bus = buildRaceBus(logger, nk);
  vmBus = bus;
  logger.info(
    '%s: catalogs + %d RaceCompleted subscribers in %dms (%s)',
    RUNTIME_STATE_READY_LOG,
    bus.subscriberCount(RACE_EVENT_RACE_COMPLETED),
    Date.now() - startedMs,
    opts?.boot === true ? 'boot' : 'vm',
  );
  return bus;
}

/**
 * Wrap an RPC so it runs with this VM's state loaded. A load failure is
 * answered with an `INTERNAL` envelope instead of a thrown error.
 */
export function withRuntime(fn: RpcFunction): RpcFunction {
  return function (ctx: IContext, logger: ILogger, nk: INakama, payload: string): string {
    try {
      ensureRuntimeState(nk, logger);
    } catch (e) {
      logger.error('runtime state load failed: %s', e instanceof Error ? e.message : String(e));
      return toJson(err('INTERNAL', 'Server state is not available; retry shortly'));
    }
    return fn(ctx, logger, nk, payload);
  };
}

/**
 * Wrap a hook (after-auth, before-request, matchmaker matched) so it runs
 * with this VM's state loaded. A load failure propagates: Nakama logs it
 * and, for before-hooks, rejects the request.
 */
export function withRuntimeHook<A extends unknown[], R>(
  fn: (ctx: IContext, logger: ILogger, nk: INakama, ...rest: A) => R,
): (ctx: IContext, logger: ILogger, nk: INakama, ...rest: A) => R {
  return function (ctx: IContext, logger: ILogger, nk: INakama, ...rest: A): R {
    ensureRuntimeState(nk, logger);
    return fn(ctx, logger, nk, ...rest);
  };
}

/** Test helper: forget this VM's state so the next call reloads it. */
export function _resetRuntimeStateForTests(): void {
  vmBus = null;
}
