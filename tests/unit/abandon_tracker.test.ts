// Phase 4 Chunk 9 unit tests for the liveops abandon tracker. Covers
// the rolling 24h window, the 15-minute block stamp, and lazy GC on
// read. All times are injected; no real clock involved.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ABANDONS_COLLECTION,
  filterFreshEntries,
  getAbandonsLast24h,
  isBlocked,
  recordAbandon,
  expireAbandons,
} from '../../modules/src/liveops/abandon_tracker';
import { loadLiveOpsConfig } from '../../modules/src/liveops/mm_config';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import liveopsConfigJson from '../../modules/src/catalogs/liveops_config.json';
import { FakeNakama } from '../e2e/_stubs';

beforeAll(() => {
  loadLiveOpsConfig(console as never, liveopsConfigJson as never);
});

const USER = 'ab-test-user';
const NOW = 1_700_000_000_000;

function readRaw(nak: FakeNakama, userId: string): { value: unknown; version: string } | null {
  const obj = nak.store.get(`${ABANDONS_COLLECTION}/${userId}/${userId}`);
  return obj === undefined ? null : { value: obj.value, version: obj.version ?? 'v0' };
}

describe('liveops/abandon_tracker — filterFreshEntries (pure)', () => {
  it('keeps entries younger than 24h', () => {
    const entries = [{ at: NOW - 60_000 }, { at: NOW - 5 * 60_000 }];
    expect(filterFreshEntries(entries, NOW)).toHaveLength(2);
  });

  it('drops entries older than 24h', () => {
    const entries = [
      { at: NOW - (24 * 60 * 60 * 1000 + 1) },
      { at: NOW - 25 * 60 * 60 * 1000 },
    ];
    expect(filterFreshEntries(entries, NOW)).toEqual([]);
  });

  it('keeps an entry exactly 24h old (inclusive boundary)', () => {
    const entries = [{ at: NOW - 24 * 60 * 60 * 1000 }];
    expect(filterFreshEntries(entries, NOW)).toHaveLength(1);
  });

  it('drops time-traveling future entries', () => {
    const entries = [{ at: NOW + 60_000 }, { at: NOW + 5 * 60_000 }];
    expect(filterFreshEntries(entries, NOW)).toEqual([]);
  });

  it('keeps an entry exactly at "now" (age 0)', () => {
    expect(filterFreshEntries([{ at: NOW }], NOW)).toHaveLength(1);
  });

  it('mixed ages only keep the fresh ones', () => {
    const entries = [
      { at: NOW - 1000 },                  // fresh
      { at: NOW - 25 * 60 * 60 * 1000 },   // expired
      { at: NOW - 60_000 },                // fresh
      { at: NOW + 1000 },                  // future — drop
    ];
    const fresh = filterFreshEntries(entries, NOW);
    expect(fresh).toHaveLength(2);
    expect(fresh.map((e) => e.at)).toEqual([NOW - 1000, NOW - 60_000]);
  });
});

