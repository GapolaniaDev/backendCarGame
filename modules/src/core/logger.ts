// Logger helpers. Every RPC entry/exit should include the sessionId in
// the log line so operators can correlate logs for a single race.

import type { ILogger } from '../nkruntime';

/**
 * Returns a logger with the `[session=<sessionId>]` structured field
 * attached so every emitted line is correlatable. Pass `null` for the
 * RPC-level case where no session exists yet (e.g. `config_get`).
 */
export function withSession(logger: ILogger, sessionId: string | null): ILogger {
  if (sessionId === null) return logger;
  return logger.withField('%s', 'session', sessionId);
}

/** Log RPC entry; emits `info` with the RPC name and (optional) sessionId. */
export function logRpcEntry(logger: ILogger, rpcName: string, sessionId: string | null): void {
  if (sessionId === null) {
    logger.info('rpc %s entry', rpcName);
  } else {
    logger.withField('%s', 'rpc', rpcName).info('rpc entry');
  }
}

/** Log RPC exit; emits `info` with duration and (optional) sessionId. */
export function logRpcExit(logger: ILogger, rpcName: string, sessionId: string | null, startedAt: number, okFlag: boolean): void {
  const ms = Date.now() - startedAt;
  const tag = okFlag ? 'ok' : 'err';
  if (sessionId === null) {
    logger.info('rpc %s exit [%s] %dms', rpcName, tag, ms);
  } else {
    logger
      .withField('%s', 'rpc', rpcName)
      .withField('%s', 'outcome', tag)
      .info('rpc exit %dms', ms);
  }
}