// Phase 8 Chunk 8 — Events scanner.
//
// `runEventScannerTick` walks every profile and reconciles
// `profile.activeSpecialOffers` with the events catalog. The service
// ticker (scheduler/service_ticker.ts) calls it every 5 min.
// The field is a derived cache the `store_get` pricing layer reads to
// decide whether a `special_offer` discount applies.
//
// Why a scanner and not a one-shot read? The catalog is in-process and
// static; the field needs to be present on profiles written BEFORE
// the event window started (so a player can see a discount they
// already qualify for without the client having to refresh and
// re-issue the RPC). The scanner runs forever, idempotent, so a
// re-tick is a no-op when nothing changed.
//
// Best-effort: every storage call is wrapped in try/catch. A failure
// on one profile does not stop the loop.

import type { ILogger, INakama } from '../nkruntime';
import { activeEvents } from '../core/active_events';
import {
  readProfile,
  writeProfileUpdate,
  type ProfileRecord,
} from '../profiles/storage';
import { listStorage } from '../core/storage';

/** Maximum number of `activeSpecialOffers` IDs we store on a profile. */
export const ACTIVE_SPECIAL_OFFERS_CAP = 10;

export interface EventScannerDeps {
  logger: ILogger;
  nk: INakama;
  /** Override `Date.now()` for deterministic tests. */
  nowFn?: () => number;
}

/**
 * Compute the desired `activeSpecialOffers` list for `nowUtc`. Pure
 * helper — exported for tests.
 */
export function resolveActiveSpecialOfferIds(nowUtc: number): string[] {
  const live = activeEvents(nowUtc);
  const out: string[] = [];
  for (const e of live) {
    if (e.kind !== 'special_offer') continue;
    if (out.includes(e.id)) continue;
    out.push(e.id);
    if (out.length >= ACTIVE_SPECIAL_OFFERS_CAP) break;
  }
  // activeEvents already returns them sorted by endsAt ascending;
  // the `include` guard dedupes the (extremely unlikely) case where
  // two events share an id.
  return out;
}

/**
 * One pass: list every profile row, reconcile `activeSpecialOffers`
 * with the catalog, CAS-write when the value changes. Exposed for unit
 * tests. Uses `listStorage` (core/storage.ts) to walk the
 * collection.
 */
export function runEventScannerTick(deps: EventScannerDeps): {
  scanned: number;
  updated: number;
  desired: string[];
} {
  const { logger, nk } = deps;
  const nowUtc = (deps.nowFn ?? Date.now)();
  const desired = resolveActiveSpecialOfferIds(nowUtc);

  // 1-arg storageList walks the whole collection; profiles live in
  // their own collection so this stays bounded by player count.
  const objs = listStorage(nk, { collection: 'profiles', limit: 5000 });
  let updated = 0;
  for (const o of objs.objects) {
    if (updated % 50 === 0) {
      // Yield-free checkpoint — the goja runtime is single-threaded so
      // we just keep the logger calm across long sweeps.
    }
    try {
      const value = o.value as Partial<ProfileRecord>;
      if (!value || typeof value.userId !== 'string') continue;
      const current = (value.activeSpecialOffers ?? []) as string[];
      if (sameSet(current, desired)) continue;
      const next: ProfileRecord = {
        schemaVersion: 1,
        userId: value.userId,
        displayName: value.displayName ?? '',
        avatarUrl: value.avatarUrl ?? null,
        createdAt: value.createdAt ?? nowUtc,
        updatedAt: nowUtc,
        ...(value.progression !== undefined ? { progression: value.progression } : {}),
        ...(value.dailyPrivateCount !== undefined ? { dailyPrivateCount: value.dailyPrivateCount } : {}),
        ...(value.dailyResetAt !== undefined ? { dailyResetAt: value.dailyResetAt } : {}),
        ...(value.accountLinkBonusClaimed !== undefined
          ? { accountLinkBonusClaimed: value.accountLinkBonusClaimed }
          : {}),
        activeSpecialOffers: desired,
      };
      // Re-read to get the version token (storageList returns objects
      // without a stable version on every backend). If the
      // version-less write fails, the next tick will retry.
      const live = readProfile(nk, value.userId);
      if (!live) continue;
      try {
        writeProfileUpdate(nk, next, o.version || '');
        updated += 1;
      } catch (e) {
        logger.warn(
          'event scanner CAS conflict uid=%s: %s — will retry next tick',
          value.userId,
          e instanceof Error ? e.message : String(e),
        );
      }
    } catch (e) {
      logger.error(
        'event scanner profile update failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  if (objs.objects.length > 0) {
    logger.info(
      'event scanner tick scanned=%d updated=%d desired=%d',
      objs.objects.length,
      updated,
      desired.length,
    );
  }
  return { scanned: objs.objects.length, updated, desired };
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}