describe('liveops/abandon_tracker — recordAbandon + getAbandonsLast24h', () => {
  it('first call creates the record and counts as 1', () => {
    const nak = new FakeNakama();
    const out = recordAbandon(nak.nakama, USER, NOW);
    expect(out.abandonsLast24h).toBe(1);
    expect(out.blockedNow).toBe(false);
    expect(out.blockedUntilUtc).toBeNull();
    expect(getAbandonsLast24h(nak.nakama, USER, NOW)).toBe(1);
  });

  it('three abandons in the same minute stamp a 15-minute block', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    const third = recordAbandon(nak.nakama, USER, NOW + 2_000);
    expect(third.abandonsLast24h).toBe(3);
    expect(third.blockedNow).toBe(true);
    expect(third.blockedUntilUtc).toBe(NOW + 2_000 + 15 * 60 * 1000);
  });

  it('isBlocked returns { blockedUntilUtc } while the block is active', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    recordAbandon(nak.nakama, USER, NOW + 2_000);
    const block = isBlocked(nak.nakama, USER, NOW + 3_000);
    expect(block).not.toBeNull();
    expect(block!.blockedUntilUtc).toBe(NOW + 2_000 + 15 * 60 * 1000);
  });

  it('isBlocked returns null after the block expires', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    recordAbandon(nak.nakama, USER, NOW + 2_000);
    const block = isBlocked(nak.nakama, USER, NOW + 16 * 60 * 1000);
    expect(block).toBeNull();
  });

  it('the fourth abandon while already blocked does not extend the block', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    const third = recordAbandon(nak.nakama, USER, NOW + 2_000);
    const originalBlock = third.blockedUntilUtc;
    const fourth = recordAbandon(nak.nakama, USER, NOW + 3_000);
    expect(fourth.abandonsLast24h).toBe(4);
    expect(fourth.blockedNow).toBe(false);
    expect(fourth.blockedUntilUtc).toBe(originalBlock);
  });

  it('after the block expires, the next abandon counts as fresh and re-blocks', () => {
    const nak = new FakeNakama();
    // Three quick abandons — block stamped at NOW + 2s + 15min.
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    recordAbandon(nak.nakama, USER, NOW + 2_000);
    // 16 minutes later: block has expired; the entries are STILL
    // inside the 24h window (just over 15min < 24h), so the rolling
    // count is 3 and the next abandon is the FOURTH entry. Because the
    // previous block is expired, the fresh count alone (>=3) re-stamps
    // the block — but the count stays at 4 entries; the "rolling
    // window" semantics means the same block re-fires.
    const after = recordAbandon(nak.nakama, USER, NOW + 16 * 60 * 1000);
    expect(after.abandonsLast24h).toBe(4);
    expect(after.blockedUntilUtc).toBe(NOW + 16 * 60 * 1000 + 15 * 60 * 1000);
  });

  it('getAbandonsLast24h filters out entries older than 24h and GCs lazily', () => {
    const nak = new FakeNakama();
    // First two abandons are 25h ago — already expired.
    recordAbandon(nak.nakama, USER, NOW - 25 * 60 * 60 * 1000);
    recordAbandon(nak.nakama, USER, NOW - 24 * 60 * 60 * 1000 - 1000);
    // One fresh abandon now.
    recordAbandon(nak.nakama, USER, NOW);
    expect(getAbandonsLast24h(nak.nakama, USER, NOW)).toBe(1);
    // Reading should have GC'd the stale entries — verify the raw record.
    const raw = readRaw(nak, USER);
    expect(raw).not.toBeNull();
    const v = raw!.value as { entries: { at: number }[] };
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.at).toBe(NOW);
  });

  it('expireAbandons returns { changed: false } when nothing to trim', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    const out = expireAbandons(nak.nakama, USER, NOW + 1000);
    expect(out.changed).toBe(false);
  });

  it('expireAbandons returns { changed: true } and clears an expired block', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    recordAbandon(nak.nakama, USER, NOW + 1_000);
    recordAbandon(nak.nakama, USER, NOW + 2_000);
    // 16 minutes later — block expired but entries are still fresh.
    const out = expireAbandons(nak.nakama, USER, NOW + 16 * 60 * 1000);
    expect(out.changed).toBe(true);
    const raw = readRaw(nak, USER);
    const v = raw!.value as { entries: { at: number }[]; blockedUntilUtc: number | null };
    expect(v.entries).toHaveLength(3);
    expect(v.blockedUntilUtc).toBeNull();
  });

  it('storage uses owner=userId, perms 0/0 (server-managed)', () => {
    const nak = new FakeNakama();
    recordAbandon(nak.nakama, USER, NOW);
    const obj = nak.store.get(`${ABANDONS_COLLECTION}/${USER}/${USER}`);
    expect(obj).toBeDefined();
    expect(obj!.userId).toBe(USER);
    expect(obj!.permissionRead).toBe(0);
    expect(obj!.permissionWrite).toBe(0);
    void SYSTEM_USER_ID;
  });
});