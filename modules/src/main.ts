// Entry point loaded by Nakama via `--runtime.js_entrypoint=index.js`.
//
// Lifecycle:
//   InitModule(ctx, logger, nk, initializer):
//     1. Load this VM's catalogs + race bus (`ensureRuntimeState`; every
//        other VM loads its own on first use, plan T-29 / audit N8).
//     2. Boot-only side effects (leaderboard tables, liveops storage).
//     3. Register the RPCs, hooks and the service ticker match.
//
// Bundle entry is esbuild — see package.json's "build" script.
//
// IMPORTANT: The Go runtime calls this function positionally as
// `initModFn(goja.Null(), ctx, jsLoggerInst, nk, init)`, so the JS
// param order is (ctx, logger, nk, initializer) — the initializer is
// the FOURTH argument, not the third.

import type { IContext, ILogger, IInitializer, INakama } from './nkruntime';
import { ensureRuntimeState, withRuntimeHook } from './core/runtime_state';
import {
  config_get,
  race_host_claim,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_session_quick_bots,
  race_submit_result,
} from './race/rpcs';
import { ensureLeaderboards } from './leaderboards/ensure';
import { activeRankedTables } from './ranked/leaderboard';
import { beforeWriteLeaderboardRecordGuard } from './leaderboards/hooks';
import { ensureClubWeekLeaderboard } from './clubs/leaderboard_init';
import { event_list } from './events/rpcs';
import { lb_get as lb_get } from './leaderboards/lb_get';
import {
  profile_get,
  profile_update,
} from './profiles/rpcs';
import { afterAuthenticateAutoCreate } from './account/after_auth';
import { garage_get, car_buy, car_upgrade, cosmetic_equip, loadout_set } from './garage/rpcs';
import { bootEnsure as bootEnsureLiveops } from './liveops/config';
import { liveops_config_get, inbox_list, inbox_claim } from './liveops/rpcs';
import { missions_get, mission_claim, mission_reroll } from './missions/rpcs';
import {
  friend_code_get,
  friend_add_by_code,
  friend_list_get,
  friend_remove,
  recent_rivals_get,
} from './social/rpcs';
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
import { iap_purchase } from './iap/rpcs';
import { iap_subscription_status, iap_subscription_cancel } from './iap/subscription_rpcs';
import { ad_watched } from './ads/rpcs';
import {
  admin_iap_purchases_list,
  admin_iap_purchases_get,
  admin_iap_refund,
  admin_iap_fraud_flags_list,
  admin_iap_fraud_flag_action,
  admin_iap_revenue_stats_get,
} from './iap/admin';
import {
  admin_iap_analytics_get,
  admin_iap_ltv_get,
  admin_iap_funnel_get,
  admin_iap_top_buyers_get,
} from './analytics/rpcs';
import { chat_send, chat_list } from './chat/rpcs';
import {
  report_player,
  admin_view_reports,
  admin_silence,
  admin_unsilence,
} from './moderation/rpcs';
import {
  party_create,
  party_join,
  party_invite,
  party_leave,
  party_kick,
  party_get,
} from './parties/rpcs';
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
  tournament_list,
  tournament_get,
  tournament_join,
} from './tournaments/rpcs';
import {
  admin_tournament_list,
  admin_tournament_get,
  admin_tournament_release_prizes,
  admin_tournament_void_refund,
  admin_tournament_cancel,
  admin_tournament_extend,
} from './tournaments/admin';
import {
  admin_marks_list,
  admin_marks_partials_view,
  admin_marks_confirm,
  admin_marks_dismiss,
  admin_marks_sanction,
  admin_anti_cheat_stats_get,
} from './anti_cheat/rpcs';
import {
  admin_overview_get,
  admin_tournaments_stats_get,
  admin_events_stats_get,
  admin_players_search,
  admin_wallet_grant,
  admin_anti_cheat_dashboard_get,
} from './admin/dashboard';
import {
  pass_get,
  pass_claim,
  pass_buy_premium,
  admin_grant_premium,
} from './pass/rpcs';
import { ranked_get } from './ranked/rpcs';
import { mm_ticket_params, matchmakerMatchedImpl } from './matchmaking/rpcs';
import { store_get, store_buy } from './store/rpcs';
import { wallet_get } from './economy/rpcs';
import {
  ensureServiceTicker,
  serviceTickerInit,
  serviceTickerJoinAttempt,
  serviceTickerJoin,
  serviceTickerLeave,
  serviceTickerLoop,
  serviceTickerTerminate,
  serviceTickerSignal,
} from './scheduler/service_ticker';

