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
// Wired through `account/after_auth.ts`; the lazy-create in
// `garage_get` still covers any user created before the hook existed.

import type { ILogger, INakama } from '../nkruntime';
import { defaultGarage, readGarage, writeGarageCreate } from './storage';

export function autoCreateIfMissing(nk: INakama, logger: ILogger, userId: string): void {
  const existing = readGarage(nk, userId);
  if (existing) return;
  const created = defaultGarage(userId, Date.now());
  writeGarageCreate(nk, created);
  logger.info('garage auto-created via auth for %s starter=%s', userId, created.loadout?.activeCarId ?? '(none)');
}