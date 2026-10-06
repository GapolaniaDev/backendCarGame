// Phase 5 Chunk 8 — `relay_token` RPC.
//
// The client calls this RPC after authenticating to learn which relay
// replica it should connect to (the home node returns the canonical
// relay URL + a short-lived HMAC token that the relay uses to
// validate the client's eligibility to enter a match).
//
// Maintenance-gated. Admins bypass maintenance (so the ops tool can
// still mint tokens during a maint window).
//
// D9: token TTL = 60 minutes (RELAY_TOKEN_TTL_SEC).
// D10: signing = HMAC-SHA-256 with `liveops_config.relayTokenSecret`.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import {
  assertNotInMaintenance,
  assertMinClientVersion,
} from '../core/liveops';
import {
  loadLiveopsConfig,
  type ClientPlatform,
} from '../liveops/config';
import {
  signRelayToken,
  RELAY_TOKEN_TTL_SEC,
} from './relay_token';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  body: string,
) => string;

export interface RelayTokenInput {
  clientVersion?: string;
  platform?: ClientPlatform;
}

export interface RelayTokenOutput {
  token: string;
  relayUrl: string;
  /** Unix seconds. */
  expiresAt: number;
  regionId: string;
}

function toJson<T>(r: Resp<T>): string {
  return JSON.stringify(r);
}

/**
 * Pick the default relay region. v1 always returns the FIRST region
 * in the catalog (the canonical "us-east-1"-style region); the client
 * chooses a specific region in a future iteration. Returns `null`
 * when the catalog is empty (defensive — the liveops validator
 * already requires ≥1 region).
 */
function pickRegionRelayUrl(
  regions: ReadonlyArray<{ id: string; relayUrl: string }>,
): { id: string; relayUrl: string } | null {
  for (const r of regions) {
    if (typeof r.id === 'string' && typeof r.relayUrl === 'string') {
      return { id: r.id, relayUrl: r.relayUrl };
    }
  }
  return null;
}

export const relay_token_impl: RpcHandler = (ctx, logger, nk, body) => {
  // Auth required.
  if (typeof ctx.userId !== 'string' || ctx.userId.length === 0) {
    return toJson(err('UNAUTHENTICATED', 'login required to mint a relay token'));
  }
  const userId = ctx.userId;

  // Parse optional client metadata for the gate.
  const raw: Record<string, unknown> = (() => {
    if (typeof body !== 'string' || body.trim().length === 0) return {};
    try {
      const j = JSON.parse(body) as unknown;
      if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
        return j as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  })();
  const clientVersion =
    typeof raw['clientVersion'] === 'string' ? (raw['clientVersion'] as string) : undefined;
  const platform: ClientPlatform =
    typeof raw['platform'] === 'string' ? (raw['platform'] as ClientPlatform) : 'ios';

  // LiveOps gate — admin bypass on maintenance so ops tools still
  // work during a maintenance flag, but client min-version is still
  // enforced (don't mint tokens for clearly-stale clients).
  const cfg0 = loadLiveopsConfig(nk, logger);
  const m = assertNotInMaintenance(logger, nk, userId, { skipForAdmin: true });
  if (m !== null) return toJson(m);
  const v = assertMinClientVersion(clientVersion, platform, cfg0);
  if (v !== null) return toJson(v);

  const cfg = loadLiveopsConfig(nk, logger);
  const region = pickRegionRelayUrl(cfg.regions);
  if (region === null) {
    return toJson(err('SERVICE_UNAVAILABLE', 'no relay regions configured'));
  }
  const secret = cfg.relayTokenSecret;
  if (typeof secret !== 'string' || secret.length === 0) {
    return toJson(err('SERVICE_UNAVAILABLE', 'relay token secret not configured'));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + RELAY_TOKEN_TTL_SEC;
  const token = signRelayToken(
    nk,
    { userId, region: region.id, expSec },
    secret,
  );

  logger.info(
    'relay_token user=%s region=%s exp=%d ttlSec=%d',
    userId, region.id, expSec, RELAY_TOKEN_TTL_SEC,
  );

  const out: RelayTokenOutput = {
    token,
    relayUrl: region.relayUrl,
    expiresAt: expSec,
    regionId: region.id,
  };
  return toJson(ok(out));
};

export const relay_token: RpcHandler = relay_token_impl;