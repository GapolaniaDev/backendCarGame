// Phase 5 Chunk 8 — Node role (home / relay).
//
// `home` is the canonical Nakama deployment where the full game surface
// (wallet, garage, store, profile, account, admin, liveops) is
// registered. `relay` is a region-scoped replica that only exposes
// the match + race primitives (race_session_get, race_submit_result)
// so the latency-sensitive race loop stays close to the player.
//
// The role is configured per node via `liveops_config.nodeRole` —
// `process.env.NODE_ROLE` is NOT an option because the JS runtime
// strips `process.env` (esbuild `--platform=neutral`). Bootstrap path:
// ops runs `liveops_config_override` on the relay replica after boot.
//
// `loadLiveopsConfig` re-reads storage on every call, so the admin can
// flip a node's role at runtime without a restart.

import type { ILogger, INakama } from '../nkruntime';
import { loadLiveopsConfig } from '../liveops/config';

export type NodeRole = 'home' | 'relay';

/**
 * Returns `true` when the current node should expose the full game
 * surface (or is unset / misconfigured — `nodeRole` defaults to
 * `'home'`).
 */
export function isHome(nk: INakama, logger?: ILogger): boolean {
  const cfg = loadLiveopsConfig(nk, logger);
  return cfg.nodeRole !== 'relay';
}

/** Inverse of `isHome`. */
export function isRelay(nk: INakama, logger?: ILogger): boolean {
  return !isHome(nk, logger);
}