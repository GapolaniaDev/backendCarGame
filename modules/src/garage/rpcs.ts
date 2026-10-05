// garage_get RPC. Returns the full garage (cars + loadout + daily
// counters) in a single call (Decision 2 — no pagination, no
// partial reads). Auto-creates a default garage on first read so a
// client that authenticates via a channel the after-auth hook
// doesn't cover (e.g. Facebook) still gets a usable garage on the
// first `garage_get`.
//
// All decisions enforced here:
//   - D2: garage_get returns everything; the client doesn't need
//     subsequent per-car fetches.
//   - Caller must own the garage (HTTP gateway passes callerUserId
//     in the payload; the resolver enforces identity).

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import {
  defaultGarage,
  readGarage,
  writeGarageCreate,
} from './storage';
import type { Garage as GarageRecord, OwnedCar, Loadout } from './types';

export interface GarageGetInput {
  /** Target userId. Defaults to the caller. */
  userId?: string;
  callerUserId: string;
}

export interface GarageGetOutput {
  garage: GarageView;
}

export interface GarageView {
  userId: string;
  cars: OwnedCarView[];
  loadout: LoadoutView | null;
  lastDailyWin: number;
  dailyPrivateCount: number;
  dailyResetAt: number;
}

export interface OwnedCarView {
  carId: string;
  classId: OwnedCar['classId'];
  upgrades: OwnedCar['upgrades'];
  cosmetics: OwnedCar['cosmetics'];
  computedStats: OwnedCar['computedStats'];
}

export interface LoadoutView {
  activeCarId: string;
  equipped: OwnedCar['cosmetics'];
  stats: Loadout['stats'];
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const garage_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput<GarageGetInput>(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;

  const targetUserId = parsed.value.userId ?? callerId.id;

  // Caller can only read their own garage. Admins / spectators are
  // out of scope for Phase 3.
  if (targetUserId !== callerId.id) {
    return toJson(err('FORBIDDEN', 'cannot read another user\'s garage'));
  }

  // Auto-create on first read so a missing record still yields a
  // usable response (mirrors profile_get).
  const existing = readGarage(nk, targetUserId);
  if (!existing) {
    const created = defaultGarage(targetUserId, Date.now());
    try {
      writeGarageCreate(nk, created);
    } catch (e) {
      logger.warn(
        'garage_get: auto-create failed for %s: %s',
        targetUserId,
        e instanceof Error ? e.message : String(e),
      );
      return toJson(err('INTERNAL', 'failed to create default garage'));
    }
    logger.info('garage_get auto-created default garage for %s', targetUserId);
    return toJson(ok({ garage: toView(created) }));
  }

  return toJson(ok({ garage: toView(existing) }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput<T>(body: string): ParseOk<T> | ParseErr {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload is not valid JSON')) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: toJson(err('BAD_REQUEST', 'payload must be an object')) };
  }
  return { ok: true, value: raw as T };
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
  declared: string | undefined,
  logger: ILogger,
): CallerOk | CallerErr {
  const socketCaller = ctx.userId ?? null;
  const declaredCaller = typeof declared === 'string' ? declared : null;
  if (socketCaller !== null) {
    if (declaredCaller !== null && declaredCaller !== socketCaller) {
      return {
        ok: false,
        error: toJson(
          err('FORBIDDEN', 'callerUserId does not match authenticated user'),
        ),
      };
    }
    return { ok: true, id: socketCaller };
  }
  if (declaredCaller !== null) return { ok: true, id: declaredCaller };
  logger.warn('garage_get RPC called with no caller identity');
  return {
    ok: false,
    error: toJson(err('UNAUTHENTICATED', 'no caller identity')),
  };
}

function toView(g: GarageRecord): GarageView {
  return {
    userId: g.userId,
    cars: g.cars.map(toOwnedCarView),
    loadout: g.loadout ? toLoadoutView(g.loadout) : null,
    lastDailyWin: g.lastDailyWin,
    dailyPrivateCount: g.dailyPrivateCount,
    dailyResetAt: g.dailyResetAt,
  };
}

function toOwnedCarView(c: OwnedCar): OwnedCarView {
  return {
    carId: c.carId,
    classId: c.classId,
    upgrades: { ...c.upgrades },
    cosmetics: { ...c.cosmetics },
    computedStats: { ...c.computedStats },
  };
}

function toLoadoutView(l: Loadout): LoadoutView {
  return {
    activeCarId: l.activeCarId,
    equipped: { ...l.equipped },
    stats: { ...l.stats },
  };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const garage_get: RpcHandler = garage_get_impl;