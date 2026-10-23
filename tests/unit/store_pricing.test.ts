// store_get / store_buy pricing (plan T-12; audit PC-20, 05 f20; HT-74,
// HT-80). Runs the TypeScript handlers against the 3.27-faithful fake
// runtime with a test events catalog, because the bundled special offers
// all name SKUs that are not store offers (and are dropped at load).

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeLogger, FakeNakama } from '../e2e/_stubs';
import { ensureRuntimeState } from '../../modules/src/core/runtime_state';
import { getEventsCatalog, loadEventsCatalog } from '../../modules/src/core/active_events';
import { getStoreCatalog } from '../../modules/src/store/catalog';
import { store_buy_impl, store_get_impl } from '../../modules/src/store/rpcs';
import { LIVEOPS_STORAGE_KEY, loadLiveopsConfig } from '../../modules/src/liveops/config';
import eventsJson from '../../modules/src/catalogs/events.json';

const USER = 'pricing-user';
const OFFER = 'perm_paint_matte_black'; // 1500 coins
const HOUR = 60 * 60 * 1000;

type Resp<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Price { coins: number; gems: number }
interface ListedOffer {
  offer: { offerId: string };
  basePrice: Price;
  finalPrice: Price;
  activeSpecialOfferId?: string;
  owned: boolean;
}

function storeOfferIds(): Set<string> {
  return new Set(getStoreCatalog().sections.flatMap((s) => s.offers.map((o) => o.offerId)));
}

function event(id: string, sku: string, startsMs: number, endsMs: number, discountPct = 40) {
  return {
    id,
    kind: 'special_offer',
    startsAtUtc: new Date(startsMs).toISOString(),
    endsAtUtc: new Date(endsMs).toISOString(),
    payload: { sku, discountPct },
  };
}

describe('store pricing (T-12)', () => {
  let fake: FakeNakama;
  let logger: FakeLogger;

  const call = <T>(fn: typeof store_get_impl, payload: Record<string, unknown>): Resp<T> =>
    JSON.parse(fn({ _brand: 'NakamaContext', userId: USER } as never, logger, fake.nakama, JSON.stringify(payload))) as Resp<T>;

  const listed = (): ListedOffer[] => {
    const r = call<{ sections: Array<{ offers: ListedOffer[] }> }>(store_get_impl, {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data.sections.flatMap((s) => s.offers);
  };

  beforeEach(() => {
    fake = new FakeNakama();
    logger = new FakeLogger();
    ensureRuntimeState(fake.nakama, logger);
    const now = Date.now();
    loadEventsCatalog(logger, {
      version: 1,
      events: [
        event('evt_live', OFFER, now - HOUR, now + HOUR),
        event('evt_past', 'perm_wheels_neon_rim', now - 3 * HOUR, now - 2 * HOUR, 90),
        event('evt_unknown_sku', 'gem_pack_500_50off', now - HOUR, now + HOUR),
      ],
    }, fake.nakama, storeOfferIds());
    fake.store.set(`profiles/${USER}/${USER}`, {
      collection: 'profiles', key: USER, userId: USER,
      value: {
        schemaVersion: 1, userId: USER, displayName: 'Racer', avatarUrl: null, createdAt: 0, updatedAt: 0,
        progression: { xp: 0, level: 50, lastDailyWinAt: 0 },
        activeSpecialOffers: ['evt_live', 'evt_past', 'evt_unknown_sku'],
      },
      version: 'v-profile', permissionRead: 1, permissionWrite: 0,
    } as never);
    fake.wallets.set(USER, { coins: 10_000, gems: 100 });
  });

  it('drops a special_offer whose SKU is not a store offer, with a warning (HT-80)', () => {
    expect(getEventsCatalog().map((e) => e.id)).toEqual(['evt_live', 'evt_past']);
    expect(logger.lines.some((l) => /special_offer dropped.*evt_unknown_sku/.test(l))).toBe(true);
  });

  it('every bundled special_offer that survives the load names a store offer', () => {
    loadEventsCatalog(logger, eventsJson, fake.nakama, storeOfferIds());
    const ids = storeOfferIds();
    for (const e of getEventsCatalog().filter((x) => x.kind === 'special_offer')) {
      expect(ids.has(String((e.payload as { sku?: unknown }).sku))).toBe(true);
    }
  });

  it('store_buy charges the discounted finalPrice store_get showed (PC-20)', () => {
    const shown = listed().find((o) => o.offer.offerId === OFFER);
    expect(shown).toMatchObject({ basePrice: { coins: 1500, gems: 0 }, finalPrice: { coins: 900, gems: 0 }, activeSpecialOfferId: 'evt_live', owned: false });

    const r = call<{ pricePaid: Price; newBalance: Price }>(store_buy_impl, { offerId: OFFER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pricePaid).toEqual(shown?.finalPrice);
    expect(r.data.newBalance).toEqual({ coins: 10_000 - 900, gems: 100 });
    expect(fake.wallets.get(USER)).toEqual({ coins: 9100, gems: 100 });
  });

  it('an offer outside its event window is charged the catalog price, as shown', () => {
    const shown = listed().find((o) => o.offer.offerId === 'perm_wheels_neon_rim');
    expect(shown?.finalPrice).toEqual({ coins: 5000, gems: 0 });
    expect(shown?.activeSpecialOfferId).toBeUndefined();
    const r = call<{ pricePaid: Price }>(store_buy_impl, { offerId: 'perm_wheels_neon_rim' });
    expect(r.ok && r.data.pricePaid).toEqual({ coins: 5000, gems: 0 });
    expect(fake.wallets.get(USER)).toEqual({ coins: 5000, gems: 100 });
  });

  it('a client nowMs inside a past discount window is ignored by store_buy', () => {
    const r = call<{ pricePaid: Price }>(store_buy_impl, { offerId: 'perm_wheels_neon_rim', nowMs: Date.now() - 2.5 * HOUR });
    expect(r.ok && r.data.pricePaid).toEqual({ coins: 5000, gems: 0 });
  });

  it('every listed offer says owned=false; a bought one is no longer listed', () => {
    expect(listed().every((o) => o.owned === false)).toBe(true);
    call(store_buy_impl, { offerId: OFFER });
    expect(listed().some((o) => o.offer.offerId === OFFER)).toBe(false);
  });

  it('store_get and store_buy answer SERVICE_UNAVAILABLE in maintenance (X2-d)', () => {
    const cfg = loadLiveopsConfig(fake.nakama);
    fake.store.set(LIVEOPS_STORAGE_KEY, {
      collection: 'liveops', key: 'config', userId: '00000000-0000-0000-0000-000000000000',
      value: { ...cfg, flags: { ...cfg.flags, maintenance: true } },
      version: 'v-liveops', permissionRead: 0, permissionWrite: 0,
    } as never);
    const get = call(store_get_impl, {});
    const buy = call(store_buy_impl, { offerId: OFFER });
    expect(!get.ok && get.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(!buy.ok && buy.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(fake.wallets.get(USER)).toEqual({ coins: 10_000, gems: 100 });
  });
});
