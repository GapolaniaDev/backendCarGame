// Account usernames for leaderboard records (audit HT-65: every server
// write passed `username: ''`, which Nakama stores as NULL, so the
// native `ListLeaderboardRecords` the Unity client uses showed no names).
//
// Writers pass the owner's username on every record write (Nakama keeps
// the previous one when it gets an empty string); `lb_get` fills the
// records written before this fix from the same lookup.

import type { ILogger, INakama } from '../nkruntime';

/**
 * userId → username for the given ids (one `usersGetId` call). Ids the
 * runtime does not know are missing from the map; a failed lookup is
 * logged and yields an empty map, so a write never fails for a name.
 */
export function usernamesById(
  logger: ILogger,
  nk: INakama,
  userIds: ReadonlyArray<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (ids.length === 0) return out;
  try {
    for (const u of nk.usersGetId(ids) ?? []) {
      if (u && typeof u.userId === 'string' && typeof u.username === 'string' && u.username.length > 0) {
        out.set(u.userId, u.username);
      }
    }
  } catch (e) {
    logger.warn(
      'leaderboard username lookup failed for %d ids: %s',
      ids.length,
      e instanceof Error ? e.message : String(e),
    );
  }
  return out;
}
