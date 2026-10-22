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
// Wired through `account/after_auth.ts` (one hook per auth channel
// registered at the top level of `InitModule`). The lazy-create in
// `profile_get` still covers any user created before the hook existed.

import type { ILogger, INakama } from '../nkruntime';
import { defaultProfile, readProfile, writeProfileCreate } from './storage';
import { getProfilesCatalog } from './catalog';

export function autoCreateIfMissing(nk: INakama, logger: ILogger, userId: string): void {
  const existing = readProfile(nk, userId);
  if (existing) return;
  const cat = getProfilesCatalog();
  const created = defaultProfile(userId, Date.now(), cat.defaultDisplayName);
  writeProfileCreate(nk, created);
  logger.info('profile auto-created via auth for %s', userId);
}