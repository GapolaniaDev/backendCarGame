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
  initializer.registerAfterAuthenticateDevice(hook);
  initializer.registerAfterAuthenticateCustom(hook);
  initializer.registerAfterAuthenticateEmail(hook);
  initializer.registerAfterAuthenticateApple(hook);
  logger.debug('garage auto-create hook installed');
}

export function autoCreateIfMissing(nk: INakama, logger: ILogger, userId: string): void {
  const existing = readGarage(nk, userId);
  if (existing) return;
  const created = defaultGarage(userId, Date.now());
  writeGarageCreate(nk, created);
  logger.info('garage auto-created via auth for %s starter=%s', userId, created.loadout?.activeCarId ?? '(none)');
}