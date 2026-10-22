// Storage lease that keeps two periodic ticks from running at the same
// time (plan card T-03, decision D-06). Today one `service_ticker` match
// runs per Nakama process, but a second node, a restart that overlaps
// the old match, or an operator-triggered tick must not double-pay
// tournament prizes or subscription grants.
//
// The lease is one server-owned storage object per name. Acquiring it is
// a conditional write on the version that was read (or `*` = "must not
// exist"), so of two concurrent writers exactly one succeeds. A lease
// expires on its own after `ttlMs`, so a crashed holder never blocks the
// scheduler for longer than that.

import type { INakama } from '../nkruntime';

export const TICK_LOCK_COLLECTION = 'system_locks';
/** Nakama's nil user id: the owner of server-only objects. */
export const TICK_LOCK_OWNER_ID = '00000000-0000-0000-0000-000000000000';

interface LeaseValue {
  schemaVersion: 1;
  holder: string;
  untilMs: number;
}

/**
 * Try to take the lease `name` for `ttlMs`. Returns true when this caller
 * now holds it. Never throws: storage errors count as "not acquired".
 */
export function tryAcquireTickLock(
  nk: INakama,
  name: string,
  holder: string,
  nowMs: number,
  ttlMs: number,
): boolean {
  let version = '*';
  try {
    const rows = nk.storageRead([
      { collection: TICK_LOCK_COLLECTION, key: name, userId: TICK_LOCK_OWNER_ID },
    ]);
    const cur = rows && rows[0];
    if (cur) {
      const v = cur.value as Partial<LeaseValue>;
      if (typeof v.untilMs === 'number' && v.untilMs > nowMs && v.holder !== holder) {
        return false;
      }
      version = cur.version ?? '*';
    }
    const value: LeaseValue = { schemaVersion: 1, holder, untilMs: nowMs + ttlMs };
    nk.storageWrite([
      {
        collection: TICK_LOCK_COLLECTION,
        key: name,
        userId: TICK_LOCK_OWNER_ID,
        value: value as unknown as Record<string, unknown>,
        version,
        permissionRead: 0,
        permissionWrite: 0,
      },
    ]);
    return true;
  } catch {
    // Version conflict (someone else acquired it first) or storage error.
    return false;
  }
}

/** Release the lease early if `holder` still owns it. Best-effort. */
export function releaseTickLock(nk: INakama, name: string, holder: string): void {
  try {
    const rows = nk.storageRead([
      { collection: TICK_LOCK_COLLECTION, key: name, userId: TICK_LOCK_OWNER_ID },
    ]);
    const cur = rows && rows[0];
    if (!cur || !cur.version || (cur.value as Partial<LeaseValue>).holder !== holder) return;
    const value: LeaseValue = { schemaVersion: 1, holder, untilMs: 0 };
    nk.storageWrite([
      {
        collection: TICK_LOCK_COLLECTION,
        key: name,
        userId: TICK_LOCK_OWNER_ID,
        value: value as unknown as Record<string, unknown>,
        version: cur.version,
        permissionRead: 0,
        permissionWrite: 0,
      },
    ]);
  } catch {
    // The lease expires on its own.
  }
}
