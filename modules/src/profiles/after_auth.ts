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
//
// Note: Nakama 3.27's JS runtime does NOT expose
// `initializer.registerAfterAuthenticateDevice` (and the 3 other
// after-auth variants). The type def in nkruntime.d.ts claims they
// exist, but in practice the methods are undefined and calling them
// crashes InitModule with "function key could not be extracted: not
// found". This is the 6th documented 3.27 JS runtime gap. We detect
// the missing methods and log a warning instead of crashing. The
// auto-create is then handled by the first `profile_get` call
// (which has its own lazy-create path), so the player is still
// never anonymous on the wire — just with one extra RPC round trip
// on the very first session.

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
  // Cover every auth channel the gameships. Each registration is
  // guarded because Nakama 3.27's JS runtime does not expose the
  // `registerAfter*Authenticate*` methods (see file header).
  // The check has to be `try { call } catch`: in 3.27 the method
  // IS a function (typeof === 'function') but the underlying Go
  // binding throws "function key could not be extracted: not found"
  // when invoked, because the runtime never wired the key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const init = initializer as any;
  let installed = 0;
  const missing: string[] = [];
  try {
    if (typeof init.registerAfterAuthenticateDevice === 'function') {
      initializer.registerAfterAuthenticateDevice(hook);
      installed += 1;
    } else {
      missing.push('device');
    }
  } catch (e) {
    missing.push('device');
    logger.warn(
      'registerAfterAuthenticateDevice threw: %s (3.27 JS gap)',
      e instanceof Error ? e.message : String(e),
    );
  }
  try {
    if (typeof init.registerAfterAuthenticateCustom === 'function') {
      initializer.registerAfterAuthenticateCustom(hook);
      installed += 1;
    } else {
      missing.push('custom');
    }
  } catch (e) {
    missing.push('custom');
    logger.warn(
      'registerAfterAuthenticateCustom threw: %s (3.27 JS gap)',
      e instanceof Error ? e.message : String(e),
    );
  }
  try {
    if (typeof init.registerAfterAuthenticateEmail === 'function') {
      initializer.registerAfterAuthenticateEmail(hook);
      installed += 1;
    } else {
      missing.push('email');
    }
  } catch (e) {
    missing.push('email');
    logger.warn(
      'registerAfterAuthenticateEmail threw: %s (3.27 JS gap)',
      e instanceof Error ? e.message : String(e),
    );
  }
  try {
    if (typeof init.registerAfterAuthenticateApple === 'function') {
      initializer.registerAfterAuthenticateApple(hook);
      installed += 1;
    } else {
      missing.push('apple');
    }
  } catch (e) {
    missing.push('apple');
    logger.warn(
      'registerAfterAuthenticateApple threw: %s (3.27 JS gap)',
      e instanceof Error ? e.message : String(e),
    );
  }
  if (missing.length > 0) {
    logger.warn(
      'registerProfileAutoCreate: %d/%d auth channels missing in this runtime (Nakama 3.27 JS gap): %s. Lazy profile_create in profile_get covers first session.',
      missing.length,
      4,
      missing.join(', '),
    );
  } else {
    logger.debug('profile auto-create hook installed (%d channels)', installed);
  }
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