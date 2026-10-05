// removePlayerFromAll — utility for player-leave / disconnect cleanup.
//
// Walks every persisted race_sessions object, and for every session
// where the player appears in the roster, marks their roster entry
// as `abandoned: true`. The entry stays in the roster so the
// close-time ordering still sees them as a DNF; only the `abandoned`
// flag flips.
//
// Idempotent: re-running the helper for the same player is a no-op
// for already-abandoned entries (the helper short-circuits when the
// entry is already marked abandoned). CAS conflict on a session
// write is logged and the helper moves on; the next call from a
// disconnect retry ( or a periodic sweep) will pick it up.
//
// Wiring: this helper is currently called only from the test
// harness to assert cleanup behavior. The disconnect hook that
// drives it at runtime lands in a later chunk (Phase 4 disconnects).

import type { ILogger, INakama } from '../nkruntime';
import { writeJson } from '../core/storage';
import type { RaceSession, RosterEntry } from './types';
import { RACE_SESSIONS_COLLECTION } from './constants';
import { SYSTEM_USER_ID } from './constants';
import type { PersistedSession } from './session_repo';

export interface RemovePlayerResult {
  /** sessionIds where the player was found and marked abandoned. */
  abandonedFrom: string[];
  /** sessionIds that were already closed (no action taken). */
  closedSessions: string[];
}

export function removePlayerFromAll(
  nk: INakama,
  logger: ILogger,
  userId: string,
): RemovePlayerResult {
  const result: RemovePlayerResult = { abandonedFrom: [], closedSessions: [] };

  const list = nk.storageList({ collection: RACE_SESSIONS_COLLECTION });
  for (const obj of list.objects) {
    const session = obj.value as unknown as RaceSession;
    if (session.state === 'closed') {
      if (session.roster.some((e) => e.userId === userId)) {
        result.closedSessions.push(session.id);
      }
      continue;
    }
    const idx = session.roster.findIndex((e) => e.userId === userId);
    if (idx === -1) continue;
    const entry = session.roster[idx];
    if (!entry) continue;
    if (entry.abandoned) {
      // Already marked — idempotent skip.
      result.abandonedFrom.push(session.id);
      continue;
    }

    const updated: RaceSession = {
      ...session,
      roster: session.roster.map((e: RosterEntry, i: number) =>
        i === idx ? { ...e, abandoned: true } : e,
      ),
      version: session.version + 1,
    };
    try {
      writeJson<PersistedSession>(nk, {
        collection: RACE_SESSIONS_COLLECTION,
        key: session.id,
        ownerId: SYSTEM_USER_ID,
        value: updated as unknown as PersistedSession,
        version: obj.version ?? '',
      });
      result.abandonedFrom.push(session.id);
      logger.info(
        'removePlayerFromAll: marked %s abandoned in session %s',
        userId,
        session.id,
      );
    } catch (e) {
      logger.warn(
        'removePlayerFromAll: CAS conflict on session %s: %s',
        session.id,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return result;
}