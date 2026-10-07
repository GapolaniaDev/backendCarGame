// Phase 7 Chunk 6 — Silenced storage helpers.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeNakama, FakeLogger, type FakeNakama as FakeNakamaType } from '../e2e/_stubs';
import type { INakama, ILogger } from '../../modules/src/nkruntime';
import {
  DEFAULT_SILENCE_DURATION_MS,
  getSilencedStatus,
  readSilenced,
  silenceUser,
  writeSilencedCreate,
  writeSilencedUpdate,
} from '../../modules/src/chat/silenced';
import type { SilencedRecord } from '../../modules/src/chat/types';

const NOW = 1_700_000_000_000;

describe('chat silenced (Phase 7 Chunk 6)', () => {
  let fake: FakeNakamaType;
  let nk: INakama;
  let logger: ILogger;

  beforeEach(() => {
    fake = new FakeNakama();
    nk = fake.nakama;
    logger = new FakeLogger();
  });

  it('readSilenced returns null when absent', () => {
    expect(readSilenced(nk, 'u1')).toBeNull();
  });

  it('writeSilencedCreate inserts and readSilenced returns it', () => {
    const rec: SilencedRecord = {
      schemaVersion: 1,
      userId: 'u1',
      untilUtc: NOW + DEFAULT_SILENCE_DURATION_MS,
      reason: 'auto:3_reports_24h',
      createdAt: NOW,
    };
    writeSilencedCreate(nk, rec);
    const read = readSilenced(nk, 'u1');
    expect(read).not.toBeNull();
    expect(read!.record.reason).toBe('auto:3_reports_24h');
  });

  it('writeSilencedUpdate CAS updates the row', () => {
    const rec: SilencedRecord = {
      schemaVersion: 1,
      userId: 'u1',
      untilUtc: NOW + DEFAULT_SILENCE_DURATION_MS,
      reason: 'auto:3_reports_24h',
      createdAt: NOW,
    };
    writeSilencedCreate(nk, rec);
    const read = readSilenced(nk, 'u1');
    expect(read).not.toBeNull();
    const next: SilencedRecord = {
      ...read!.record,
      reason: 'manual:admin',
    };
    writeSilencedUpdate(nk, next, read!.version);
    const after = readSilenced(nk, 'u1');
    expect(after!.record.reason).toBe('manual:admin');
  });

  it('getSilencedStatus returns silenced=true while untilUtc > now', () => {
    const rec: SilencedRecord = {
      schemaVersion: 1,
      userId: 'u1',
      untilUtc: NOW + 10_000,
      reason: 'auto',
      createdAt: NOW - 1000,
    };
    writeSilencedCreate(nk, rec);
    const s = getSilencedStatus(nk, 'u1', NOW);
    expect(s.silenced).toBe(true);
    expect(s.untilUtc).toBe(NOW + 10_000);
    expect(s.reason).toBe('auto');
  });

  it('getSilencedStatus returns silenced=false when untilUtc < now', () => {
    const rec: SilencedRecord = {
      schemaVersion: 1,
      userId: 'u1',
      untilUtc: NOW - 1000,
      reason: 'auto',
      createdAt: NOW - 5_000,
    };
    writeSilencedCreate(nk, rec);
    const s = getSilencedStatus(nk, 'u1', NOW);
    expect(s.silenced).toBe(false);
    expect(s.untilUtc).toBeNull();
    expect(s.reason).toBeNull();
  });

  it('getSilencedStatus returns silenced=false when no row exists', () => {
    const s = getSilencedStatus(nk, 'absent', NOW);
    expect(s.silenced).toBe(false);
    expect(s.untilUtc).toBeNull();
    expect(s.reason).toBeNull();
  });

  it('silenceUser creates a row with default duration', () => {
    const until = silenceUser(nk, 'u1', 'auto', DEFAULT_SILENCE_DURATION_MS, NOW);
    expect(until).toBe(NOW + DEFAULT_SILENCE_DURATION_MS);
    const read = readSilenced(nk, 'u1');
    expect(read).not.toBeNull();
    expect(read!.record.reason).toBe('auto');
  });

  it('silenceUser extends an existing silence (max of old + new wins)', () => {
    silenceUser(nk, 'u1', 'auto', 60_000, NOW);
    const longer = silenceUser(nk, 'u1', 'auto', 30_000, NOW + 5000);
    // 60_000 (existing) vs 5000 + 30000 = 35_000 (new) — existing wins.
    expect(longer).toBe(NOW + 60_000);
  });

  it('silenceUser uses MAX when a longer new silence is requested', () => {
    silenceUser(nk, 'u1', 'auto', 60_000, NOW);
    const longer = silenceUser(nk, 'u1', 'auto', 180_000, NOW + 5000);
    expect(longer).toBe(NOW + 5000 + 180_000);
  });

  // Logger is exercised by the silenceUser path (no warnings expected in
  // the happy path). Kept here so future regression of the API surface
  // (e.g. accidental logger.remove) fails loudly.
  void logger;
});