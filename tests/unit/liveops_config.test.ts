// Phase 5 Chunk 1 unit tests for the liveops config loader.
//
// Covers:
//   - loadLiveopsConfig: returns bundled default when storage is empty
//   - bootEnsure: writes the bundled default into storage on first boot
//   - loadLiveopsConfig: re-reads storage on every call (NO in-memory cache)
//     so an admin's runtime mutation is reflected immediately
//   - bootEnsure: idempotent — second call leaves storage untouched
//   - validate: rejects malformed payloads (schemaVersion, version,
//     maintenance flag, regions, calendar ordering, relayUrl scheme)
//
// The bootEnsure / loadLiveopsConfig tests poke the FakeNakama stub
// directly (no InitModule) so we can control storage state without
// going through the RPC layer.

import { describe, it, expect } from 'vitest';

import {
  bootEnsure,
  loadLiveopsConfig,
  validate,
  LIVEOPS_COLLECTION,
  LIVEOPS_KEY,
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig } from '../../modules/src/liveops/types';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { FakeNakama } from '../e2e/_stubs';
import { FakeNakama as FakeNakamaClass } from '../e2e/_stubs';
import type { ILogger } from '../../modules/src/nkruntime';

function makeNakama(): FakeNakama {
  return new FakeNakamaClass();
}

function makeLogger(): { logger: ILogger; lines: string[] } {
  const lines: string[] = [];
  const sub = (format: string, args: unknown[]): string => {
    let i = 0;
    return format.replace(/%[sd]/g, () => String(args[i++] ?? ''));
  };
  const push = (lvl: string) => (f: string, ...a: unknown[]) => {
    lines.push(`[${lvl}] ${sub(f, a)}`);
  };
  const logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    withField: () => logger,
    withFields: () => logger,
    getFields: () => ({}),
  } as unknown as ILogger;
  return { logger, lines };
}

describe('liveops config (Phase 5 Chunk 1) — loadLiveopsConfig / bootEnsure', () => {
  it('fresh state → loadLiveopsConfig returns bundled default', () => {
    const { logger } = makeLogger();
    const nak = makeNakama();
    const cfg = loadLiveopsConfig(nak.nakama, logger);

    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.version).toBe(1);
    expect(cfg.flags.maintenance).toBe(false);
    expect(cfg.minClientVersion.ios).toBe('0.1.0');
    expect(cfg.minClientVersion.android).toBe('0.1.0');
    expect(cfg.minClientVersion.windows).toBe('0.1.0');
    expect(cfg.minClientVersion.macos).toBe('0.1.0');
    expect(cfg.minClientVersion.linux).toBe('0.1.0');
    expect(cfg.regions.length).toBeGreaterThanOrEqual(2);
    expect(cfg.regions.map((r) => r.id)).toEqual(['us', 'eu']);
    expect(cfg.regions[0].relayUrl.startsWith('ws')).toBe(true);
    expect(cfg.calendar).toEqual([]);
    // Nothing was written — fresh state has no storage row.
    expect(nak.store.has(LIVEOPS_STORAGE_KEY)).toBe(false);
  });

  it('after bootEnsure → storage has liveops/config with expected shape', () => {
    const { logger, lines } = makeLogger();
    const nak = makeNakama();

    const result = bootEnsure(nak.nakama, logger);

    expect(result.inserted).toBe(true);
    expect(result.version).toBe(1);

    const stored = nak.store.get(LIVEOPS_STORAGE_KEY);
    expect(stored).toBeDefined();
    expect(stored?.collection).toBe(LIVEOPS_COLLECTION);
    expect(stored?.key).toBe(LIVEOPS_KEY);
    expect(stored?.userId).toBe(SYSTEM_USER_ID);
    expect(stored?.permissionRead).toBe(0);
    expect(stored?.permissionWrite).toBe(0);

    // The persisted value MUST be a valid LiveopsConfig — roundtrip
    // through storage and validate.
    const persisted = stored?.value as LiveopsConfig;
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.version).toBe(1);
    expect(persisted.flags.maintenance).toBe(false);
    expect(persisted.regions.length).toBeGreaterThanOrEqual(2);
    validate(persisted);

    // The boot path logs the inserted line.
    expect(lines.some((l) => l.includes('liveops bootEnsure') && l.includes('inserted'))).toBe(true);
  });

  it('mutate storage → loadLiveopsConfig reflects mutation (NO cache)', () => {
    const { logger } = makeLogger();
    const nak = makeNakama();

    // Seed the bundled default.
    bootEnsure(nak.nakama, logger);
    expect(loadLiveopsConfig(nak.nakama, logger).flags.maintenance).toBe(false);

    // Admin override: flip maintenance ON with a custom message.
    const existing = nak.store.get(LIVEOPS_STORAGE_KEY);
    expect(existing).toBeDefined();
    const overridden = {
      ...(existing?.value as LiveopsConfig),
      version: 2,
      flags: {
        maintenance: true,
        maintenanceMessage: 'Nightly deploy in progress',
      },
    };
    nak.store.set(LIVEOPS_STORAGE_KEY, {
      ...existing,
      value: overridden,
    });

    // The read path re-reads storage on every call — the override is
    // visible without restarting the server.
    const cfg = loadLiveopsConfig(nak.nakama, logger);
    expect(cfg.flags.maintenance).toBe(true);
    expect(cfg.flags.maintenanceMessage).toBe('Nightly deploy in progress');
    expect(cfg.version).toBe(2);

    // Mutate again — second read sees the new mutation. This is the
    // explicit "no cache" guarantee.
    const further = {
      ...overridden,
      version: 3,
      minClientVersion: { ...overridden.minClientVersion, ios: '1.0.0' },
    };
    const after = nak.store.get(LIVEOPS_STORAGE_KEY);
    expect(after).toBeDefined();
    nak.store.set(LIVEOPS_STORAGE_KEY, { ...after, value: further });

    const cfg2 = loadLiveopsConfig(nak.nakama, logger);
    expect(cfg2.version).toBe(3);
    expect(cfg2.minClientVersion.ios).toBe('1.0.0');
  });

  it('idempotent: bootEnsure twice → no duplicate, no throw', () => {
    const { logger, lines } = makeLogger();
    const nak = makeNakama();

    const first = bootEnsure(nak.nakama, logger);
    expect(first.inserted).toBe(true);

    // Capture the first stored row (with its version) so we can confirm
    // a second boot doesn't bump the version.
    const firstStored = nak.store.get(LIVEOPS_STORAGE_KEY);
    const firstVersion = firstStored?.version;
    expect(firstVersion).toBeDefined();

    // Capture the version of the persisted payload to compare against
    // the second boot's "already present" log.
    const firstPayloadVersion = (firstStored?.value as { version?: number }).version;
    expect(firstPayloadVersion).toBe(1);

    const second = bootEnsure(nak.nakama, logger);
    expect(second.inserted).toBe(false);
    expect(second.version).toBe(firstPayloadVersion);

    // Storage row is still the original row — same version, same value.
    const secondStored = nak.store.get(LIVEOPS_STORAGE_KEY);
    expect(secondStored?.version).toBe(firstVersion);
    expect((secondStored?.value as { version: number }).version).toBe(firstPayloadVersion);

    // Both informational lines were logged.
    expect(lines.filter((l) => l.includes('liveops bootEnsure')).length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes('inserted'))).toBe(true);
    expect(lines.some((l) => l.includes('already present'))).toBe(true);
  });

  it('invalid storage payload → loadLiveopsConfig returns bundled default + logs error', () => {
    const { logger, lines } = makeLogger();
    const nak = makeNakama();
    // Seed an INVALID config directly into storage (admin typo, etc.).
    nak.store.set(LIVEOPS_STORAGE_KEY, {
      collection: LIVEOPS_COLLECTION,
      key: LIVEOPS_KEY,
      userId: SYSTEM_USER_ID,
      value: { schemaVersion: 1, version: 'not-a-number' }, // wrong type for version
      version: 'v00000001',
      permissionRead: 0,
      permissionWrite: 0,
      createTime: '2026-01-01T00:00:00Z',
      updateTime: '2026-01-01T00:00:00Z',
      expiresAt: null,
    });

    const cfg = loadLiveopsConfig(nak.nakama, logger);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.version).toBe(1);
    expect(cfg.flags.maintenance).toBe(false);
    expect(lines.some((l) => l.startsWith('[error]'))).toBe(true);
  });
});

