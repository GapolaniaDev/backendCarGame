// Central registry of every storage collection the server uses (plan T-16).
//
// `account_delete` walks this list (`account/purge.ts`), so a collection
// missing here would keep a deleted player's data. The test
// `tests/unit/collections_registry.test.ts` fails when a `*_COLLECTION`
// constant (or a literal collection name in a storage call) in `modules/src` is not
// registered.
//
// For every collection the purge deletes the objects OWNED by the user.
// `purge` adds the rules for objects the user does not own but that
// name them:
//   - systemKey        system-owned object whose key is derived from the user id;
//   - systemKeySuffix  system-owned objects whose key ends with a suffix of the user id;
//   - keyIsUser        objects of any owner whose key is the user id (mirror rows);
//   - valueField       objects of any owner whose `value[field]` is the user id;
//   - entries          objects of any owner whose `value[field]` array lists the
//                      user (`{userId}` entries): the entries are removed.
// `retained` says why objects that still mention the user survive.

export type PurgeRule =
  | { kind: 'systemKey'; key: (userId: string) => string }
  | { kind: 'systemKeySuffix'; suffix: (userId: string) => string }
  | { kind: 'keyIsUser' }
  | { kind: 'valueField'; field: string }
  | { kind: 'entries'; field: string };

export interface CollectionSpec {
  name: string;
  /** Module that owns the collection (its `*_COLLECTION` constant lives there). */
  module: string;
  /** Who owns the objects: the player, the system user, or both. */
  owner: 'user' | 'system' | 'mixed';
  purge: readonly PurgeRule[];
  retained?: string;
}

const userOwned = (name: string, module: string): CollectionSpec => ({ name, module, owner: 'user', purge: [] });

