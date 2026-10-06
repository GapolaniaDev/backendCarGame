// Phase 5 Chunk 2 unit tests for the liveops gates
// (`assertNotInMaintenance`, `assertMinClientVersion`,
// `compareSemver`, `liveopsGate`).
//
// Covers:
//   - assertNotInMaintenance: maintenance=false → null
//   - assertNotInMaintenance: maintenance=true → SERVICE_UNAVAILABLE envelope
//   - assertNotInMaintenance: maintenance=true + userId in exempt → null
//   - assertMinClientVersion: per platform (ios/android/windows/macos/linux)
//     below → UPGRADE_REQUIRED envelope
//   - assertMinClientVersion: exact match → null
//   - assertMinClientVersion: clientVersion undefined → "0.0.0" → UPGRADE_REQUIRED
//   - compareSemver: 1.0.0<1.0.1, 1.0.0<2.0.0, 1.2.3==1.2.3,
//                    1.10.0>1.9.0 (numeric, NOT lexicographic)
//
// Storage is poked directly via the FakeNakama stub (no InitModule)
// so we control the liveops config without going through the boot
// RPC layer.

import { describe, it, expect } from 'vitest';

import {
  assertNotInMaintenance,
  assertMinClientVersion,
  compareSemver,
  liveopsGate,
} from '../../modules/src/core/liveops';
import {
  LIVEOPS_COLLECTION,
  LIVEOPS_KEY,
  LIVEOPS_STORAGE_KEY,
} from '../../modules/src/liveops/config';
import type { LiveopsConfig, ClientPlatform } from '../../modules/src/liveops/types';
import { SYSTEM_USER_ID } from '../../modules/src/race/constants';
import type { FakeNakama } from '../e2e/_stubs';
import { FakeNakama as FakeNakamaClass } from '../e2e/_stubs';
import type { ILogger } from '../../modules/src/nkruntime';

function makeNakama(): FakeNakama {
  return new FakeNakamaClass();
}

function makeLogger(): ILogger {
  const sub = (format: string, args: unknown[]): string => {
    let i = 0;
    return format.replace(/%[sd]/g, () => String(args[i++] ?? ''));
  };
  return {
    debug: () => {},
    info: (f: string, ...a: unknown[]) => { sub(f, a); },
    warn: (f: string, ...a: unknown[]) => { sub(f, a); },
    error: (f: string, ...a: unknown[]) => { sub(f, a); },
    withField: () => makeLogger(),
    withFields: () => makeLogger(),
    getFields: () => ({}),
  } as unknown as ILogger;
}

/** Seed `liveops/config` with the given override. */
function seedConfig(
  nak: FakeNakama,
  override: Partial<LiveopsConfig>,
): void {
  const base: LiveopsConfig = {
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
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://us.example.com' }],
    calendar: [],
  };
  nak.store.set(LIVEOPS_STORAGE_KEY, {
    collection: LIVEOPS_COLLECTION,
    key: LIVEOPS_KEY,
    userId: SYSTEM_USER_ID,
    value: { ...base, ...override },
    version: 'v00000001',
    permissionRead: 0,
    permissionWrite: 0,
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    expiresAt: null,
  });
}

describe('liveops gate (Phase 5 Chunk 2) — assertNotInMaintenance', () => {
  it('maintenance=false → no-op (returns null)', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: { maintenance: false } });
    const result = assertNotInMaintenance(makeLogger(), nak.nakama, 'user-1');
    expect(result).toBeNull();
  });

  it('maintenance=true → returns SERVICE_UNAVAILABLE envelope', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: { maintenance: true } });
    const result = assertNotInMaintenance(makeLogger(), nak.nakama, 'user-1');
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.error.message).toContain('mantenimiento');
    }
  });

  it('maintenance=true + userId in maintenanceExemptUserIds → no-op', () => {
    const nak = makeNakama();
    seedConfig(nak, {
      flags: {
        maintenance: true,
        maintenanceExemptUserIds: ['user-1', 'admin-1'],
      },
    });
    const result = assertNotInMaintenance(makeLogger(), nak.nakama, 'user-1');
    expect(result).toBeNull();
  });

  it('maintenance=true + userId NOT in exempt → SERVICE_UNAVAILABLE', () => {
    const nak = makeNakama();
    seedConfig(nak, {
      flags: {
        maintenance: true,
        maintenanceExemptUserIds: ['someone-else'],
      },
    });
    const result = assertNotInMaintenance(makeLogger(), nak.nakama, 'user-1');
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      // detail should carry the userId and the message
      const detail = result.error.details as { userId: string; message?: string };
      expect(detail.userId).toBe('user-1');
      expect(detail.message).toBeUndefined();
    }
  });

  it('maintenance=true + message in JSON → detail.message is set', () => {
    const nak = makeNakama();
    seedConfig(nak, {
      flags: {
        maintenance: true,
        maintenanceMessage: 'Deploy en progreso',
      },
    });
    const result = assertNotInMaintenance(makeLogger(), nak.nakama, 'user-1');
    if (result && !result.ok) {
      const detail = result.error.details as { userId: string; message?: string };
      expect(detail.message).toBe('Deploy en progreso');
    }
  });

  it('skipForAdmin=true bypasses maintenance', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: { maintenance: true } });
    const result = assertNotInMaintenance(
      makeLogger(),
      nak.nakama,
      'user-1',
      { skipForAdmin: true },
    );
    expect(result).toBeNull();
  });
});

