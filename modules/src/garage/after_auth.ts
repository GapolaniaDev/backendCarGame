// After-auth hook: grant the starter car on first authentication.
// Mirrors `profiles/after_auth.ts` — registered against every auth
// channel (Device, Custom, Email, Apple) so the player always has a
// usable loadout the moment they sign in.
//
// Behavior:
//   - On every successful auth, look up `garage/{userId}`. If it
//     exists, do nothing.
//   - If not, seed a default garage (starter car active, zero
//     upgrades, empty cosmetics, daily counters zeroed).
//   - Writes are best-effort; a transient storage failure logs but
//     does not throw — `garage_get` will retry the auto-create on
//     first explicit read.
//
// Note: Same 3.27 JS runtime gap as `profiles/after_auth.ts` — the
// `registerAfter*Authenticate*` methods are not exposed. We guard
// each registration; the lazy-create in `garage_get` covers the
// first session.

import type { IContext, ILogger, INakama, IInitializer } from '../nkruntime';
import { defaultGarage, readGarage, writeGarageCreate } from './storage';

type AfterAuthEnvelope = {
  username: string;
  userId: string;
  vars: Record<string, string>;
};

export function registerGarageAutoCreate(
  initializer: IInitializer,
  _nk: INakama,
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
        'garage auto-create failed for %s: %s',
        env.userId,
        e instanceof Error ? e.message : String(e),
      );
    }
  };
  // See `profiles/after_auth.ts` for the 3.27 JS gap explanation.
  // Each registration is wrapped in try/catch because in 3.27 the
  // method IS a function but the Go binding throws on call.
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
      'registerGarageAutoCreate: %d/%d auth channels missing in this runtime (Nakama 3.27 JS gap): %s. Lazy garage_create in garage_get covers first session.',
      missing.length,
      4,
      missing.join(', '),
    );
  } else {
    logger.debug('garage auto-create hook installed (%d channels)', installed);
  }
}

export function autoCreateIfMissing(nk: INakama, logger: ILogger, userId: string): void {
  const existing = readGarage(nk, userId);
  if (existing) return;
  const created = defaultGarage(userId, Date.now());
  writeGarageCreate(nk, created);
  logger.info('garage auto-created via auth for %s starter=%s', userId, created.loadout?.activeCarId ?? '(none)');
}