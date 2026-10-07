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
  race_host_claim,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_session_quick_bots,
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
import rankedConfigJson from './catalogs/ranked_config.json';
import seasonsJson from './catalogs/seasons.json';
import liveopsConfigJson from './catalogs/liveops_config.json';
import missionsDailyJson from './catalogs/missions_daily.json';
import missionsWeeklyJson from './catalogs/missions_weekly.json';
import achievementsJson from './catalogs/achievements.json';
import passS1Json from './catalogs/pass_s1.json';
import emblemasJson from './catalogs/emblemas.json';
import { loadRewardsCatalog } from './economy/catalog';
import { loadLevelsCatalog } from './progression/catalog';
import { loadGarageCatalog } from './garage/catalog';
import { garage_get, car_buy, car_upgrade, cosmetic_equip, loadout_set } from './garage/rpcs';
import { registerGarageAutoCreate } from './garage/after_auth';
import { loadStoreCatalog } from './store/catalog';
import { loadRankedConfig } from './ranked/config';
import { loadSeasonsCatalog } from './ranked/seasons';
import { loadLiveOpsConfig } from './liveops/mm_config';
import { bootEnsure as bootEnsureLiveops } from './liveops/config';
import {
  loadMissionsDailyCatalog,
  loadMissionsWeeklyCatalog,
  loadAchievementsCatalog,
} from './missions/catalog';
import { loadPassCatalog } from './pass/catalog';
import { liveops_config_get, inbox_list, inbox_claim } from './liveops/rpcs';
import { missions_get, mission_claim, mission_reroll } from './missions/rpcs';
import { subscribeMissionsProgress } from './missions/subscriber';
import {
  friend_code_get,
  friend_add_by_code,
  friend_list_get,
  friend_remove,
  recent_rivals_get,
} from './social/rpcs';
import { subscribeRecentRivals } from './social/recent_rivals';
import { invite_send, invite_list, invite_respond } from './social/invites';
import { block_add, block_remove, block_list } from './social/blocks';
import { club_create, club_get, club_search } from './clubs/rpcs';
import {
  club_update,
  club_members_list,
  club_kick,
  club_promote,
  club_demote,
  club_leave,
} from './clubs/rpcs';
import { loadEmblemasCatalog } from './clubs/catalog';
import {
  achievements_get,
  achievement_claim,
} from './missions/achievements_rpcs';
import { account_link, account_link_resolve_conflict, account_delete } from './account/rpcs';
import {
  admin_wallet_adjust,
  admin_send_inbox,
  admin_sanitize_session,
  admin_remove_player,
  admin_cleanup_race_sessions,
} from './admin/rpcs';
import {
  pass_get,
  pass_claim,
  pass_buy_premium,
  admin_grant_premium,
} from './pass/rpcs';
import { ranked_get } from './ranked/rpcs';
import { mm_ticket_params, matchmakerMatchedImpl } from './matchmaking/rpcs';
import { store_get, store_buy } from './store/rpcs';
import { subscribeEconomyRewards } from './economy/subscriber';
import { subscribeProgressionRewards } from './progression/subscriber';
import { subscribeRankedRewards } from './ranked/subscriber';
import { wallet_get } from './economy/rpcs';
import { relay_token } from './region/rpcs';
import { beforeAuthenticateDeviceRelay } from './region/before_auth';
import { isHome } from './core/region';

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

  // Phase 4: register the matchmaker matched-hook. The hook validates
  // candidate groups (mode/version/region aligned, size in {2,4,6})
  // and accepts the first qualifying candidate; rejection tells the
  // matchmaker to keep tickets queued. The full RaceSession creation
  // is in Chunk 4 (reconnection + host_claim).
  initializer.registerMatchmakerMatched(matchmakerMatchedImpl);

  // Profiles catalog: blocked-words list + displayName rules.
  loadProfilesCatalog(
    logger,
    profilesJson as unknown as import('./profiles/catalog').RawProfilesFile,
    nk,
  );

  // Auto-create a default profile on every successful auth.
  registerProfileAutoCreate(initializer, nk, logger);
  // Phase 3: auto-create the starter-car garage on first auth.
  registerGarageAutoCreate(initializer, nk, logger);

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

  // Phase 4 catalogs: ranked config (K-factor, divisions, rating
  // windows, grace) and seasons (UTC dates + division cutoffs).
  // Chained after Phase 3 so a malformed Phase 4 catalog surfaces as
  // CATALOG_INVALID instead of silently passing.
  loadRankedConfig(
    logger,
    rankedConfigJson as unknown as import('./ranked/config').RawRankedConfigFile,
    nk,
  );
  loadSeasonsCatalog(
    logger,
    seasonsJson as unknown as import('./ranked/seasons').RawSeasonsFile,
    nk,
  );

  // Phase 4 Chunk 9: liveops config — D8 segmentBy default, D6 abandon
  // block threshold + minutes. Loaded last so a malformed liveops
  // override surfaces with the same CATALOG_INVALID diagnostic as the
  // other Phase 4 catalogs.
  loadLiveOpsConfig(
    logger,
    liveopsConfigJson as unknown as import('./liveops/mm_config').RawLiveOpsFile,
    nk,
  );

  // Phase 6 Chunk 1: daily/weekly missions + achievements + battle pass
  // catalogs. Loaded after Phase 4 so a malformed Phase 6 catalog
  // surfaces as CATALOG_INVALID alongside the other catalogs. The
  // RaceCompleted subscriber + RPCs land in later chunks.
  loadMissionsDailyCatalog(
    logger,
    missionsDailyJson as unknown as import('./missions/catalog').RawMissionsFile,
    nk,
  );
  loadMissionsWeeklyCatalog(
    logger,
    missionsWeeklyJson as unknown as import('./missions/catalog').RawMissionsFile,
    nk,
  );
  loadAchievementsCatalog(
    logger,
    achievementsJson as unknown as import('./missions/catalog').RawAchievementsFile,
    nk,
  );
  loadPassCatalog(
    logger,
    passS1Json as unknown as import('./pass/catalog').RawPassFile,
    nk,
  );

  // Phase 7 Chunk 3: emblemas catalog for clubs. ~20 entries; validated
  // at load so `club_create` rejects unknown emblemIds up front.
  loadEmblemasCatalog(
    logger,
    emblemasJson as unknown as import('./clubs/types').EmblemDef[],
  );

  // Phase 5 Chunk 1: ensure the liveops config object is present in
  // storage. Wrapped in try/catch so a transient storage failure
  // (Postgres restart, etc.) never crashes boot — `loadLiveopsConfig`
  // returns the bundled default on every read, so a missing storage
  // row is non-fatal for normal operation.
  try {
    bootEnsureLiveops(nk, logger);
  } catch (e) {
    logger.error(
      'liveops bootEnsure failed (continuing with bundled default): %s',
      e instanceof Error ? e.message : String(e),
    );
  }

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
  // Phase 4: ranked rating updates for every closed ranked race.
  subscribeRankedRewards({ logger, nk, bus });
  // Phase 6 Chunk 4: missions + achievements progress for every
  // closed race (all modes). Bots filtered; lazy storage skipped.
  subscribeMissionsProgress({ logger, nk, bus });
  // Phase 7 Chunk 1: recent rivals (LRU, rolling 30d) for every closed
  // race. Runs AFTER missions so a storage hiccup never delays the
  // missions path.
  subscribeRecentRivals({ logger, nk, bus });
  setRaceBus(bus);

  // Register the RPCs as individual top-level statements.
  //
  // Nakama's goja runtime uses an AST scanner to extract the RPC
  // function names at boot. The scanner walks top-level
  // ExpressionStatements and TryStatement bodies — it does NOT recurse
  // into ForStatement, IfStatement, BlockStatement, etc. So we cannot
  // use a loop here; the calls must be inlined. Each call also uses
  // the bare identifier `config_get` (not a member expression) because
  // the scanner returns the first arg as a string and `checkFnScope`
  // then verifies that `globalThis[arg]` is a function.
  //
  // Phase 5 Chunk 8: `nodeRole === 'relay'` (region replica) only
  // registers the race + match primitives. Wallet/garage/store/
  // profile/account/admin/liveops RPCs stay on the home node.
  // `nodeRole === 'home'` (default) registers the full surface.
  const homeRelay = isHome(nk, logger);
  logger.info('[boot] nodeRole=%s', homeRelay ? 'home' : 'relay');
  try {
    // ── Both modes: race + match primitives ──
    initializer.registerRpc('race_session_get', race_session_get);
    initializer.registerRpc('race_submit_result', race_submit_result);
    if (homeRelay) {
      // ── Home-only: race creation + matching + metagame + ops ──
      initializer.registerRpc('config_get', config_get);
      initializer.registerRpc('race_session_create', race_session_create);
      initializer.registerRpc('race_session_join', race_session_join);
      initializer.registerRpc('race_session_start', race_session_start);
      initializer.registerRpc('race_session_quick_bots', race_session_quick_bots);
      initializer.registerRpc('race_host_claim', race_host_claim);
      initializer.registerRpc('lb_get', lb_get);
      initializer.registerRpc('profile_get', profile_get);
      initializer.registerRpc('profile_update', profile_update);
      initializer.registerRpc('garage_get', garage_get);
      initializer.registerRpc('car_buy', car_buy);
      initializer.registerRpc('car_upgrade', car_upgrade);
      initializer.registerRpc('cosmetic_equip', cosmetic_equip);
      initializer.registerRpc('loadout_set', loadout_set);
      initializer.registerRpc('store_get', store_get);
      initializer.registerRpc('store_buy', store_buy);
      initializer.registerRpc('wallet_get', wallet_get);
      initializer.registerRpc('mm_ticket_params', mm_ticket_params);
      initializer.registerRpc('ranked_get', ranked_get);
      initializer.registerRpc('liveops_config_get', liveops_config_get);
      initializer.registerRpc('inbox_list', inbox_list);
      initializer.registerRpc('inbox_claim', inbox_claim);
      initializer.registerRpc('missions_get', missions_get);
      initializer.registerRpc('mission_claim', mission_claim);
      initializer.registerRpc('mission_reroll', mission_reroll);
      initializer.registerRpc('achievements_get', achievements_get);
      initializer.registerRpc('achievement_claim', achievement_claim);
      initializer.registerRpc('account_link', account_link);
      initializer.registerRpc('account_link_resolve_conflict', account_link_resolve_conflict);
      initializer.registerRpc('account_delete', account_delete);
      initializer.registerRpc('pass_get', pass_get);
      initializer.registerRpc('pass_claim', pass_claim);
      initializer.registerRpc('pass_buy_premium', pass_buy_premium);
      initializer.registerRpc('admin_grant_premium', admin_grant_premium);
      initializer.registerRpc('admin_wallet_adjust', admin_wallet_adjust);
      initializer.registerRpc('admin_send_inbox', admin_send_inbox);
      initializer.registerRpc('admin_sanitize_session', admin_sanitize_session);
      initializer.registerRpc('admin_remove_player', admin_remove_player);
      initializer.registerRpc('admin_cleanup_race_sessions', admin_cleanup_race_sessions);
      initializer.registerRpc('relay_token', relay_token);
      // Phase 7 Chunk 1: friend codes + recent rivals.
      initializer.registerRpc('friend_code_get', friend_code_get);
      initializer.registerRpc('friend_add_by_code', friend_add_by_code);
      initializer.registerRpc('friend_list_get', friend_list_get);
      initializer.registerRpc('friend_remove', friend_remove);
      initializer.registerRpc('recent_rivals_get', recent_rivals_get);
      // Phase 7 Chunk 2: invites + blocks.
      initializer.registerRpc('invite_send', invite_send);
      initializer.registerRpc('invite_list', invite_list);
      initializer.registerRpc('invite_respond', invite_respond);
      initializer.registerRpc('block_add', block_add);
      initializer.registerRpc('block_remove', block_remove);
      initializer.registerRpc('block_list', block_list);
      // Phase 7 Chunk 3: clubs CRUD + catalog.
      initializer.registerRpc('club_create', club_create);
      initializer.registerRpc('club_get', club_get);
      initializer.registerRpc('club_search', club_search);
      // Phase 7 Chunk 4: membership + roles + updates.
      initializer.registerRpc('club_update', club_update);
      initializer.registerRpc('club_members_list', club_members_list);
      initializer.registerRpc('club_kick', club_kick);
      initializer.registerRpc('club_promote', club_promote);
      initializer.registerRpc('club_demote', club_demote);
      initializer.registerRpc('club_leave', club_leave);
    }
    // ── Auth hook — registered on every node; no-op on home ──
    initializer.registerBeforeAuthenticateDevice(beforeAuthenticateDeviceRelay);
  } catch (e) {
    logger.error('rpc registration failed: %s', e instanceof Error ? e.message : String(e));
  }

  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};