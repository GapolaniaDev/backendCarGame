// Phase 5 Chunk 7 — General server-emitted analytics events.
//
// Replaces the Chunk-6 `emitAdminAction` with a generalized `emit()`
// helper that any module can call. The shape on disk is:
//
//   collection: `analytics_events`
//   key:        `<ts>-<uuid>`
//   userId:     `SYSTEM_USER_ID` (default) or per-event `opts.userId`
//   perms:      read=2 (public for ops dashboards), write=0 (server-only)
//
// Each event is `{ schemaVersion: 1, id, ts, name, userId?, props,
// webhook? }`. The webhook block is populated AFTER the storage write
// when `liveops_config.analyticsWebhook` is configured; failures are
// logged at warn and the event still succeeds.
//
// D8 locked (Chunk 7): destination = Storage `analytics_events` +
// optional webhook. Webhook is best-effort — no retry, no DLQ.
// Can be called on hot paths (every wallet grant). NEVER throws.

import type { ILogger, INakama } from '../../nkruntime';
import { SYSTEM_USER_ID } from '../../race/constants';
import { loadLiveopsConfig } from '../../liveops/config';

export const ANALYTICS_COLLECTION = 'analytics_events';

export type AnalyticsEventName =
  | 'admin_action'
  | 'session_started'
  | 'race_completed'
  | 'wallet_moved'
  | 'store_purchase'
  | 'matchmaker_matched'
  | 'host_claimed'
  | 'profile_updated'
  | 'mm_ticket_params_called'
  | 'account_linked'
  | 'account_link_conflict'
  | 'account_link_conflict_resolved'
  | 'account_deleted'
  | 'report_filed'
  | 'party_created'
  | 'party_invite_sent'
  | 'party_left'
  | 'party_kicked';

export interface AnalyticsWebhook {
  url: string;
  /** Epoch-ms when the webhook POST was attempted. */
  attemptedAt: number;
  /** HTTP status code returned by the receiver, or `null` on failure. */
  status: number | null;
  /** Truncated error message when the POST failed. */
  error: string | null;
}

export interface AnalyticsEvent {
  schemaVersion: 1;
  id: string;
  ts: number;
  name: AnalyticsEventName | string;
  userId?: string;
  props: Record<string, unknown>;
  webhook?: AnalyticsWebhook;
}

export interface EmitOptions {
  /** When provided, overrides the default SYSTEM_USER_ID owner. */
  userId?: string;
}

/**
 * Write one analytics row + fire-and-forget webhook (when configured).
 *
 * ALL failures are caught and logged at warn level — `emit()` MUST
 * NEVER throw. The storage row is the source of truth; the webhook is
 * a notification convenience.
 */
export function emit(
  nk: INakama,
  logger: ILogger | undefined,
  name: AnalyticsEventName | string,
  props: Record<string, unknown>,
  opts: EmitOptions = {},
): void {
  const safeWarn = (fmt: string, ...args: unknown[]): void => {
    if (logger) {
      logger.warn(fmt, ...args);
    }
  };
  let ts = 0;
  let key = '';
  try {
    ts = Date.now();
    key = `${ts}-${nk.uuidv4()}`;
    const ownerId = opts.userId ?? SYSTEM_USER_ID;
    const value: AnalyticsEvent = {
      schemaVersion: 1,
      id: nk.uuidv4(),
      ts,
      name,
      props: { ...props },
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    };
    nk.storageWrite([
      {
        collection: ANALYTICS_COLLECTION,
        key,
        userId: ownerId,
        value: value as unknown as Record<string, unknown>,
        permissionRead: 2,
        permissionWrite: 0,
      },
    ]);
  } catch (e) {
    safeWarn(
      'emit(%s) storage failed: %s',
      name, e instanceof Error ? e.message : String(e),
    );
    return;
  }

  // Best-effort webhook. The POST is synchronous in the production
  // goja runtime, so a slow receiver will block this worker briefly;
  // we accept that for now and revisit with a cron batch in a later
  // chunk.
  let webhookUrl: string | undefined;
  try {
    const cfg = loadLiveopsConfig(nk, logger);
    if (typeof cfg.analyticsWebhook === 'string' && cfg.analyticsWebhook.length > 0) {
      webhookUrl = cfg.analyticsWebhook;
    }
  } catch (e) {
    safeWarn(
      'emit(%s) liveops_config read failed: %s',
      name, e instanceof Error ? e.message : String(e),
    );
  }

  if (webhookUrl === undefined) return;

  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = nk.httpRequest(
      webhookUrl,
      'POST',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ name, ts, id: key, props }),
    );
    status = typeof res?.code === 'number' ? res.code : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const webhookBlock: AnalyticsWebhook = {
    url: webhookUrl,
    attemptedAt: Date.now(),
    status,
    error,
  };

  // Best-effort: patch the stored event with the webhook outcome so
  // dashboards can see delivery status.
  try {
    const ownerId = opts.userId ?? SYSTEM_USER_ID;
    nk.storageWrite([
      {
        collection: ANALYTICS_COLLECTION,
        key,
        userId: ownerId,
        value: { schemaVersion: 1, id: key, ts, name, props, webhook: webhookBlock } as unknown as Record<string, unknown>,
        permissionRead: 2,
        permissionWrite: 0,
      },
    ]);
  } catch (e) {
    safeWarn(
      'emit(%s) webhook-block write failed: %s',
      name, e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Backwards-compatible wrapper used by the admin RPCs (Chunk 6).
 * Delegates to `emit` so the audit trail reuses the same storage +
 * webhook path as the other analytics events.
 */
export function emitAdminAction(
  nk: INakama,
  logger: ILogger,
  rpcName: string,
  props: Record<string, unknown>,
): void {
  emit(nk, logger, 'admin_action', { ...props, rpcName });
}