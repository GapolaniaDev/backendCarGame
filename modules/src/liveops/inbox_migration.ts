// One-shot boot migration of the legacy `liveops_inbox` into `inbox`
// (plan T-17).
//
// Entries the old `sendReward` wrote there were never readable:
//   - ranked season rewards were never paid (the season close only wrote
//     the entry), so they become claimable rewards. Their payload is
//     rebuilt from the rank in the reward id (`<season>-rank-<n>`) with
//     the season tier table, so the amount does not come from the object;
//   - everything else was paid when it was sent, so it becomes a notice.
// Each entry is written with the same id (idempotent) and the legacy
// object is deleted. A marker (`migrations/inbox_v1`, system user) makes
// the migration run once: `liveops_inbox` objects created afterwards (a
// client can create objects in any collection) are never migrated.

import type { ILogger, INakama, IStorageObject } from '../nkruntime';
import { listStorage } from '../core/storage';
import { SYSTEM_USER_ID } from '../race/constants';
import { payloadForTier, tierForRank } from '../ranked/season';
import type { InboxEntry, InboxRewardType } from '../ranked/types';
import { inboxTitle, LEGACY_INBOX_COLLECTION, sendReward, sendNotice } from './inbox';
import { sendInbox } from './messages';

export const MIGRATIONS_COLLECTION = 'migrations';
export const INBOX_MIGRATION_KEY = 'inbox_v1';
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;

export interface InboxMigrationResult {
  rewards: number;
  notices: number;
  skipped: number;
}

/** Returns `null` when the marker says the migration already ran. */
export function migrateLegacyInbox(nk: INakama, logger: ILogger, nowMs: number): InboxMigrationResult | null {
  const marker = nk.storageRead([{ collection: MIGRATIONS_COLLECTION, key: INBOX_MIGRATION_KEY, userId: SYSTEM_USER_ID }]);
  if (marker.length > 0) return null;

  const legacy: IStorageObject[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = listStorage(nk, { collection: LEGACY_INBOX_COLLECTION, limit: PAGE_LIMIT, cursor });
    legacy.push(...res.objects);
    cursor = res.cursor;
    if (cursor === '') break;
  }

  const result: InboxMigrationResult = { rewards: 0, notices: 0, skipped: 0 };
  for (const obj of legacy) {
    const owner = obj.userId ?? '';
    const entry = obj.value as Partial<InboxEntry>;
    if (owner.length === 0 || typeof entry.rewardId !== 'string' || typeof entry.type !== 'string') {
      result.skipped += 1;
      logger.warn('inbox migration: skipped malformed %s/%s', LEGACY_INBOX_COLLECTION, obj.key);
    } else {
      migrateEntry(nk, owner, entry as InboxEntry, nowMs, result);
    }
    nk.storageDelete([{ collection: LEGACY_INBOX_COLLECTION, key: obj.key, userId: owner }]);
  }

  nk.storageWrite([{
    collection: MIGRATIONS_COLLECTION,
    key: INBOX_MIGRATION_KEY,
    userId: SYSTEM_USER_ID,
    value: { migratedAt: nowMs, ...result },
    permissionRead: 0,
    permissionWrite: 0,
  }]);
  logger.info('inbox migration: %d rewards, %d notices, %d skipped', result.rewards, result.notices, result.skipped);
  return result;
}

const SEASON_TYPES: ReadonlySet<InboxRewardType> = new Set(['season_gold', 'season_silver', 'season_bronze']);

function migrateEntry(nk: INakama, userId: string, entry: InboxEntry, nowMs: number, out: InboxMigrationResult): void {
  // Retention (30 days) starts at the migration, not at the legacy send.
  const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : nowMs;
  const payload = entry.payload ?? {};
  if (entry.claimed === true) {
    sendInbox(nk, userId, {
      id: entry.rewardId, kind: 'system', title: inboxTitle(entry.type), body: payload.note ?? '',
      source: entry.type, claimedAt: createdAt,
    }, nowMs);
    out.notices += 1;
    return;
  }
  const rank = /-rank-(\d+)$/.exec(entry.rewardId);
  const tier = rank !== null ? tierForRank(Number(rank[1])) : null;
  if (SEASON_TYPES.has(entry.type) && tier !== null && payloadForTier(tier).type === entry.type) {
    sendReward(nk, userId, entry.type, payloadForTier(tier).payload, entry.rewardId, nowMs);
    out.rewards += 1;
    return;
  }
  sendNotice(nk, userId, entry.type, payload, entry.rewardId, nowMs);
  out.notices += 1;
}
