// Full account deletion (plan T-16), shared by `account_delete` and by
// `account_link_resolve_conflict` (the conflicting account is deleted).
//
//   1. Mark the user abandoned in their race sessions (DNF at close).
//   2. Purge storage through the collection registry (`purge.ts`).
//   3. Remove their leaderboard records.
//   4. `nk.accountDeleteId`: the account row, its identities (which frees
//      them for a re-link), friends, group memberships (a group left
//      without a superadmin is deleted), wallet ledger and the rest of
//      the Postgres cascade.

import type { ILogger, INakama } from '../nkruntime';
import { err, ok, type Resp } from '../core/response';
import { listStorage } from '../core/storage';
import { removePlayerFromAll } from '../race/remove_player';
import { CLUBS_CREATED_COLLECTION } from '../clubs/types';
import { linkedProviders } from './identities';
import { purgeFromLeaderboards, purgeUserStorage } from './purge';
import type { AccountDeleteSummary } from './types';

export function deleteAccount(nk: INakama, logger: ILogger, userId: string): Resp<AccountDeleteSummary> {
  const providers = linkedProviders(nk, userId) ?? [];
  const createdClubs = listStorage(nk, { collection: CLUBS_CREATED_COLLECTION, userId, limit: 100 })
    .objects
    .map((o) => (o.value as { clubId?: unknown }).clubId)
    .filter((id): id is string => typeof id === 'string');

  const removed = removePlayerFromAll(nk, logger, userId);
  const purge = purgeUserStorage(nk, logger, userId);
  const boards = purgeFromLeaderboards(nk, logger, userId);

  try {
    nk.accountDeleteId(userId, false);
  } catch (e) {
    logger.error(
      'account delete: accountDeleteId(%s) failed: %s',
      userId, e instanceof Error ? e.message : String(e),
    );
    return err('INTERNAL', 'failed to delete account');
  }

  logger.warn(
    'account deleted user=%s storage=%d refs=%d boards=%d abandoned=%d linked=%j',
    userId, purge.storageDeleted, purge.referencesRemoved, boards.boardsDeleted,
    removed.abandonedFrom.length, providers,
  );
  return ok({
    storageDeleted: purge.storageDeleted,
    collectionsAffected: purge.collectionsAffected,
    referencesRemoved: purge.referencesRemoved,
    boardsDeleted: boards.boardsDeleted,
    boardsAffected: boards.boardsAffected,
    unlinkedAuths: providers,
    wasClubLeaderOf: createdClubs,
    abandonedFromRaces: removed.abandonedFrom.length,
  });
}
