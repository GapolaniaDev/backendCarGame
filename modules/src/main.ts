// Entry point loaded by Nakama via `--runtime.js_entrypoint=index.js`.
//
// Lifecycle (Phase 1):
//   InitModule(ctx, logger, nk, initializer):
//     1. Load game-data catalogs (chunk 3 wires the JSON sources).
//     2. Register the 6 RPCs (chunks 4+) + the shutdown hook.
//
// Bundle entry is esbuild — see package.json's "build" script.
//
// IMPORTANT: The Go runtime calls this function positionally as
// `initModFn(goja.Null(), ctx, jsLoggerInst, nk, init)`, so the JS
// param order is (ctx, logger, nk, initializer) — the initializer is
// the FOURTH argument, not the third.

import type { IContext, ILogger, IInitializer, INakama } from './nkruntime';
import { loadCatalogs, type TracksCatalog, type ModesCatalog } from './core/catalog';
import { EventBus } from './core/event_bus';
import { RACE_EVENT_RACE_COMPLETED } from './race/constants';
import {
  config_get,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_submit_result,
  setRaceBus,
} from './race/rpcs';
import type { RaceCompletedEvent } from './race/types';
import { loadLeaderboardsCatalog } from './leaderboards/catalog';
import { ensureLeaderboards } from './leaderboards/ensure';
import { registerLeaderboardWriteGuard } from './leaderboards/hooks';
import { subscribeLeaderboardWriter } from './leaderboards/subscriber';
import { lb_get as lb_get } from './leaderboards/lb_get';
import { loadProfilesCatalog } from './profiles/catalog';
import {
  profile_get,
  profile_update,
} from './profiles/rpcs';
import { registerProfileAutoCreate } from './profiles/after_auth';
import profilesJson from './catalogs/profiles.json';
import tracksJson from './catalogs/tracks.json';
import modesJson from './catalogs/modes.json';
import leaderboardsJson from './catalogs/leaderboards.json';
import carsJson from './catalogs/cars.json';
import upgradesJson from './catalogs/upgrades.json';
import cosmeticsJson from './catalogs/cosmetics.json';
import levelsJson from './catalogs/levels.json';
import rewardsJson from './catalogs/rewards.json';
import storeJson from './catalogs/store.json';
import { loadRewardsCatalog } from './economy/catalog';
import { loadLevelsCatalog } from './progression/catalog';
import { loadGarageCatalog } from './garage/catalog';
import { loadStoreCatalog } from './store/catalog';
import { subscribeEconomyRewards } from './economy/subscriber';
import { subscribeProgressionRewards } from './progression/subscriber';

function InitModule(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  initializer: IInitializer,
): void {
  // Embed tracks/modes into the bundle via esbuild's default JSON loader.
  loadCatalogs(
    logger,
    {
      tracks: tracksJson as unknown as TracksCatalog,
      modes: modesJson as unknown as ModesCatalog,
    },
    (s: string): string => nk.sha256Hash(s),
    nk,
  );

  // Phase 2: load the leaderboards catalog (declarative table list),
  // ensure every authoritative table exists, drop the deprecated
  // client-writable `race_score` table, and register a before-hook
  // that rejects any write missing the server token.
  loadLeaderboardsCatalog(logger, leaderboardsJson as unknown as import('./leaderboards/catalog').RawTablesFile, nk);
  ensureLeaderboards(logger, nk);
  registerLeaderboardWriteGuard(initializer);

  // Profiles catalog: blocked-words list + displayName rules.
  loadProfilesCatalog(
    logger,
    profilesJson as unknown as import('./profiles/catalog').RawProfilesFile,
    nk,
  );

  // Auto-create a default profile on every successful auth.
  registerProfileAutoCreate(initializer, nk, logger);

  // Phase 3 catalogs: rewards, levels, garage (cars/upgrades/cosmetics),
  // store. Chained after Phase 1+2 so a malformed Phase 3 catalog
  // still surfaces as CATALOG_INVALID instead of silently passing.
  loadRewardsCatalog(
    logger,
    rewardsJson as unknown as import('./economy/catalog').RawRewardsFile,
    nk,
  );
  loadLevelsCatalog(
    logger,
    levelsJson as unknown as import('./progression/catalog').RawLevelsFile,
    nk,
  );
  loadGarageCatalog(
    logger,
    {
      cars: carsJson as unknown as import('./garage/catalog').RawGarageFiles['cars'],
      upgrades: upgradesJson as unknown as import('./garage/catalog').RawGarageFiles['upgrades'],
      cosmetics: cosmeticsJson as unknown as import('./garage/catalog').RawGarageFiles['cosmetics'],
    },
    nk,
  );
  loadStoreCatalog(
    logger,
    storeJson as unknown as import('./store/catalog').RawStoreFile,
    nk,
  );

  // Wire the in-process event bus and install the default subscribers
  // for `RaceCompleted`. Phase 2:
  //   1. logger (always): one-line trace of every closed session
  //   2. leaderboards: writes times/best-lap/wins for every human
  //      finisher, with the confidence gate (Chunk 12)
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
  subscribeLeaderboardWriter(logger, bus, nk);
  // Phase 3: wallet + XP rewards for every closed race.
  subscribeEconomyRewards({ logger, nk, bus });
  subscribeProgressionRewards({ logger, nk, bus });
  setRaceBus(bus);

  // Register the 6 RPCs as individual top-level statements.
  //
  // Nakama's goja runtime uses an AST scanner to extract the RPC
  // function names at boot. The scanner walks top-level
  // ExpressionStatements and TryStatement bodies — it does NOT recurse
  // into ForStatement, IfStatement, BlockStatement, etc. So we cannot
  // use a loop here; the calls must be inlined. Each call also uses
  // the bare identifier `config_get` (not a member expression) because
  // the scanner returns the first arg as a string and `checkFnScope`
  // then verifies that `globalThis[arg]` is a function.
  try {
    initializer.registerRpc('config_get', config_get);
    initializer.registerRpc('race_session_create', race_session_create);
    initializer.registerRpc('race_session_join', race_session_join);
    initializer.registerRpc('race_session_start', race_session_start);
    initializer.registerRpc('race_session_get', race_session_get);
    initializer.registerRpc('race_submit_result', race_submit_result);
    initializer.registerRpc('lb_get', lb_get);
    initializer.registerRpc('profile_get', profile_get);
    initializer.registerRpc('profile_update', profile_update);
  } catch (e) {
    logger.error('rpc registration failed: %s', e instanceof Error ? e.message : String(e));
  }

  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};