// Plan T-19 (HT Prog-5; audit 06 6.5.4, 6.5.7): the pass season close
// settles every record of the season, page by page, and resumes from the
// marker's cursor; every step is idempotent.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  closePassSeason,
  endRewardPayloads,
  passEndCarRewardId,
  passEndRewardId,
  pendingLevels,
  readSeasonCloseState,
  runPassSeasonTick,
  settleClosedSeasonRewards,
} from '../../modules/src/pass/season';
import { loadPassCatalog, _resetPassCatalogForTests, type RawPassFile } from '../../modules/src/pass/catalog';
import type { PassRecord } from '../../modules/src/pass/types';
import { FakeLogger, FakeNakama } from '../e2e/_stubs';

const SEASON = 'close-s1';

function raw(endUtc = '2026-02-01T00:00:00Z'): RawPassFile {
  const out: RawPassFile = {
    version: 1, seasonId: SEASON, startUtc: '2026-01-01T00:00:00Z', endUtc,
    maxLevel: 5, premiumPriceGems: 800, levels: [],
  };
  for (let i = 1; i <= 5; i++) {
    out.levels.push({
      level: i,
      xpRequired: (i - 1) * 100,
      freeReward: i === 5 ? { carId: 'car_x' } : { coins: 100 },
      premiumReward: i === 2 ? { cosmeticId: 'paint_x' } : { gems: 10 },
    });
  }
  return out;
}

function seed(nak: FakeNakama, userId: string, patch: Partial<PassRecord> = {}): void {
  const rec: PassRecord = {
    schemaVersion: 1, userId, seasonId: SEASON, xp: 0,
    claimedFree: [], claimedPremium: [], premiumPurchased: false, seasonClosed: false, ...patch,
  };
  nak.nakama.storageWrite([{ collection: 'pass', key: userId, userId, value: rec, permissionRead: 1, permissionWrite: 0 }]);
}

function record(nak: FakeNakama, userId: string): PassRecord {
  return nak.store.get(`pass/${userId}/${userId}`)?.value as PassRecord;
}

function inbox(nak: FakeNakama, userId: string): Array<{ id: string; reward?: Record<string, unknown> }> {
  return [...nak.store.values()]
    .filter((o) => o.collection === 'inbox' && o.userId === userId)
    .map((o) => o.value as { id: string; reward?: Record<string, unknown> });
}

describe('T-19 pass season close', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(new FakeLogger(), raw());
  });

  it('pending levels: reached and unclaimed; premium only when bought', () => {
    const rec = { xp: 250, claimedFree: [1], claimedPremium: [], premiumPurchased: true } as unknown as PassRecord;
    expect(pendingLevels(raw() as never, rec)).toEqual({ free: [2, 3], premium: [1, 2, 3] });
    expect(pendingLevels(raw() as never, { ...rec, premiumPurchased: false })).toEqual({ free: [2, 3], premium: [] });
  });

  it('end-reward payload sums currencies, lists cosmetics and splits cars', () => {
    const { main, cars } = endRewardPayloads(raw() as never, { free: [1, 5], premium: [1, 2] });
    expect(main).toMatchObject({ coins: 100, gems: 10, cosmetics: ['paint_x'] });
    expect(cars).toEqual(['car_x']);
  });

  it('settles one record: closed with its pending levels, one inbox reward per kind, idempotent', () => {
    const nak = new FakeNakama();
    seed(nak, 'u1', { xp: 400, premiumPurchased: true, claimedFree: [1] });
    expect(settleClosedSeasonRewards(nak.nakama, new FakeLogger(), 'u1', SEASON, 1000)).toBe('settled');
    expect(record(nak, 'u1')).toMatchObject({
      seasonClosed: true,
      endRewards: { free: [2, 3, 4, 5], premium: [1, 2, 3, 4, 5] },
      endRewardsSentAt: 1000,
    });
    const msgs = inbox(nak, 'u1');
    expect(msgs.map((m) => m.id).sort()).toEqual([passEndCarRewardId(SEASON, 'car_x'), passEndRewardId(SEASON)].sort());
    expect(msgs.find((m) => m.id === passEndRewardId(SEASON))?.reward).toMatchObject({ coins: 300, gems: 40 });

    expect(settleClosedSeasonRewards(nak.nakama, new FakeLogger(), 'u1', SEASON, 2000)).toBe('already_settled');
    expect(inbox(nak, 'u1')).toHaveLength(2);
  });

  it('a record closed but not sent (crash in between) is resumed with the same rewards', () => {
    const nak = new FakeNakama();
    seed(nak, 'u2', { xp: 100, seasonClosed: true, endRewards: { free: [1], premium: [] } });
    expect(settleClosedSeasonRewards(nak.nakama, new FakeLogger(), 'u2', SEASON, 5)).toBe('settled');
    expect(inbox(nak, 'u2').map((m) => m.reward)).toEqual([{ coins: 100 }]);
  });

  it('settles every record across pages and resumes from the marker cursor', () => {
    const nak = new FakeNakama();
    for (let i = 0; i < 230; i++) seed(nak, `p${String(i).padStart(3, '0')}`, { xp: 100 });
    // A record of another season is left alone.
    nak.nakama.storageWrite([{
      collection: 'pass', key: 'other', userId: 'other',
      value: { schemaVersion: 1, userId: 'other', seasonId: 'next', xp: 999, claimedFree: [], claimedPremium: [], premiumPurchased: false, seasonClosed: false },
      permissionRead: 1, permissionWrite: 0,
    }]);

    const first = closePassSeason(nak.nakama, new FakeLogger(), SEASON, 10, { maxRecords: 100 });
    expect(first).toMatchObject({ state: 'settling', settled: 100 });
    expect(readSeasonCloseState(nak.nakama, SEASON)?.marker).toMatchObject({ state: 'settling', settled: 100 });

    let runs = 1;
    let last = first;
    while (last.state !== 'settled' && runs < 10) {
      last = closePassSeason(nak.nakama, new FakeLogger(), SEASON, 20, { maxRecords: 100 });
      runs++;
    }
    expect(last.state).toBe('settled');
    expect(readSeasonCloseState(nak.nakama, SEASON)?.marker).toMatchObject({ state: 'settled', settled: 230 });
    const paid = [...nak.store.values()].filter((o) => o.collection === 'inbox');
    expect(paid).toHaveLength(230);
    expect(record(nak, 'other').seasonClosed).toBe(false);
  });

  it('the ticker job is a no-op before endUtc and settles after it', () => {
    const nak = new FakeNakama();
    seed(nak, 'u3', { xp: 100 });
    expect(runPassSeasonTick(nak.nakama, new FakeLogger(), Date.parse('2026-01-15T00:00:00Z'))).toBe('active');
    expect(readSeasonCloseState(nak.nakama, SEASON)).toBeNull();
    expect(runPassSeasonTick(nak.nakama, new FakeLogger(), Date.parse('2026-02-02T00:00:00Z'))).toMatch(/^settled\//);
    expect(record(nak, 'u3').seasonClosed).toBe(true);
    expect(runPassSeasonTick(nak.nakama, new FakeLogger(), Date.parse('2026-02-03T00:00:00Z'))).toBe('settled');
  });
});
