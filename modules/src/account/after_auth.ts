// After-auth hook shared by every auth channel (Device, Custom, Email,
// Apple). Seeds the default profile and the starter garage on first
// sign-in.
//
// Nakama 3.27 allows one after-hook per API and its AST scanner only
// accepts hooks registered as top-level statements of `InitModule`
// whose argument is a global function identifier, so `main.ts`
// registers this single function four times
// (`registerAfterAuthenticateDevice(afterAuthenticateAutoCreate)`, …).
//
// The authenticated user id arrives on `ctx.userId`; the third
// argument is the outgoing session, which carries no user id.
// Every step is best-effort: the auth already succeeded, and
// `profile_get` / `garage_get` lazily create anything missing.

import type { IContext, ILogger, INakama } from '../nkruntime';
import { autoCreateIfMissing as autoCreateProfileIfMissing } from '../profiles/after_auth';
import { autoCreateIfMissing as autoCreateGarageIfMissing } from '../garage/after_auth';

export function afterAuthenticateAutoCreate(
  ctx: IContext,
  logger: ILogger,
  nk: INakama,
  _data?: unknown,
  _request?: unknown,
): void {
  const userId = ctx?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    logger.warn('after-auth auto-create skipped: ctx.userId missing');
    return;
  }
  try {
    autoCreateProfileIfMissing(nk, logger, userId);
  } catch (e) {
    logger.warn(
      'profile auto-create failed for %s: %s',
      userId,
      e instanceof Error ? e.message : String(e),
    );
  }
  try {
    autoCreateGarageIfMissing(nk, logger, userId);
  } catch (e) {
    logger.warn(
      'garage auto-create failed for %s: %s',
      userId,
      e instanceof Error ? e.message : String(e),
    );
  }
}
