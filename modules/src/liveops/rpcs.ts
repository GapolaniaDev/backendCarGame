// Phase 5 Chunk 2 — `liveops_config_get` RPC.
//
// Authenticated players call this on startup to fetch:
//   - the current `flags` (so the client can show a maintenance splash)
//   - the per-platform `minClientVersion` (so the client can prompt for
//     an update before issuing any other RPC)
//   - the `regions` list (so the client can pick a relay)
//   - the upcoming `calendar` (for the events screen)
//   - a `configHash` (sha256 of the canonical config minus the hash
//     itself) so the client can skip a re-render when nothing changed.
//
// Auth required (callerUserId) so we can attribute polls and rate-limit
// spam. NOT gated by maintenance — players need to read this while the
// server is in maintenance to display the splash.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, toJson, type Resp } from '../core/response';
import { parseInput } from '../core/parse_input';
import { loadLiveopsConfig, type LiveopsConfig } from './config';
import type { ClientPlatform, LiveopsRegion, LiveopsCalendarEntry } from './types';
import { claimInbox, listInbox, type InboxDelivered, type InboxMessage } from './messages';
import { liveopsGate } from '../core/liveops';
import { requireCallerId } from '../core/caller';
import { withRuntime } from '../core/runtime_state';

export interface LiveopsConfigGetInput {
  /** Required when called via HTTP gateway; the socket path reads it from ctx.userId. */
  callerUserId: string;
}

export interface LiveopsConfigGetOutput {
  /** Version of the liveops payload — bumped when an admin publishes an override. */
  version: number;
  flags: LiveopsConfig['flags'];
  minClientVersion: Record<ClientPlatform, string>;
  regions: ReadonlyArray<LiveopsRegion>;
  calendar: ReadonlyArray<LiveopsCalendarEntry>;
  /** sha256 hex of JSON.stringify(payload-without-configHash). */
  configHash: string;
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const liveops_config_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.raw);
  if (!callerId.ok) return callerId.error;

  const cfg = loadLiveopsConfig(nk, logger);

  // Strip the hash field (if present) before stringifying — the hash
  // can't include itself.
  const hashSource = stripHash({
    version: cfg.version,
    flags: cfg.flags,
    minClientVersion: cfg.minClientVersion,
    regions: cfg.regions,
    calendar: cfg.calendar,
  });
  const configHash = nk.sha256Hash(JSON.stringify(hashSource));

  logger.info(
    'liveops_config_get caller=%s version=%d hash=%s',
    callerId.id,
    cfg.version,
    configHash,
  );

  return toJson(
    ok({
      version: cfg.version,
      flags: {
        maintenance: cfg.flags.maintenance,
        ...(cfg.flags.maintenanceMessage !== undefined
          ? { maintenanceMessage: cfg.flags.maintenanceMessage }
          : {}),
        // maintenanceExemptUserIds is server-only — don't leak to clients.
      },
      minClientVersion: { ...cfg.minClientVersion },
      regions: cfg.regions.map((r) => ({ ...r })),
      calendar: cfg.calendar.map((c) => ({ ...c })),
      configHash,
    }),
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────


function stripHash<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  // Remove the `configHash` key if present (defensive — currently we never
  // include it in the source, but this keeps the function robust against a
  // future payload that does).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'configHash') continue;
    out[k] = v;
  }
  return out;
}

// Top-level binding for the goja AST scanner.
export const liveops_config_get: RpcHandler = withRuntime(liveops_config_get_impl);

// ─── inbox_list ────────────────────────────────────────────────────────────

export interface InboxListInput {
  callerUserId: string;
  limit?: number;
  cursor?: string;
  includeClaimed?: boolean;
}

export interface InboxListOutput {
  messages: InboxMessage[];
  nextCursor: string;
  unreadCount: number;
}

export const inbox_list_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.raw);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  // NOT maintenance-gated — the client must see the inbox messages
  // even while the splash is shown.
  const opts: { limit?: number; cursor?: string; includeClaimed?: boolean } = {};
  const p = parsed.raw;
  if (typeof p['limit'] === 'number') opts.limit = p['limit'] as number;
  if (typeof p['cursor'] === 'string') opts.cursor = p['cursor'] as string;
  if (typeof p['includeClaimed'] === 'boolean') opts.includeClaimed = p['includeClaimed'] as boolean;

  const result = listInbox(nk, userId, opts, Date.now());
  logger.info('inbox_list user=%s returned=%d unread=%d', userId, result.messages.length, result.unreadCount);
  return toJson(ok({
    messages: result.messages,
    nextCursor: result.nextCursor,
    unreadCount: result.unreadCount,
  }));
};

// ─── inbox_claim ───────────────────────────────────────────────────────────

export interface InboxClaimInput {
  messageId: string;
  callerUserId: string;
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface InboxClaimOutput {
  message: InboxMessage;
  newBalance?: { coins: number; gems: number };
  /** Car/cosmetic ids delivered (for client-side confirmation toast). */
  delivered?: InboxDelivered;
  /** Additive (T-17): reward items missing from the catalog, not delivered. */
  undelivered?: string[];
}

/**
 * Pays the reward and marks the message claimed in one transaction
 * (`claimInbox`, plan T-17): a failed payout leaves it claimable, and
 * every outcome is an envelope (audit 04 f4).
 */
export const inbox_claim_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = requireCallerId(ctx, parsed.raw);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;
  const rawP = parsed.raw;
  const messageId = rawP['messageId'];
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return toJson(err('BAD_REQUEST', 'messageId is required'));
  }

  // LiveOps gate (maintenance + min client version).
  const gate = liveopsGate(
    logger,
    nk,
    userId,
    typeof rawP['clientVersion'] === 'string' ? (rawP['clientVersion'] as string) : undefined,
    typeof rawP['platform'] === 'string' ? (rawP['platform'] as ClientPlatform) : 'ios',
  );
  if (gate !== null) return toJson(gate);

  let result;
  try {
    result = claimInbox(nk, logger, userId, messageId, Date.now());
  } catch (e) {
    logger.error('inbox_claim failed user=%s message=%s: %s', userId, messageId, e instanceof Error ? e.message : String(e));
    return toJson(err('INTERNAL', 'inbox claim failed; nothing was paid and the message is still claimable'));
  }
  if (!result.ok) {
    return toJson(err(result.code, result.message, result.details));
  }

  logger.info(
    'inbox_claim user=%s message=%s paid=%j delivered=%j',
    userId, messageId, result.message.reward ?? null, result.delivered ?? {},
  );
  const out: InboxClaimOutput = {
    message: result.message,
    ...(result.newBalance !== undefined ? { newBalance: result.newBalance } : {}),
    ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
    ...(result.undelivered !== undefined ? { undelivered: result.undelivered } : {}),
  };
  return toJson(ok(out));
};

// Top-level bindings for the goja AST scanner.
export const inbox_list: RpcHandler = withRuntime(inbox_list_impl);
export const inbox_claim: RpcHandler = withRuntime(inbox_claim_impl);

