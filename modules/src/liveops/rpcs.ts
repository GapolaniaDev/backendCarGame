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
import { err, ok, type Resp } from '../core/response';
import { loadLiveopsConfig, type LiveopsConfig } from './config';
import type { ClientPlatform, LiveopsRegion, LiveopsCalendarEntry } from './types';
import { claimInbox, listInbox, sendInbox, type InboxMessage } from './messages';
import { grant } from '../economy/wallet';
import { addCarToGarage, addCosmeticToBag, readGarage, readGarageObject, writeGarageCreate, writeGarageUpdate, defaultGarage } from '../garage/storage';
import { getCarsCatalog, getCosmeticsCatalog } from '../garage/catalog';
import { liveopsGate } from '../core/liveops';

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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
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

interface ParseOk<T> {
  ok: true;
  value: T;
  /** Raw payload so handlers can access arbitrary keys not in the typed shape. */
  raw: Record<string, unknown>;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput(body: string): ParseOk<LiveopsConfigGetInput> | ParseErr {
  const t = body.trim();
  let raw: unknown = {};
  if (t.length > 0) {
    try {
      raw = JSON.parse(t);
    } catch {
      return { ok: false, error: toJson(err('BAD_REQUEST', 'payload is not valid JSON')) };
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload must be an object')) };
  }
  const obj = raw as Record<string, unknown>;
  const out: LiveopsConfigGetInput = {
    callerUserId: typeof obj['callerUserId'] === 'string' ? (obj['callerUserId'] as string) : '',
  };
  return { ok: true, value: out, raw: obj };
}

interface CallerOk {
  ok: true;
  id: string;
}
interface CallerErr {
  ok: false;
  error: string;
}
function resolveCaller(
  ctx: IContext,
  declared: string,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = declared.length > 0 ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(err('FORBIDDEN', 'callerUserId does not match authenticated user')),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('liveops_config_get RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

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

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const liveops_config_get: RpcHandler = liveops_config_get_impl;

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

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
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
  delivered?: { carId?: string; cosmeticId?: string };
}

export const inbox_claim_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
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

  const result = claimInbox(nk, userId, messageId, Date.now(), (nkArg, uid, changeset, idempKey) => {
    const grantResp = grant(nkArg, uid, changeset, { reason: 'inbox', sourceId: messageId }, idempKey);
    if (!grantResp.ok) {
      // The CAS already succeeded; surface the error so the client retries
      // and the idempotency key prevents double-credit.
      throw new Error(`inbox grant failed: ${grantResp.error.code} ${grantResp.error.message}`);
    }
    return { coins: grantResp.data.coins, gems: grantResp.data.gems };
  });
  if (!result.ok) {
    return toJson(err(result.code, result.message));
  }

  // Apply car/cosmetic rewards AFTER the claim CAS so a delivery
  // failure doesn't roll back the claim (idempotency on the wallet
  // side keeps coins/gems safe).
  const delivered: { carId?: string; cosmeticId?: string } = {};
  const reward = result.message.reward;
  if (reward !== undefined) {
    if (typeof reward.carId === 'string' && reward.carId.length > 0) {
      const car = getCarsCatalog().cars.find((c) => c.id === reward.carId);
      if (car) {
        const existing = readGarage(nk, userId);
        if (existing === null) {
          // No garage yet — create one with the car as the first owned car.
          const created = defaultGarage(userId, Date.now());
          const withCar = addCarToGarage(created, car);
          writeGarageCreate(nk, withCar);
        } else {
          const next = addCarToGarage(existing, car);
          // Use the read-with-version helper so the CAS write is correct.
          const read = readGarageWithVersion(nk, userId);
          if (read !== null) writeGarageUpdate(nk, next, read.version);
        }
        delivered.carId = reward.carId;
      }
    }
    if (typeof reward.cosmeticId === 'string' && reward.cosmeticId.length > 0) {
      const cosmetic = getCosmeticsCatalog().items.find((c) => c.id === reward.cosmeticId);
      if (cosmetic) {
        const existing = readGarage(nk, userId);
        if (existing === null) {
          writeGarageCreate(nk, defaultGarage(userId, Date.now()));
        } else {
          const next = addCosmeticToBag(existing, reward.cosmeticId);
          const read = readGarageWithVersion(nk, userId);
          if (read !== null) writeGarageUpdate(nk, next, read.version);
        }
        delivered.cosmeticId = reward.cosmeticId;
      }
    }
  }

  logger.info(
    'inbox_claim user=%s message=%s delivered=%j',
    userId, messageId, delivered,
  );
  const out: InboxClaimOutput = {
    message: result.message,
    ...(result.newBalance !== undefined ? { newBalance: result.newBalance } : {}),
    ...(Object.keys(delivered).length > 0 ? { delivered } : {}),
  };
  return toJson(ok(out));
};

// Top-level bindings for the goja AST scanner.
export const inbox_list: RpcHandler = inbox_list_impl;
export const inbox_claim: RpcHandler = inbox_claim_impl;

/** Read garage with version (thin wrapper that returns null on miss). */
function readGarageWithVersion(nk: INakama, userId: string): { value: import('../garage/types').Garage; version: string } | null {
  return readGarageObject(nk, userId);
}