describe('liveops config (Phase 5 Chunk 1) — validate (pure)', () => {
  const valid: LiveopsConfig = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: false },
    minClientVersion: {
      ios: '0.1.0',
      android: '0.1.0',
      windows: '0.1.0',
      macos: '0.1.0',
      linux: '0.1.0',
    },
    regions: [
      { id: 'us', displayName: 'America', relayUrl: 'wss://us.example.com' },
    ],
    calendar: [],
  };

  it('accepts a minimal valid payload', () => {
    expect(() => validate(valid)).not.toThrow();
  });

  it('rejects schemaVersion !== 1', () => {
    expect(() => validate({ ...valid, schemaVersion: 2 })).toThrow(/schemaVersion must be 1/);
  });

  it('rejects non-positive version', () => {
    expect(() => validate({ ...valid, version: 0 })).toThrow(/version/);
    expect(() => validate({ ...valid, version: -5 })).toThrow(/version/);
    expect(() => validate({ ...valid, version: 1.5 })).toThrow(/version/);
  });

  it('rejects non-boolean maintenance flag', () => {
    expect(() => validate({ ...valid, flags: { maintenance: 'no' as never } })).toThrow(/maintenance/);
  });

  it('rejects empty regions array', () => {
    expect(() => validate({ ...valid, regions: [] })).toThrow(/regions/);
  });

  it('rejects region without ws:// relayUrl', () => {
    expect(() =>
      validate({ ...valid, regions: [{ id: 'x', displayName: 'X', relayUrl: 'http://nope' }] }),
    ).toThrow(/ws/);
  });

  it('rejects calendar entry with endUtc <= startUtc', () => {
    expect(() =>
      validate({
        ...valid,
        calendar: [
          {
            id: 'c1',
            type: 'event',
            startUtc: '2026-12-01T00:00:00Z',
            endUtc: '2026-11-30T00:00:00Z',
          },
        ],
      }),
    ).toThrow(/endUtc/);
  });
});