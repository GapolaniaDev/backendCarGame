// Phase 3 wallet_get RPC. Returns the current wallet view for the
// caller. Cheap: no storage reads, just the in-memory Nakama wallet
// plus a 30-day ledger count (for the UI "last activity" badge).
//
// Called by the client:
//   - on first connection / wallet screen open
//   - after every RPC that mutates the wallet (car_buy, store_buy,
//     race reward, etc.) so the header HUD stays in sync
//
// All decisions enforced here:
//   - Caller identity enforcement: ctx.userId (socket) matches
//     payload.callerUserId (HTTP gateway); cross-user → FORBIDDEN,
//     missing → UNAUTHENTICATED. Same pattern as garage_get (D2) and
//     store_buy (D4).
//   - No cross-user reads: a player cannot request another player's
//     wallet through this RPC. (Future `player_get` would expose a
//     public summary; for now scope = self only.)

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { walletGet } from './wallet';

export interface WalletGetInput {
  /** Required when called via HTTP gateway; the socket canonical path
   *  reads it from `ctx.userId` instead. */
  callerUserId: string;
}

export interface PendingCredit {
  /** Currency the credit will land in once claimed. */
  currency: 'coins' | 'gems';
  /** Positive amount to credit on claim. */
  amount: number;
  /** Stable id of the source (race session, mission id, etc.). */
  reason: string;
  /** Optional epoch-ms when this credit expires unclaimed. */
  expiresAt?: number;
}

export interface WalletGetOutput {
  /** Current spendable balance, projected from `nk.accountGetId`. */
  coins: number;
  gems: number;
  /**
   * Future-shaped list of pending (un-claimed) wallet credits —
   * gifts, mission rewards, season drops. Phase 3 ships this empty
   * because no gift system exists yet, but the field is here so
   * the client can render a generic "Tienes X regalos pendientes"
   * hook today without a follow-up RPC.
   */
  pending: PendingCredit[];
  /** Lightweight ledger summary for UI metrics. */
  ledger: {
    /** Total ledger entries for the user in the last 30 days. */
    last30dCount: number;
  };
}

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export const wallet_get_impl: RpcHandler = (ctx, logger, nk, body) => {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.error;

  const callerId = resolveCaller(ctx, parsed.value.callerUserId, logger);
  if (!callerId.ok) return callerId.error;
  const userId = callerId.id;

  const view = walletGet(nk, userId);
  const last30dCount = countLedgerLast30d(nk, userId);

  logger.info(
    'wallet_get user=%s coins=%d gems=%d ledger30=%d',
    userId, view.coins, view.gems, last30dCount,
  );

  return toJson(ok({
    coins: view.coins,
    gems: view.gems,
    pending: [] as PendingCredit[],
    ledger: { last30dCount },
  }));
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Count the number of ledger entries for `userId` created within the
 * last 30 days. Uses `nk.walletLedgerList` which returns entries in
 * reverse-chronological order; we stop at the first one older than
 * the window to avoid a full scan.
 *
 * Returns 0 when the ledger is empty or the runtime stub doesn't
 * implement the surface — `number` is always the shape.
 */
function countLedgerLast30d(nk: INakama, userId: string): number {
  const now = Date.now();
  const cutoff = now - 30 * DAY_MS;
  try {
    const result = nk.walletLedgerList(userId, 100, '');
    const items = result?.entries ?? [];
    let count = 0;
    for (const entry of items) {
      const ct = (entry as { createTime?: number })?.createTime;
      if (typeof ct !== 'number') continue;
      // Nakama ledger timestamps are unix SECONDS; convert to ms.
      const ms = ct > 1e12 ? ct : ct * 1000;
      if (ms < cutoff) break; // ordered newest-first; stop at the cutoff
      count += 1;
    }
    return count;
  } catch {
    // Treat any runtime error as zero — the ledger count is purely
    // diagnostic and must never fail the RPC.
    return 0;
  }
}

interface ParseOk<T> {
  ok: true;
  value: T;
}
interface ParseErr {
  ok: false;
  error: string;
}
function parseInput(body: string): ParseOk<WalletGetInput> | ParseErr {
  // Empty / `{}` body is allowed — the caller is implicit.
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
  const out: WalletGetInput = {
    callerUserId: typeof obj['callerUserId'] === 'string' ? (obj['callerUserId'] as string) : '',
  };
  return { ok: true, value: out };
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
  logger.warn('wallet_get RPC called with no caller identity');
  return { ok: false, error: toJson(err('UNAUTHENTICATED', 'no caller identity')) };
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

// Top-level binding for the goja AST scanner.
export const wallet_get: RpcHandler = wallet_get_impl;