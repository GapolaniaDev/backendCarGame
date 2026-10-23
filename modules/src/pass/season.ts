// Battle pass season close (plan T-19; audit 06 6.5.4, 6.5.7; HT Prog-5).
//
// The pass has its OWN season (the catalog's `seasonId`, `endUtc`),
// independent from the ranked seasons.
//
// Once `endUtc` has passed the season closes for EVERY player, not only
// the one who happened to open the pass first (before T-19 the close
// flipped the caller's flag and nobody else was ever settled):
//   1. `maybeCloseSeason` writes the global marker
//      `season_close/{seasonId}` (create-only) — from `pass_get`, the
//      service ticker or `admin_pass_season_close`;
//   2. `closePassSeason` pages through every `pass` record of the season
//      and settles each one; the marker keeps the listing cursor, so a
//      close interrupted by a restart resumes where it stopped and ends
//      with `state: 'settled'`;
//   3. `settleClosedSeasonRewards` settles one record: a CAS write sets
//      `seasonClosed` and stores the levels reached but never claimed
//      (`endRewards`), which also stops any later `pass_claim`; then
//      those rewards go to the inbox as one claimable message
//      (`sendReward`, deterministic id, create-only) plus one message per
//      car; then `endRewardsSentAt` marks it done. Every step is
//      idempotent, so re-running a close never pays twice.
//
// Storage: `season_close/{seasonId}` owned by the system user, server-only.

