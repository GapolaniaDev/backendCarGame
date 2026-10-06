// Domain error codes carried inside the RPC envelope's `error.code` field.
//
// Nakama's gRPC status is always `OK` from a JS module — the runtime does
// not surface per-RPC gRPC codes from JS throws (verified in Nakama v3.27.0).
// Domain semantics ride inside the envelope.

export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INVALID_RESULT',
  'INTERNAL',
  'CATALOG_INVALID',
  'INSUFFICIENT_FUNDS',
  'SERVICE_UNAVAILABLE',
  'UPGRADE_REQUIRED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default human message per code — used by `err()` when caller doesn't supply one. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'The request was malformed or missing required fields',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Caller is not permitted to perform this action',
  NOT_FOUND: 'Requested resource does not exist',
  CONFLICT: 'The resource is in a state that does not allow this action',
  RATE_LIMITED: 'Too many requests; please slow down',
  INVALID_RESULT: 'The submitted result failed plausibility checks',
  INTERNAL: 'An unexpected server error occurred',
  CATALOG_INVALID: 'A game-data catalog failed validation at boot',
  INSUFFICIENT_FUNDS: 'Wallet balance is too low for this operation',
  SERVICE_UNAVAILABLE: 'El servidor está en mantenimiento. Vuelve pronto.',
  UPGRADE_REQUIRED: 'Tu versión del juego está desactualizada. Actualiza para continuar.',
};

/** Type guard for narrowing user input / storage payloads to a known code. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}