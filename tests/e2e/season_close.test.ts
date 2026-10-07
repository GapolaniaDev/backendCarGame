// Phase 6 Chunk 6 — `pass_get` lazy season close e2e tests.
//
// Covers the D11 contract: the lazy close is triggered by the next
// `pass_get` access once the catalog's `endUtc` has passed, and the
// per-user `seasonClosed` flag is flipped on every existing PassRecord.
//
// The bundled `pass_s1.json` ships with a long-future endUtc
// (2027-12-31), so we drive the close through the helper surface
// directly. InitModule loads the bundled catalog first — we then
// re-load a synthetic expired catalog for the relevant tests.
// For the `pass_get` end-to-end test, we pre-seed the GLOBAL close
// marker (which the rpc honors) so the response surfaces
// `seasonClosed: true` without rewriting the catalog.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeContext, loadBundleForTest, SYSTEM_USER_ID } from './_stubs';
import type { LoadedBundle } from './_stubs';
import {
  PASS_COLLECTION,
  passRecordKey,
} from '../../modules/src/pass/pass_repo';
import {
  SEASON_CLOSE_COLLECTION,
  maybeCloseSeason,
  readSeasonCloseMarker,
  settleClosedSeasonRewards,
} from '../../modules/src/pass/season';
import {
  loadPassCatalog,
  _resetPassCatalogForTests,
  type RawPassFile,
} from '../../modules/src/pass/catalog';
import type { ILogger } from '../../modules/src/nkruntime';
import { FakeNakama } from './_stubs';

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as ILogger;

const EXPIRED_RAW: RawPassFile = (() => {
  const out: RawPassFile = {
    version: 1,
    seasonId: 'closed-s1',
    startUtc: '2024-01-01T00:00:00Z',
    endUtc: '2025-01-01T00:00:00Z',
    maxLevel: 40,
    premiumPriceGems: 800,
    levels: [],
  };
  for (let i = 1; i <= 40; i += 1) {
    out.levels.push({
      level: i,
      xpRequired: i === 1 ? 0 : (i - 1) * 100,
      freeReward: { coins: 100 },
      premiumReward: { coins: 200 },
    });
  }
  return out;
})();

function seedPassRecord(
  fake: FakeNakama,
  userId: string,
  seasonId: string,
  data: Partial<{
    xp: number;
    claimedFree: number[];
    claimedPremium: number[];
    premiumPurchased: boolean;
    seasonClosed: boolean;
  }>,
  version = 'v00000001',
): void {
  fake.store.set(`${PASS_COLLECTION}/${passRecordKey(userId)}/${userId}`, {
    collection: PASS_COLLECTION,
    key: passRecordKey(userId),
    userId,
    value: {
      schemaVersion: 1,
      userId,
      seasonId,
      xp: data.xp ?? 0,
      claimedFree: data.claimedFree ?? [],
      claimedPremium: data.claimedPremium ?? [],
      premiumPurchased: data.premiumPurchased ?? false,
      seasonClosed: data.seasonClosed ?? false,
    },
    version,
    permissionRead: 1,
    permissionWrite: 1,
    createTime: new Date(0).toISOString(),
    updateTime: new Date(0).toISOString(),
    expiresAt: null,
  });
}

describe('pass season close — helper unit (Phase 6 Chunk 6)', () => {
  beforeEach(() => {
    _resetPassCatalogForTests();
    loadPassCatalog(silentLogger, EXPIRED_RAW);
  });

  it('writes the season_close marker when now >= endUtc', () => {
    const fake = new FakeNakama();
    const r = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-01-01T00:00:00Z'), 'closed-s1');
    expect(r.closed).toBe(true);
    const marker = readSeasonCloseMarker(fake.nakama, 'closed-s1');
    expect(marker).not.toBeNull();
  });

  it('settleClosedSeasonRewards flips seasonClosed=true on an existing record', () => {
    const fake = new FakeNakama();
    seedPassRecord(fake, 'p1', 'closed-s1', { seasonClosed: false });
    settleClosedSeasonRewards(fake.nakama, silentLogger, 'p1', 'closed-s1');
    const stored = fake.store.get(`${PASS_COLLECTION}/p1/p1`)!;
    expect((stored as { value: { seasonClosed: boolean } }).value.seasonClosed).toBe(true);
  });

  it('maybeCloseSeason is idempotent — second call is a no-op', () => {
    const fake = new FakeNakama();
    const r1 = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-01-01T00:00:00Z'), 'closed-s1');
    expect(r1.closed).toBe(true);
    const r2 = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2026-01-01T00:00:00Z'), 'closed-s1');
    expect(r2.closed).toBe(false);
  });

  it('does NOT close when now < endUtc', () => {
    const fake = new FakeNakama();
    const r = maybeCloseSeason(fake.nakama, silentLogger, Date.parse('2024-06-01T00:00:00Z'), 'closed-s1');
    expect(r.closed).toBe(false);
    expect(readSeasonCloseMarker(fake.nakama, 'closed-s1')).toBeNull();
  });
});

describe('pass_get e2e observes global close marker (Phase 6 Chunk 6)', () => {
  let env: LoadedBundle;

  beforeEach(() => {
    env = loadBundleForTest();
    // Pre-seed the global close marker so pass_get sees a closed season
    // even though the bundled pass_s1 endUtc is in the future.
    env.fakeNakama.store.set(`${SEASON_CLOSE_COLLECTION}/s1/${SYSTEM_USER_ID}`, {
      collection: SEASON_CLOSE_COLLECTION,
      key: 's1',
      userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, closedAt: Date.now() },
      version: 'v00000001',
      permissionRead: 1,
      permissionWrite: 1,
      createTime: new Date(0).toISOString(),
      updateTime: new Date(0).toISOString(),
      expiresAt: null,
    });
  });

  it('pass_get reports seasonClosed=true when the global marker is present', () => {
    const handler = env.resolver('pass_get');
    if (!handler) throw new Error('no rpc: pass_get');
    const ctx = { ...FakeContext, userId: 'p1' };
    const body = JSON.stringify({
      callerUserId: 'p1',
      clientVersion: '1.0.0',
      platform: 'ios',
    });
    const res = JSON.parse(handler(ctx, env.logger, env.nak, body));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.seasonClosed).toBe(true);
  });
});