// Hooks run in pool VMs that never ran InitModule: each wrapper loads the
// VM's catalogs and race bus first (plan T-29, D-11; audit N8). They are
// top-level bindings so the 3.27 registration scanner resolves them.
const matchmakerMatched = withRuntimeHook(matchmakerMatchedImpl);
const afterAuthenticate = withRuntimeHook(afterAuthenticateAutoCreate);
const beforeWriteLeaderboardRecord = withRuntimeHook(beforeWriteLeaderboardRecordGuard);

function InitModule(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  initializer: IInitializer,
): void {
  // Catalogs + race bus for this (throwaway) VM, with the same loaders
  // every pool and match VM uses. Throws on an invalid catalog, so a bad
  // catalog still aborts the boot.
  ensureRuntimeState(nk, logger, { boot: true });

  // Boot-only side effects (storage / leaderboard tables), not per VM.
  // Ensure every authoritative leaderboard exists with the catalog's
  // order (recreating one that differs, plan T-13 / R-02), including the
  // active season's ranked table, and drop the deprecated client-writable
  // `race_score` table; the client-write guard hook is registered with
  // the other hooks below.
  ensureLeaderboards(logger, nk, activeRankedTables(Date.now()));
  // Phase 7 Chunk 5: ensure the `club_week` authoritative table
  // exists with the Monday 00:00 UTC reset schedule. Idempotent —
  // re-creating an existing table is a no-op.
  ensureClubWeekLeaderboard(logger, nk);

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

  // Every registration is a top-level statement of this `try` — no
  // `if`, loop or nested block, and never from a helper function.
  //
  // Nakama 3.27's goja runtime extracts the handler names with an AST
  // scanner (`getRegisteredFnIdentifier` / `getHookFnIdentifier` in
  // runtime_javascript_init.go). It only walks the top-level statements
  // of `InitModule` and the bodies of top-level `try` statements, and
  // the handler argument must be a bare identifier of a global
  // function. A registration anywhere else throws "function key could
  // not be extracted: not found" (audit N0). The static test
  // `tests/unit/registration_shape.test.ts` enforces this shape on the
  // built bundle.
  try {
    // ── Hooks ──
    initializer.registerMatchmakerMatched(matchmakerMatched);
    initializer.registerAfterAuthenticateDevice(afterAuthenticate);
    initializer.registerAfterAuthenticateCustom(afterAuthenticate);
    initializer.registerAfterAuthenticateEmail(afterAuthenticate);
    initializer.registerAfterAuthenticateApple(afterAuthenticate);
    initializer.registerBeforeWriteLeaderboardRecord(beforeWriteLeaderboardRecord);
    // Periodic jobs (tournaments, events, subscriptions) run in this
    // service match: the runtime has no setInterval (audit PC-09).
    initializer.registerMatch('service_ticker', {
      matchInit: serviceTickerInit,
      matchJoinAttempt: serviceTickerJoinAttempt,
      matchJoin: serviceTickerJoin,
      matchLeave: serviceTickerLeave,
      matchLoop: serviceTickerLoop,
      matchTerminate: serviceTickerTerminate,
      matchSignal: serviceTickerSignal,
    });
    // ── RPCs ──
    initializer.registerRpc('race_session_get', race_session_get);
    initializer.registerRpc('race_submit_result', race_submit_result);
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
    // Phase 9 Chunk 3: IAP purchase (bypasses maintenance — money
    // already paid via Apple/Google, must still redeem).
    initializer.registerRpc('iap_purchase', iap_purchase);
    // Phase 9 Chunk 4: subscription status + cancel (also maintenance-bypass).
    initializer.registerRpc('iap_subscription_status', iap_subscription_status);
    initializer.registerRpc('iap_subscription_cancel', iap_subscription_cancel);
    // Phase 9 Chunk 5: ad reward (maintenance-bypass, D77).
    initializer.registerRpc('ad_watched', ad_watched);
    // Phase 9 Chunk 6: 6 admin IAP RPCs (assertAdminKey + maintenance-bypass).
    initializer.registerRpc('admin_iap_purchases_list', admin_iap_purchases_list);
    initializer.registerRpc('admin_iap_purchases_get', admin_iap_purchases_get);
    initializer.registerRpc('admin_iap_refund', admin_iap_refund);
    initializer.registerRpc('admin_iap_fraud_flags_list', admin_iap_fraud_flags_list);
    initializer.registerRpc('admin_iap_fraud_flag_action', admin_iap_fraud_flag_action);
    initializer.registerRpc('admin_iap_revenue_stats_get', admin_iap_revenue_stats_get);
    // Phase 9 Chunk 7: 4 admin IAP analytics RPCs (assertAdminKey + maintenance-bypass D91).
    initializer.registerRpc('admin_iap_analytics_get', admin_iap_analytics_get);
    initializer.registerRpc('admin_iap_ltv_get', admin_iap_ltv_get);
    initializer.registerRpc('admin_iap_funnel_get', admin_iap_funnel_get);
    initializer.registerRpc('admin_iap_top_buyers_get', admin_iap_top_buyers_get);
    initializer.registerRpc('pass_get', pass_get);
    initializer.registerRpc('pass_claim', pass_claim);
    initializer.registerRpc('pass_buy_premium', pass_buy_premium);
    initializer.registerRpc('admin_grant_premium', admin_grant_premium);
    initializer.registerRpc('admin_wallet_adjust', admin_wallet_adjust);
    initializer.registerRpc('admin_send_inbox', admin_send_inbox);
    initializer.registerRpc('admin_sanitize_session', admin_sanitize_session);
    initializer.registerRpc('admin_remove_player', admin_remove_player);
    initializer.registerRpc('admin_cleanup_race_sessions', admin_cleanup_race_sessions);
    // Phase 8 Chunk 4: anti-cheat admin RPCs (6).
    initializer.registerRpc('admin_marks_list', admin_marks_list);
    initializer.registerRpc('admin_marks_partials_view', admin_marks_partials_view);
    initializer.registerRpc('admin_marks_confirm', admin_marks_confirm);
    initializer.registerRpc('admin_marks_dismiss', admin_marks_dismiss);
    initializer.registerRpc('admin_marks_sanction', admin_marks_sanction);
    initializer.registerRpc('admin_anti_cheat_stats_get', admin_anti_cheat_stats_get);
    // Phase 8 Chunk 9: admin dashboard RPCs (6).
    initializer.registerRpc('admin_overview_get', admin_overview_get);
    initializer.registerRpc('admin_tournaments_stats_get', admin_tournaments_stats_get);
    initializer.registerRpc('admin_events_stats_get', admin_events_stats_get);
    initializer.registerRpc('admin_players_search', admin_players_search);
    initializer.registerRpc('admin_wallet_grant', admin_wallet_grant);
    initializer.registerRpc('admin_anti_cheat_dashboard_get', admin_anti_cheat_dashboard_get);
    // Phase 8 Chunk 5: tournaments (3 RPCs).
    initializer.registerRpc('tournament_list', tournament_list);
    initializer.registerRpc('tournament_get', tournament_get);
    initializer.registerRpc('tournament_join', tournament_join);
    // Phase 8 Chunk 7: admin tournament RPCs (6).
    initializer.registerRpc('admin_tournament_list', admin_tournament_list);
    initializer.registerRpc('admin_tournament_get', admin_tournament_get);
    initializer.registerRpc('admin_tournament_release_prizes', admin_tournament_release_prizes);
    initializer.registerRpc('admin_tournament_void_refund', admin_tournament_void_refund);
    initializer.registerRpc('admin_tournament_cancel', admin_tournament_cancel);
    initializer.registerRpc('admin_tournament_extend', admin_tournament_extend);
    // Phase 8 Chunk 8: event_list RPC.
    initializer.registerRpc('event_list', event_list);
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
    // Phase 7 Chunk 6: chat (2 RPCs).
    initializer.registerRpc('chat_send', chat_send);
    initializer.registerRpc('chat_list', chat_list);
    // Phase 7 Chunk 7: moderation (1 player RPC + 3 admin RPCs).
    initializer.registerRpc('report_player', report_player);
    initializer.registerRpc('admin_view_reports', admin_view_reports);
    initializer.registerRpc('admin_silence', admin_silence);
    initializer.registerRpc('admin_unsilence', admin_unsilence);
    // Phase 7 Chunk 8: parties (5 RPCs).
    initializer.registerRpc('party_create', party_create);
    initializer.registerRpc('party_invite', party_invite);
    initializer.registerRpc('party_leave', party_leave);
    initializer.registerRpc('party_kick', party_kick);
    initializer.registerRpc('party_get', party_get);
    initializer.registerRpc('party_join', party_join);
  } catch (e) {
    logger.error('rpc registration failed: %s', e instanceof Error ? e.message : String(e));
  }

  // Start the scheduler (one service match per process; plan D-06).
  ensureServiceTicker(nk, logger);

  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};