describe('liveops gate (Phase 5 Chunk 2) — assertMinClientVersion (per-platform)', () => {
  const cfg: LiveopsConfig = {
    schemaVersion: 1,
    version: 1,
    flags: { maintenance: false },
    minClientVersion: {
      ios: '1.2.0',
      android: '1.2.0',
      windows: '1.2.0',
      macos: '1.2.0',
      linux: '1.2.0',
    },
    regions: [{ id: 'us', displayName: 'America', relayUrl: 'wss://us.example.com' }],
    calendar: [],
  };

  it.each<ClientPlatform>(['ios', 'android', 'windows', 'macos', 'linux'])(
    'platform=%s below → UPGRADE_REQUIRED',
    (platform) => {
      const result = assertMinClientVersion('1.1.9', platform, cfg);
      expect(result).not.toBeNull();
      if (result && !result.ok) {
        expect(result.error.code).toBe('UPGRADE_REQUIRED');
        const detail = result.error.details as {
          clientVersion: string;
          required: string;
          platform: ClientPlatform;
        };
        expect(detail.clientVersion).toBe('1.1.9');
        expect(detail.required).toBe('1.2.0');
        expect(detail.platform).toBe(platform);
      }
    },
  );

  it('exact match → no-op', () => {
    const result = assertMinClientVersion('1.2.0', 'ios', cfg);
    expect(result).toBeNull();
  });

  it('above required → no-op', () => {
    const result = assertMinClientVersion('2.0.0', 'ios', cfg);
    expect(result).toBeNull();
  });

  it('clientVersion undefined → treated as "0.0.0" → UPGRADE_REQUIRED', () => {
    const result = assertMinClientVersion(undefined, 'ios', cfg);
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.error.code).toBe('UPGRADE_REQUIRED');
      const detail = result.error.details as { clientVersion: string };
      expect(detail.clientVersion).toBe('0.0.0');
    }
  });

  it('clientVersion undefined + minVersion=0.0.0 → no-op', () => {
    const cfgZero: LiveopsConfig = {
      ...cfg,
      minClientVersion: { ios: '0.0.0', android: '0.0.0', windows: '0.0.0', macos: '0.0.0', linux: '0.0.0' },
    };
    const result = assertMinClientVersion(undefined, 'ios', cfgZero);
    expect(result).toBeNull();
  });
});

describe('liveops gate (Phase 5 Chunk 2) — compareSemver (pure)', () => {
  it('1.0.0 < 1.0.1 → -1', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
  });

  it('1.0.0 < 2.0.0 → -1', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('1.2.3 == 1.2.3 → 0', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('1.10.0 > 1.9.0 (NUMERIC, not lexicographic) → 1', () => {
    // '10' > '9' lexicographically fails — "10" < "9" in string order.
    // The helper must parse numerically.
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
  });

  it('1.0.10 > 1.0.9 (numeric over lexicographic on patch)', () => {
    expect(compareSemver('1.0.10', '1.0.9')).toBe(1);
  });

  it('missing patch defaults to 0 (1.2 == 1.2.0)', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });

  it('missing minor + patch default to 0 (1 == 1.0.0)', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
  });

  it('2.0.0 > 1.99.99 → 1', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });
});

describe('liveops gate (Phase 5 Chunk 2) — liveopsGate (combined)', () => {
  it('maintenance=false AND version OK → null', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: {} });
    const result = liveopsGate(makeLogger(), nak.nakama, 'user-1', '0.1.0', 'ios');
    expect(result).toBeNull();
  });

  it('maintenance=ON → SERVICE_UNAVAILABLE (gate hits first)', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: { maintenance: true } });
    const result = liveopsGate(makeLogger(), nak.nakama, 'user-1', '99.0.0', 'ios');
    if (result && !result.ok) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
    } else {
      throw new Error('expected envelope');
    }
  });

  it('version below → UPGRADE_REQUIRED', () => {
    const nak = makeNakama();
    seedConfig(nak, { flags: {} });
    const result = liveopsGate(makeLogger(), nak.nakama, 'user-1', '0.0.1', 'ios');
    if (result && !result.ok) {
      expect(result.error.code).toBe('UPGRADE_REQUIRED');
    } else {
      throw new Error('expected envelope');
    }
  });
});