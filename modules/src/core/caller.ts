// Caller identity for player RPCs (plan decision D-03; audit PC-01, N2,
// N6, X2-c).
//
// The calling user comes ONLY from the session: `ctx.userId`, which
// Nakama 3.27 fills for every Bearer (HTTP) and socket call (verified
// live, audit N1). Body identity fields — `callerUserId` and, on a few
// race RPCs, `hostUserId` / `userId` — are still accepted so existing
// clients keep working (D-05), but they are only a cross-check:
//   - no `ctx.userId`              → UNAUTHENTICATED (e.g. an `http_key`
//                                    call; only `admin_*` RPCs, which
//                                    carry their own secret, run that way)
//   - field present and different  → FORBIDDEN
//   - field absent or empty        → the session user
// The body is never a fallback identity.

import type { IContext } from '../nkruntime';
import { err, type Err } from './response';

export type CallerCheck =
  | { ok: true; userId: string }
  | { ok: false; error: Err };

/** Body fields checked when the caller passes none explicitly. */
export const DEFAULT_IDENTITY_FIELDS: readonly string[] = ['callerUserId'];

/**
 * Resolve the calling user from `ctx.userId`, cross-checking the given
 * identity `fields` of the parsed request `body` (if any).
 */
export function requireCaller(
  ctx: IContext | null | undefined,
  body?: unknown,
  fields: readonly string[] = DEFAULT_IDENTITY_FIELDS,
): CallerCheck {
  const sessionUser = ctx?.userId;
  if (typeof sessionUser !== 'string' || sessionUser.length === 0) {
    return { ok: false, error: err('UNAUTHENTICATED', 'a session (Bearer token) is required') };
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>;
    for (const field of fields) {
      const declared = raw[field];
      if (declared === undefined || declared === null || declared === '') continue;
      if (typeof declared !== 'string') {
        return { ok: false, error: err('BAD_REQUEST', `${field} must be a string when present`) };
      }
      if (declared !== sessionUser) {
        return { ok: false, error: err('FORBIDDEN', `${field} does not match the session user`) };
      }
    }
  }
  return { ok: true, userId: sessionUser };
}

/**
 * `requireCaller` for handlers that return serialized envelopes: same
 * check, with the error already JSON-stringified so the handler can
 * `return caller.error` directly.
 */
export function requireCallerId(
  ctx: IContext | null | undefined,
  body?: unknown,
  fields: readonly string[] = DEFAULT_IDENTITY_FIELDS,
): { ok: true; id: string } | { ok: false; error: string } {
  const c = requireCaller(ctx, body, fields);
  return c.ok ? { ok: true, id: c.userId } : { ok: false, error: JSON.stringify(c.error) };
}
