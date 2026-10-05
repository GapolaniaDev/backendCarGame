// Race RPC handlers (Phase 1).
//
// Each handler is exported as a top-level function AND registered in
// `raceRpcs` for tests. Nakama's goja runtime looks each RPC function
// up by NAME on the global object after InitModule returns — so the
// registration call in main.ts must reference the same identifier
// that the function is bound to. (Verified against v3.27.0 source:
// server/runtime_javascript_init.go `checkFnScope`.)

import { err } from '../core/response';
import type { IContext, ILogger, INakama } from '../nkruntime';

export type RpcHandler = (
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  payload: string,
) => string;

function makeStub(name: string): RpcHandler {
  return (_ctx, logger, _nk, payload): string => {
    logger.info('rpc %s (stub) called payload=%s', name, payload);
    return JSON.stringify(err('INTERNAL', `TODO: ${name} not implemented yet`));
  };
}

// Top-level function declarations — these are the names the goja
// runtime will look up on globalThis after InitModule runs. They are
// re-exported via the `raceRpcs` map so unit tests can invoke them
// without going through Nakama.

export const config_get = makeStub('config_get');
export const race_session_create = makeStub('race_session_create');
export const race_session_join = makeStub('race_session_join');
export const race_session_start = makeStub('race_session_start');
export const race_session_get = makeStub('race_session_get');
export const race_submit_result = makeStub('race_submit_result');

/**
 * Stable name→handler map for tests and the registration loop in
 * main.ts. The keys here MUST match the global function names above.
 */
export const raceRpcs: Readonly<Record<string, RpcHandler>> = Object.freeze({
  config_get,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_submit_result,
});

export const RACE_RPC_KEYS: readonly string[] = Object.freeze(Object.keys(raceRpcs));