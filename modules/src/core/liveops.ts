// Phase 5 Chunk 2 — liveops gates (maintenance + min client version).
//
// Both helpers re-read `liveops/config` on every call (NO in-memory
// cache, mirrors `loadLiveopsConfig`) so an admin's runtime override
// takes effect on the next RPC without a restart.
//
// Decisions enforced here:
//     - D1 maintenance granularity: GLOBAL — one flag, read at every
//        gated RPC.
//     - D2 min client version: HARD BLOCK — `UPGRADE_REQUIRED` returned
//        before any game RPC mutates state.
//     - Exempt users: `flags.maintenanceExemptUserIds` is a static
//        server-only list. Admin RPCs (Chunks 5+) bypass maintenance
//        via `skipForAdmin: true`.
//
// Usage: each gated RPC calls both helpers right after resolving the
// caller. On a hit the helper returns an error envelope; the RPC
// short-circuits with `return toJson(envelope)`.

import type { ILogger, INakama } from '../nkruntime';
import { err, type Resp } from './response';
import {
  loadLiveopsConfig,
  type LiveopsConfig,
  type ClientPlatform,
} from '../liveops/config';

// ─── Semver compare ────────────────────────────────────────────────────────

/**
 * Numeric, not lexicographic: `1.10.0 > 1.9.0`. Missing patch /
 * minor / major segments default to 0, so `1.2` compares against
 * `1.2.0` as equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] {
  const trimmed = v.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trimmed);
  if (!m) return [0, 0, 0];
  return [
    Number(m[1]),
    m[2] !== undefined ? Number(m[2]) : 0,
    m[3] !== undefined ? Number(m[3]) : 0,
  ];
}

// ─── Maintenance gate ──────────────────────────────────────────────────────

export interface MaintenanceGateOptions {
  /** When true, maintenance is ignored. Reserved for admin RPCs (Chunks 5+). */
  skipForAdmin?: boolean;
}

/**
 * Reads `liveops/config` from storage; returns an `err(SERVICE_UNAVAILABLE)`
 * envelope when `flags.maintenance === true` AND `userId` is not in
 * `flags.maintenanceExemptUserIds` AND `skipForAdmin !== true`.
 *
 * Returns `null` on the happy path so callers can do
 *   `const m = assertNotInMaintenance(logger, nk, userId); if (m !== null) return toJson(m);`
 * as an early-return guard.
 */
export function assertNotInMaintenance(
  logger: ILogger,
  nk: INakama,
  userId: string,
  opts: MaintenanceGateOptions = {},
): Resp<unknown> | null {
  if (opts.skipForAdmin === true) return null;
  const cfg = loadLiveopsConfig(nk, logger);
  if (!cfg.flags.maintenance) return null;

  const exemptList = cfg.flags.maintenanceExemptUserIds;
  if (Array.isArray(exemptList) && exemptList.includes(userId)) {
    logger.info('maintenance gate: user %s is exempt → no-op', userId);
    return null;
  }

  const detail: { userId: string; message?: string } = { userId };
  if (cfg.flags.maintenanceMessage !== undefined) {
    detail.message = cfg.flags.maintenanceMessage;
  }
  return err(
    'SERVICE_UNAVAILABLE',
    'El servidor está en mantenimiento. Vuelve pronto.',
    detail,
  );
}

// ─── Min client version gate ────────────────────────────────────────────────

/**
 * Returns an `err(UPGRADE_REQUIRED)` envelope when `clientVersion` is
 * strictly less than `config.minClientVersion[platform]`. A missing
 * `clientVersion` is treated as `"0.0.0"` (defense against legacy
 * clients that don't send it). Returns `null` on the happy path.
 */
export function assertMinClientVersion(
  clientVersion: string | undefined,
  platform: ClientPlatform,
  config: LiveopsConfig,
): Resp<unknown> | null {
  const incoming = clientVersion ?? '0.0.0';
  const required = config.minClientVersion[platform] ?? '0.0.0';
  if (compareSemver(incoming, required) < 0) {
    return err(
      'UPGRADE_REQUIRED',
      'Tu versión del juego está desactualizada. Actualiza para continuar.',
      { clientVersion: incoming, required, platform },
    );
  }
  return null;
}

// ─── Combined gate for the RPC entry point ──────────────────────────────────

/**
 * Runs both gates with a single `loadLiveopsConfig` read (cheaper when
 * the RPC handler hits both). Returns the first envelope hit, or null.
 */
export function liveopsGate(
  logger: ILogger,
  nk: INakama,
  userId: string,
  clientVersion: string | undefined,
  platform: ClientPlatform,
): Resp<unknown> | null {
  const cfg = loadLiveopsConfig(nk, logger);
  const m = assertNotInMaintenance(logger, nk, userId);
  if (m !== null) return m;
  const v = assertMinClientVersion(clientVersion, platform, cfg);
  if (v !== null) return v;
  return null;
}