import type { ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';
import { listStorage } from '../core/storage';
import { sendReward, type SenderPayload } from '../liveops/inbox';
import { getPassCatalog, validatePassRecord } from './catalog';
import { PASS_COLLECTION, readPassRecord, writePassUpdate } from './pass_repo';
import type { PassCatalog, PassRecord } from './types';

/** Owner may read, only the server writes (plan T-18, D-10: a client write is rejected). */
export const SERVER_OWNED_READ = 1;
export const SERVER_OWNED_WRITE = 0;

export const SEASON_CLOSE_COLLECTION = 'season_close';

export function seasonCloseKey(passSeasonId: string): string {
  return passSeasonId;
}

/** Inbox message id of a record's end-of-season rewards (currencies and cosmetics). */
export function passEndRewardId(seasonId: string): string {
  return `pass_end:${seasonId}`;
}

/** Inbox message id of one car of a record's end-of-season rewards. */
export function passEndCarRewardId(seasonId: string, carId: string): string {
  return `pass_end:${seasonId}:car:${carId}`;
}

export interface PassSeasonCloseOutcome {
  /** True iff this call wrote the close marker. */
  closed: boolean;
  passSeasonId: string;
  /** ISO UTC string of the end boundary. */
  endUtc: string;
}

/** The global close marker. `state`/`cursor`/`settled` were added by T-19. */
export interface SeasonCloseMarker {
  schemaVersion: 1;
  closedAt: number;
  state: 'settling' | 'settled';
  /** `pass` listing cursor of the next page to settle ('' = from the start). */
  cursor: string;
  /** Records settled so far. */
  settled: number;
  settledAt?: number;
}

/**
 * Return the current pass seasonId (from the loaded catalog). Throws
 * if the catalog has not been loaded yet (boot-order issue).
 */
export function getCurrentSeasonId(): string {
  return getPassCatalog().seasonId;
}

/**
 * Return `true` if `nowMs` is past the loaded catalog's `endUtc`.
 */
export function isSeasonExpired(nowMs: number): boolean {
  const cat = getPassCatalog();
  return Date.parse(cat.endUtc) <= nowMs;
}

/** The marker and its version, or null when the season has not closed. */
export function readSeasonCloseState(
  nk: INakama,
  passSeasonId: string,
): { marker: SeasonCloseMarker; version: string } | null {
  const obj = nk.storageRead([{
    collection: SEASON_CLOSE_COLLECTION,
    key: seasonCloseKey(passSeasonId),
    userId: SYSTEM_USER_ID,
  }])[0];
  if (!obj) return null;
  const v = obj.value as Partial<SeasonCloseMarker> | null;
  if (!v || v.schemaVersion !== 1 || typeof v.closedAt !== 'number') return null;
  return {
    marker: {
      schemaVersion: 1,
      closedAt: v.closedAt,
      // A pre-T-19 marker has no state: its season was never settled.
      state: v.state === 'settled' ? 'settled' : 'settling',
      cursor: typeof v.cursor === 'string' ? v.cursor : '',
      settled: typeof v.settled === 'number' ? v.settled : 0,
      ...(typeof v.settledAt === 'number' ? { settledAt: v.settledAt } : {}),
    },
    version: obj.version ?? '',
  };
}

/**
 * Read the global close marker for `passSeasonId`. Returns `null`
 * when absent. Its existence is the signal that the season is closed.
 */
export function readSeasonCloseMarker(
  nk: INakama,
  passSeasonId: string,
): { schemaVersion: 1; closedAt: number } | null {
  const state = readSeasonCloseState(nk, passSeasonId);
  return state === null ? null : { schemaVersion: 1, closedAt: state.marker.closedAt };
}

function writeMarker(nk: INakama, passSeasonId: string, marker: SeasonCloseMarker, version: string): void {
  nk.storageWrite([{
    collection: SEASON_CLOSE_COLLECTION,
    key: seasonCloseKey(passSeasonId),
    userId: SYSTEM_USER_ID,
    value: marker as unknown as Record<string, unknown>,
    permissionRead: SERVER_OWNED_READ,
    permissionWrite: SERVER_OWNED_WRITE,
    version,
  }]);
}

/** Write the marker of `passSeasonId` if absent (create-only). True when this call wrote it. */
export function openSeasonClose(nk: INakama, logger: ILogger, passSeasonId: string, nowMs: number): boolean {
  if (readSeasonCloseState(nk, passSeasonId) !== null) return false;
  try {
    writeMarker(nk, passSeasonId, { schemaVersion: 1, closedAt: nowMs, state: 'settling', cursor: '', settled: 0 }, '*');
    logger.info('pass season closed: seasonId=%s closedAtMs=%s', passSeasonId, String(nowMs));
    return true;
  } catch {
    return false; // a concurrent closer wrote it first
  }
}

/**
 * When the loaded catalog's season has ended, write its close marker
 * (once). The players are settled by `closePassSeason` (ticker, admin)
 * and, for the caller, by `pass_get`.
 */
export function maybeCloseSeason(
  nk: INakama,
  logger: ILogger,
  nowMs: number,
  passSeasonId: string,
): PassSeasonCloseOutcome {
  const endUtc = getPassCatalog().endUtc;
  if (Date.parse(endUtc) > nowMs) {
    return { closed: false, passSeasonId, endUtc };
  }
  return { closed: openSeasonClose(nk, logger, passSeasonId, nowMs), passSeasonId, endUtc };
}

// ─── Settling one record ─────────────────────────────────────────────────────

export const SETTLE_FLAG_MAX_CAS_RETRIES = 3;

/** Levels reached (xp ≥ xpRequired) and not claimed, per track. Premium only when bought. */
export function pendingLevels(catalog: Readonly<PassCatalog>, rec: PassRecord): { free: number[]; premium: number[] } {
  const free: number[] = [];
  const premium: number[] = [];
  for (const lvl of catalog.levels) {
    if (rec.xp < lvl.xpRequired) continue;
    if (!rec.claimedFree.includes(lvl.level)) free.push(lvl.level);
    if (rec.premiumPurchased && !rec.claimedPremium.includes(lvl.level)) premium.push(lvl.level);
  }
  return { free, premium };
}

/** The inbox payloads of `endRewards`: one for currencies and cosmetics, one per car. */
export function endRewardPayloads(
  catalog: Readonly<PassCatalog>,
  endRewards: { free: number[]; premium: number[] },
): { main: SenderPayload | null; cars: string[] } {
  let coins = 0;
  let gems = 0;
  const cosmetics: string[] = [];
  const cars: string[] = [];
  const add = (level: number, track: 'free' | 'premium'): void => {
    const def = catalog.levels.find((l) => l.level === level);
    if (def === undefined) return;
    const r = track === 'free' ? def.freeReward : def.premiumReward;
    coins += r.coins ?? 0;
    gems += r.gems ?? 0;
    if (r.cosmeticId !== undefined && !cosmetics.includes(r.cosmeticId)) cosmetics.push(r.cosmeticId);
    if (r.carId !== undefined && !cars.includes(r.carId)) cars.push(r.carId);
  };
  for (const l of endRewards.free) add(l, 'free');
  for (const l of endRewards.premium) add(l, 'premium');
  const main: SenderPayload | null = coins > 0 || gems > 0 || cosmetics.length > 0
    ? { coins, gems, cosmetics }
    : null;
  return { main, cars };
}

export type SettleStatus = 'no_record' | 'settled' | 'already_settled' | 'conflict';

/**
 * Settle `userId`'s record of `passSeasonId` (see the header): close the
 * record with its unclaimed levels, send them to the inbox, mark it sent.
 * Idempotent and resumable; never throws on a lost CAS.
 */
export function settleClosedSeasonRewards(
  nk: INakama,
  logger: ILogger,
  userId: string,
  passSeasonId: string,
  nowMs: number = Date.now(),
): SettleStatus {
  const catalog = getPassCatalog();
  for (let attempt = 0; attempt < SETTLE_FLAG_MAX_CAS_RETRIES; attempt += 1) {
    const existing = readPassRecord(nk, userId, passSeasonId);
    if (existing === null) return 'no_record';
    let rec = existing.record;
    let version = existing.version;
    if (rec.endRewardsSentAt !== undefined) return 'already_settled';
    try {
      if (rec.endRewards === undefined) {
        // Closing the record and fixing its rewards is one CAS: a
        // concurrent pass_claim either landed first (and is excluded) or
        // fails on the version and then sees `seasonClosed`.
        const closed: PassRecord = { ...rec, seasonClosed: true, endRewards: pendingLevels(catalog, rec) };
        version = writePassUpdate(nk, closed, version);
        rec = closed;
      }
      const endRewards = rec.endRewards as { free: number[]; premium: number[] };
      const { main, cars } = endRewardPayloads(catalog, endRewards);
      const note = `Battle pass ${passSeasonId}: levels reached but not claimed`;
      if (main !== null) sendReward(nk, userId, 'pass_season_end', { ...main, note }, passEndRewardId(passSeasonId), nowMs);
      for (const carId of cars) {
        sendReward(nk, userId, 'pass_season_end', { carId, note }, passEndCarRewardId(passSeasonId, carId), nowMs);
      }
      writePassUpdate(nk, { ...rec, endRewardsSentAt: nowMs }, version);
      logger.info(
        'pass season settled user=%s seasonId=%s free=%d premium=%d cars=%d',
        userId, passSeasonId, endRewards.free.length, endRewards.premium.length, cars.length,
      );
      return 'settled';
    } catch (e) {
      logger.warn(
        'pass settle CAS conflict user=%s seasonId=%s attempt=%d: %s',
        userId, passSeasonId, attempt + 1,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return 'conflict';
}

// ─── Settling every record ───────────────────────────────────────────────────

export interface PassSeasonCloseRun {
  seasonId: string;
  state: 'settling' | 'settled';
  /** `pass` objects read by this call. */
  scanned: number;
  /** Records of the season this call settled (or found already settled). */
  settled: number;
  /** Records left for the next run because of repeated CAS losses. */
  conflicts: number;
}

const CLOSE_PAGE = 100;

/**
 * Settle the records of `passSeasonId`, page by page, from the marker's
 * cursor, until about `maxRecords` objects were read or the listing ends
 * (then `state: 'settled'`). Opens the close when the marker is missing:
 * the caller decides whether the season may close. A page with a record
 * left in conflict is read again by the next run before the season is
 * marked settled.
 */
export function closePassSeason(
  nk: INakama,
  logger: ILogger,
  passSeasonId: string,
  nowMs: number,
  opts: { maxRecords?: number } = {},
): PassSeasonCloseRun {
  const max = Math.max(CLOSE_PAGE, Math.floor(opts.maxRecords ?? 500));
  openSeasonClose(nk, logger, passSeasonId, nowMs);
  const run: PassSeasonCloseRun = { seasonId: passSeasonId, state: 'settling', scanned: 0, settled: 0, conflicts: 0 };
  while (run.scanned < max) {
    const cur = readSeasonCloseState(nk, passSeasonId);
    if (cur === null) return run;
    if (cur.marker.state === 'settled') {
      run.state = 'settled';
      return run;
    }
    const page = listStorage(nk, { collection: PASS_COLLECTION, limit: CLOSE_PAGE, cursor: cur.marker.cursor });
    run.scanned += page.objects.length;
    let settled = 0;
    let conflicts = 0;
    for (const obj of page.objects) {
      const value = obj.value;
      if (!validatePassRecord(value) || value.seasonId !== passSeasonId) continue;
      const status = settleClosedSeasonRewards(nk, logger, value.userId, passSeasonId, nowMs);
      if (status === 'settled' || status === 'already_settled') settled += 1;
      else if (status === 'conflict') conflicts += 1;
    }
    run.settled += settled;
    run.conflicts += conflicts;
    const done = conflicts === 0 && page.cursor === '';
    const marker: SeasonCloseMarker = {
      ...cur.marker,
      cursor: conflicts > 0 ? cur.marker.cursor : page.cursor,
      settled: cur.marker.settled + settled,
      state: done ? 'settled' : 'settling',
      ...(done ? { settledAt: nowMs } : {}),
    };
    try {
      writeMarker(nk, passSeasonId, marker, cur.version);
    } catch {
      return run; // another closer moved the marker on; it continues
    }
    if (done) {
      run.state = 'settled';
      logger.info('pass season %s settled: %d record(s)', passSeasonId, marker.settled);
      return run;
    }
    if (conflicts > 0) return run;
  }
  return run;
}

/**
 * Service ticker job (plan T-19): once the loaded season has ended, open
 * its close and settle the next records; a no-op before `endUtc` and
 * after the season is settled.
 */
export function runPassSeasonTick(nk: INakama, logger: ILogger, nowMs: number): string {
  const seasonId = getPassCatalog().seasonId;
  if (!isSeasonExpired(nowMs)) return 'active';
  const state = readSeasonCloseState(nk, seasonId);
  if (state !== null && state.marker.state === 'settled') return 'settled';
  const run = closePassSeason(nk, logger, seasonId, nowMs, { maxRecords: 500 });
  return `${run.state}/settled=${run.settled}/conflicts=${run.conflicts}`;
}
