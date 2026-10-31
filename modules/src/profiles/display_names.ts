// Visible player names for social lists (plan B2, D-03).
//
// Friends, recent rivals and blocks only knew user ids; the client needs the
// name it shows. Same rule as the leaderboard rows: profile display name,
// else the account username, else the id.

import type { ILogger, INakama } from '../nkruntime';
import { usernamesById } from '../leaderboards/usernames';
import { PROFILES_COLLECTION } from './storage';

/**
 * userId → the name the client shows (plan B2, D-03): the profile displayName when it is a
 * non-empty string, else the account username, else the user id. One `storageRead` of
 * `profiles` and one `usersGetId` for the ids still missing; a failed read is logged at
 * warn and falls through to the next rule. Every requested non-empty id is in the map.
 */
export function displayNamesById(
  logger: ILogger,
  nk: INakama,
  userIds: ReadonlyArray<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (ids.length === 0) return out;

  try {
    const objs = nk.storageRead(ids.map((id) => ({ collection: PROFILES_COLLECTION, key: id, userId: id })));
    for (const obj of objs ?? []) {
      const name = (obj?.value as { displayName?: unknown } | null | undefined)?.displayName;
      if (obj && ids.includes(obj.userId) && typeof name === 'string' && name.trim().length > 0) {
        out.set(obj.userId, name);
      }
    }
  } catch (e) {
    logger.warn(
      'display name profile read failed for %d ids: %s',
      ids.length,
      e instanceof Error ? e.message : String(e),
    );
  }

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const usernames = usernamesById(logger, nk, missing);
    for (const id of missing) out.set(id, usernames.get(id) ?? id);
  }
  return out;
}
