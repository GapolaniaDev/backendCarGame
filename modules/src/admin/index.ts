// Phase 5 Chunk 6 — Admin barrel export.

export {
  admin_wallet_adjust,
  admin_wallet_adjust_impl,
  admin_send_inbox,
  admin_send_inbox_impl,
  admin_sanitize_session,
  admin_sanitize_session_impl,
  admin_remove_player,
  admin_remove_player_impl,
  admin_cleanup_race_sessions,
  admin_cleanup_race_sessions_impl,
  type RpcHandler,
} from './rpcs';

export {
  admin_overview_get,
  admin_overview_get_impl,
  admin_tournaments_stats_get,
  admin_tournaments_stats_get_impl,
  admin_events_stats_get,
  admin_events_stats_get_impl,
  admin_players_search,
  admin_players_search_impl,
  admin_wallet_grant,
  admin_wallet_grant_impl,
  admin_anti_cheat_dashboard_get,
  admin_anti_cheat_dashboard_get_impl,
} from './dashboard';

export type {
  AdminOverviewGetInput,
  AdminOverviewGetOutput,
  AdminTournamentsStatsGetInput,
  AdminTournamentsStatsGetOutput,
  AdminEventsStatsGetInput,
  AdminEventsStatsGetOutput,
  AdminPlayersSearchInput,
  AdminPlayersSearchRow,
  AdminPlayersSearchOutput,
  AdminWalletGrantInput,
  AdminWalletGrantOutput,
  AdminAntiCheatDashboardGetInput,
  AdminAntiCheatDashboardGetOutput,
} from './dashboard';

export type {
  AdminWalletAdjustInput,
  AdminWalletAdjustOutput,
  AdminSendInboxInput,
  AdminSendInboxOutput,
  AdminSanitizeSessionInput,
  AdminSanitizeSessionOutput,
  AdminRemovePlayerInput,
  AdminRemovePlayerOutput,
  AdminCleanupRaceSessionsInput,
  AdminCleanupRaceSessionsOutput,
} from './types';

export { assertAdminKey, withoutAdminKey } from './auth';
export { emitAdminAction, ANALYTICS_COLLECTION } from '../core/admin/analytics';
export { walletAdjust } from './wallet_admin';
export { sendInboxBulk } from './inbox_admin';
export { sanitizeSession, removePlayer } from './sanitize';
export { cleanupRaceSessions } from './cleanup';
export {
  DASHBOARD_CACHE_TTL_MS,
  invalidateDashboardCache,
  clearDashboardCache,
} from './cache';
export {
  zeroFillDateRange,
  utcDateStr,
  inUtcDay,
  aggregateTournamentsByDay,
  aggregateEventsByDay,
  playerMatchesSearch,
  tournamentToDayInput,
  type TournamentDayInput,
  type TournamentDayStats,
  type EventDayInput,
  type EventsDayStats,
} from './stats';