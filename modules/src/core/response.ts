// Canonical RPC response envelope: { ok, data } on success, { ok: false, error } on failure.
//
// Every RPC MUST return a JSON-stringified envelope. Domain errors are
// conveyed via `error.code`, not via thrown exceptions, because the JS
// runtime cannot surface custom gRPC codes in v3.27.0.

import { ERROR_MESSAGES, type ErrorCode } from './errors';

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: { code: ErrorCode; message: string; details?: unknown };
}

export type Resp<T> = Ok<T> | Err;

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data });

export function err(
  code: ErrorCode,
  message?: string,
  details?: unknown,
): Err {
  const finalMessage: string = message ?? ERROR_MESSAGES[code];
  const base: Err = { ok: false, error: { code, message: finalMessage } };
  if (details !== undefined) {
    base.error.details = details;
  }
  return base;
}

/** Convenience: build a JSON-stringified envelope in one step. */
export const toJson = <T>(resp: Resp<T>): string => JSON.stringify(resp);