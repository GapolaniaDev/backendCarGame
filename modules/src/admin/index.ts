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