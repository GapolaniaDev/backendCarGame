// Phase 5 Chunk 6 — Admin analytics emitter.
//
// Every admin RPC writes an `analytics_events` row with shape
// `{ schemaVersion: 1, event: 'admin_action', at, rpcName, props }`.
// Owner is the SYSTEM_USER_ID with permissionRead=2 (public-readable
// for ops dashboards), permissionWrite=0 (server-only).
//
// Storage layout:
//   collection: `analytics_events`
//   key:        `<at>-<uuid>`  (ms-timestamp prefix so a listing is
//                naturally sorted by time; the uuid suffix avoids
//                collision when two admin RPCs land in the same ms).
//   userId:     SYSTEM_USER_ID
//
// D8 spec (Checklist §3.4): the storage destination is documented;
// the optional webhook destination lands in a later chunk. This helper
// only writes storage.

import type { ILogger, INakama } from '../../nkruntime';
import { SYSTEM_USER_ID } from '../../race/constants';

export const ANALYTICS_COLLECTION = 'analytics_events';

export interface AdminActionEvent {
  schemaVersion: 1;
  event: 'admin_action';
  /** Epoch-ms when the action ran. */
  at: number;
  /** The admin RPC name. */
  rpcName: string;
  /** Optional target user (for per-user admin ops like wallet/remove). */
  targetUserId?: string;
  /** Optional reason string. */
  reason?: string;
  /** Free-form structured payload — the RPC's audit detail. */
  props: Record<string, unknown>;
}

/**
 * Write one analytics row. Failures are logged at warn level and
 * swallowed — analytics MUST NOT crash the admin RPC. The audit trail
 * is best-effort by design; the RPC's primary effect (wallet update,
 * purge, etc.) is the source of truth.
 */
export function emitAdminAction(
  nk: INakama,
  logger: ILogger,
  rpcName: string,
  props: Record<string, unknown>,
): void {
  try {
    const at = Date.now();
    const key = `${at}-${nk.uuidv4()}`;
    const value: AdminActionEvent = {
      schemaVersion: 1,
      event: 'admin_action',
      at,
      rpcName,
      ...(typeof props['targetUserId'] === 'string' ? { targetUserId: props['targetUserId'] as string } : {}),
      ...(typeof props['reason'] === 'string' ? { reason: props['reason'] as string } : {}),
      props: { ...props, rpcName, at },
    };
    nk.storageWrite([
      {
        collection: ANALYTICS_COLLECTION,
        key,
        userId: SYSTEM_USER_ID,
        value: value as unknown as Record<string, unknown>,
        permissionRead: 2,
        permissionWrite: 0,
      },
    ]);
  } catch (e) {
    logger.warn(
      'emitAdminAction failed rpc=%s: %s',
      rpcName, e instanceof Error ? e.message : String(e),
    );
  }
}