export const COLLECTIONS: readonly CollectionSpec[] = [
  // account
  {
    name: 'account_link_conflict', module: 'account', owner: 'system',
    purge: [{ kind: 'valueField', field: 'targetUserId' }],
  },
  // ads
  userOwned('ad_daily_count', 'ads'),
  userOwned('ad_last_watched', 'ads'),
  userOwned('ad_watch_log', 'ads'),
  // analytics
  {
    name: 'analytics_events', module: 'core/admin', owner: 'mixed', purge: [],
    retained: 'system-owned rows (audit events such as account_deleted) keep the user id in props',
  },
  // anti-cheat
  userOwned('abrupt_history', 'anti_cheat'),
  userOwned('anti_cheat_history', 'anti_cheat'),
  {
    name: 'anti_cheat_marks', module: 'anti_cheat', owner: 'system',
    purge: [{ kind: 'systemKey', key: (u) => u }],
  },
  {
    name: 'anti_cheat_stats', module: 'anti_cheat', owner: 'system', purge: [],
    retained: 'daily aggregates, no user ids',
  },
  userOwned('quorum_marks', 'anti_cheat'),
  {
    name: 'race_partials', module: 'anti_cheat', owner: 'system', purge: [],
    retained: 'per-race anti-cheat evidence keyed by race id; removed by the race cleanup',
  },
  // chat
  {
    name: 'chat_history', module: 'chat', owner: 'system',
    purge: [{ kind: 'valueField', field: 'senderUserId' }],
  },
  userOwned('chat_rate', 'chat'),
  userOwned('silenced', 'chat'),
  // clubs
  userOwned('clubs_created', 'clubs'),
  userOwned('clubs_members', 'clubs'),
  {
    name: 'clubs_metadata', module: 'clubs', owner: 'system', purge: [],
    retained: 'club documents (system-owned since T-21); account deletion first hands a led club to a successor or dissolves it (clubs/join.ts)',
  },
  {
    name: 'clubs_week_meta', module: 'clubs', owner: 'system', purge: [],
    retained: 'per-club weekly totals',
  },
  {
    name: 'clubs_week_reset', module: 'clubs', owner: 'system', purge: [],
    retained: 'per-week reset markers (the rewarded user ids are an audit trail)',
  },
  // economy
  userOwned('idem', 'core/idempotency'),
  // garage
  userOwned('garage', 'garage'),
  // iap
  {
    name: 'iap_fraud_flags', module: 'iap', owner: 'system', purge: [],
    retained: 'fraud evidence keyed by transaction id',
  },
  userOwned('iap_first_purchase', 'iap'),
  userOwned('iap_purchases', 'iap'),
  userOwned('iap_subscriptions', 'iap'),
  // liveops
  userOwned('abandons', 'liveops'),
  userOwned('inbox', 'liveops'),
  {
    name: 'liveops', module: 'liveops', owner: 'system', purge: [],
    retained: 'LiveOps config document',
  },
  {
    name: 'liveops_config', module: 'liveops', owner: 'system', purge: [],
    retained: 'matchmaker config document',
  },
  // Legacy reward inbox (before plan T-17), migrated into `inbox` at boot.
  userOwned('liveops_inbox', 'liveops'),
  {
    name: 'migrations', module: 'liveops', owner: 'system', purge: [],
    retained: 'one-shot migration markers',
  },
  // missions
  userOwned('achievements', 'missions'),
  userOwned('first_win_today', 'missions'),
  userOwned('missions_daily', 'missions'),
  userOwned('missions_weekly', 'missions'),
  // moderation
  {
    name: 'reports', module: 'moderation', owner: 'system', purge: [],
    retained: 'moderation reports keyed by report id',
  },
  userOwned('reports_rate', 'moderation'),
  userOwned('reports_recent', 'moderation'),
  // parties
  userOwned('active_party', 'parties'),
  {
    name: 'parties', module: 'parties', owner: 'system', purge: [],
    retained: 'short-lived party documents; account deletion first takes the user out of their party (parties_repo.ts)',
  },
  // pass
  userOwned('pass', 'pass'),
  userOwned('pass_xp_ledger', 'pass'),
  {
    name: 'season_close', module: 'pass', owner: 'system', purge: [],
    retained: 'per-season close markers',
  },
  // profiles
  userOwned('profiles', 'profiles'),
  // race
  {
    name: 'race_active', module: 'race', owner: 'system',
    purge: [{ kind: 'systemKey', key: (u) => u }],
  },
  {
    name: 'race_open', module: 'race', owner: 'system', purge: [],
    retained: 'index of open session ids',
  },
  {
    name: 'race_presence', module: 'race', owner: 'system',
    purge: [{ kind: 'systemKeySuffix', suffix: (u) => `/${u}` }],
  },
  {
    // Reports are owned by their reporter; session documents keep the
    // roster entry, marked abandoned by `removePlayerFromAll`.
    name: 'race_sessions', module: 'race', owner: 'mixed',
    purge: [{ kind: 'systemKey', key: (u) => `last_closed/${u}` }],
    retained: 'race session documents keep the roster entry (marked abandoned)',
  },
  // ranked
  userOwned('ranked', 'ranked'),
  {
    name: 'ranked_progress', module: 'ranked', owner: 'system', purge: [],
    retained: 'per-session apply markers',
  },
  {
    name: 'ranked_seasons_meta', module: 'ranked', owner: 'system', purge: [],
    retained: 'season documents',
  },
  // scheduler
  {
    name: 'system_locks', module: 'scheduler', owner: 'system', purge: [],
    retained: 'tick locks',
  },
  // social
  { name: 'blocks', module: 'social', owner: 'user', purge: [{ kind: 'keyIsUser' }] },
  userOwned('friends_code', 'social'),
  { name: 'friends_edge', module: 'social', owner: 'user', purge: [{ kind: 'keyIsUser' }] },
  { name: 'invites', module: 'social', owner: 'user', purge: [{ kind: 'valueField', field: 'fromUserId' }] },
  { name: 'recent_rivals', module: 'social', owner: 'user', purge: [{ kind: 'entries', field: 'entries' }] },
  // tournaments
  userOwned('tournament_entries', 'tournaments'),
  {
    name: 'tournament_instances', module: 'tournaments', owner: 'system', purge: [],
    retained: 'tournament documents',
  },
  {
    name: 'tournament_leaderboard', module: 'tournaments', owner: 'system',
    purge: [{ kind: 'entries', field: 'entries' }],
  },
];

export const COLLECTION_NAMES: ReadonlySet<string> = new Set(COLLECTIONS.map((c) => c.name));
