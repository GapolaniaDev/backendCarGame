// After-auth hook: auto-create a default profile when a user first
// authenticates. Registered against every auth channel we support
// (Device, Custom, Email, Apple) so the player is never anonymous on
// the wire.
//
// Behavior:
//   - On every successful auth, look up `profiles/{userId}`. If it
//     exists, do nothing.
//   - If not, write a default profile using the catalog's
//     defaultDisplayName (e.g. "Racer"). Writes are best-effort; a
//     transient storage failure logs but does not throw — the auth
//     itself already succeeded, and `profile_get` will retry the
//     auto-create on first explicit read.

import type { IContext, ILogger, INakama, IInitializer } from '../nkruntime';
import { defaultProfile, readProfile, writeProfileCreate } from './storage';
import { getProfilesCatalog } from './catalog';

type AfterAuthEnvelope = {
  username: string;
  userId: string;
  vars: Record<string, string>;
};

export function registerProfileAutoCreate(
  initializer: IInitializer,
  nk: INakama,
  logger: ILogger,
): void {
  const hook = (
    _ctx: IContext,
    log: ILogger,
    runtime: INakama,
    env: AfterAuthEnvelope,
  ): void => {
    try {
      autoCreateIfMissing(runtime, log, env.userId);
    } catch (e) {
      log.warn(
        'profile auto-create failed for %s: %s',
        env.userId,
        e instanceof Error ? e.message : String(e),
      );
    }
  };
  // Cover every auth channel the gameships.
  initializer.registerAfterAuthenticateDevice(hook);
  initializer.registerAfterAuthenticateCustom(hook);
  initializer.registerAfterAuthenticateEmail(hook);
  initializer.registerAfterAuthenticateApple(hook);
  // `nk` and `logger` are captured for the test-only path below.
  logger.debug('profile auto-create hook installed');
  // Keep `nk` reachable from the test harness via a private property
  // on the hook so e2e tests can simulate auth without going through
  // the Go runtime.
  (hook as unknown as { __nk: INakama }).__nk = nk;
}

export function autoCreateIfMissing(nk: INakama, logger: ILogger, userId: string): void {
  const existing = readProfile(nk, userId);
  if (existing) return;
  const cat = getProfilesCatalog();
  const created = defaultProfile(userId, Date.now(), cat.defaultDisplayName);
  writeProfileCreate(nk, created);
  logger.info('profile auto-created via auth for %s', userId);
}