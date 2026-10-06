// Phase 5 Chunk 1 — Liveops config (operation + launch).
//
// Storage layout:
//   collection: `liveops`
//   key:        `config`
//   owner:      SYSTEM_USER_ID (server-only read + write — perms 0/0)
//
// Read path: every call to `loadLiveopsConfig(nk)` re-reads storage
// (NO in-memory cache) so an admin's runtime override takes effect
// immediately without restarting. The bundled `liveops.default.json`
// is the boot default; if storage is empty `loadLiveopsConfig`
// returns that default verbatim without writing it (boot is the only
// place that writes — `bootEnsure`).
//
// Decisions enforced here:
//   D1 maintenance granularity: GLOBAL — a single flag read at every
//      maintenance-aware RPC.
//   D2 min client version: HARD BLOCK — surfaced via `config_get`
//      so the client can prompt the player before any game RPC
//      rejects the call.
//   D7 admin RPC auth: http_key (consumed by Chunk 5+; this chunk
//      only stores the config shape).
//   D8 analytics destination: STORAGE `analytics_events` + optional
//      webhook URL (the webhook field is reserved for Chunk 7; today
//      only the storage destination is documented).

import type { ILogger, INakama } from '../nkruntime';
import { SYSTEM_USER_ID } from '../race/constants';
import liveopsDefault from '../catalogs/liveops.default.json';
import type { LiveopsConfig, ClientPlatform, CalendarEntryType } from './types';

export { type LiveopsConfig, type ClientPlatform, type CalendarEntryType } from './types';

export const LIVEOPS_COLLECTION = 'liveops';
export const LIVEOPS_KEY = 'config';
export const LIVEOPS_STORAGE_KEY = `${LIVEOPS_COLLECTION}/${LIVEOPS_KEY}/${SYSTEM_USER_ID}`;

// ─── Internal: bundled default ─────────────────────────────────────────────

// JSON loader gives us a structural superset of `LiveopsConfig`. The
// inline casts are needed because the JSON shape can't carry the
// `schemaVersion: 1` literal or the ReadonlyArray refinements — the
// cast just re-asserts the shape the validator will check on read.
const bundled: Readonly<LiveopsConfig> = Object.freeze({
  schemaVersion: 1,
  version: (liveopsDefault as { version: number }).version,
  flags: Object.freeze({
    maintenance: (liveopsDefault as { flags: { maintenance: boolean; maintenanceMessage?: string; maintenanceExemptUserIds?: string[] } }).flags.maintenance,
    ...((liveopsDefault as { flags: { maintenanceMessage?: string } }).flags.maintenanceMessage !== undefined
      ? { maintenanceMessage: (liveopsDefault as { flags: { maintenanceMessage?: string } }).flags.maintenanceMessage }
      : {}),
    ...((liveopsDefault as { flags: { maintenanceExemptUserIds?: string[] } }).flags.maintenanceExemptUserIds !== undefined
      ? { maintenanceExemptUserIds: (liveopsDefault as { flags: { maintenanceExemptUserIds?: string[] } }).flags.maintenanceExemptUserIds }
      : {}),
  }),
  minClientVersion: Object.freeze({ ...(liveopsDefault as { minClientVersion: Record<ClientPlatform, string> }).minClientVersion }),
  regions: Object.freeze(
    ((liveopsDefault as { regions: ReadonlyArray<{ id: string; displayName: string; relayUrl: string }> }).regions).map(
      (r) => Object.freeze({ ...r }),
    ),
  ),
  calendar: Object.freeze(
    ((liveopsDefault as { calendar: ReadonlyArray<{ id: string; type: 'event'|'tournament'|'maintenance'; startUtc: string; endUtc: string }> }).calendar).map(
      (c) => Object.freeze({ ...c }),
    ),
  ),
  // adminRpcKey is intentionally NOT bundled — there's no default
  // secret. Admins bootstrap via `liveops_config_override` after the
  // first boot. The field is undefined here, which `validate()` and
  // `freeze()` both handle.
});

// ─── Validation ────────────────────────────────────────────────────────────

const PLATFORMS: ReadonlyArray<ClientPlatform> = [
  'ios', 'android', 'windows', 'macos', 'linux',
];
const CALENDAR_TYPES: ReadonlySet<CalendarEntryType> = new Set([
  'event', 'tournament', 'maintenance',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validate(raw: unknown): asserts raw is LiveopsConfig {
  const fail = (msg: string): never => {
    throw new Error(`liveops config invalid: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r['schemaVersion'] !== 1) fail(`schemaVersion must be 1, got ${String(r['schemaVersion'])}`);
  if (typeof r['version'] !== 'number' || !Number.isInteger(r['version'] as number) || (r['version'] as number) < 1) {
    fail(`version must be a positive integer, got ${String(r['version'])}`);
  }

  const flagsRaw = r['flags'];
  if (!isPlainObject(flagsRaw)) fail('flags must be an object');
  const flags: Record<string, unknown> = flagsRaw as Record<string, unknown>;
  if (typeof flags['maintenance'] !== 'boolean') {
    fail(`flags.maintenance must be a boolean, got ${String(flags['maintenance'])}`);
  }
  if (flags['maintenanceMessage'] !== undefined && typeof flags['maintenanceMessage'] !== 'string') {
    fail(`flags.maintenanceMessage must be a string when present`);
  }
  if (flags['maintenanceExemptUserIds'] !== undefined) {
    if (!Array.isArray(flags['maintenanceExemptUserIds'])) {
      fail('flags.maintenanceExemptUserIds must be an array of strings');
    }
    for (const uid of flags['maintenanceExemptUserIds'] as unknown[]) {
      if (typeof uid !== 'string' || uid.length === 0) {
        fail('flags.maintenanceExemptUserIds entries must be non-empty strings');
      }
    }
  }

  const minRaw = r['minClientVersion'];
  if (!isPlainObject(minRaw)) fail('minClientVersion must be an object');
  for (const p of PLATFORMS) {
    const v = (minRaw as Record<string, unknown>)[p];
    if (typeof v !== 'string' || v.length === 0) {
      fail(`minClientVersion.${p} must be a non-empty semver string`);
    }
    if (!/^\d+\.\d+\.\d+/.test(v as string)) {
      fail(`minClientVersion.${p} must start with MAJOR.MINOR.PATCH, got ${String(v)}`);
    }
  }

  const regionsRaw = r['regions'];
  if (!Array.isArray(regionsRaw) || regionsRaw.length === 0) {
    fail('regions must be a non-empty array');
  }
  const seenRegionIds = new Set<string>();
  for (let i = 0; i < (regionsRaw as unknown[]).length; i += 1) {
    const reg = (regionsRaw as unknown[])[i];
    if (!isPlainObject(reg)) fail(`regions[${i}] must be an object`);
    const rr = reg as Record<string, unknown>;
    if (typeof rr['id'] !== 'string' || (rr['id'] as string).length === 0) {
      fail(`regions[${i}].id must be a non-empty string`);
    }
    if (seenRegionIds.has(rr['id'] as string)) {
      fail(`regions[${i}].id duplicates an earlier entry`);
    }
    seenRegionIds.add(rr['id'] as string);
    if (typeof rr['displayName'] !== 'string' || (rr['displayName'] as string).length === 0) {
      fail(`regions[${i}].displayName must be a non-empty string`);
    }
    if (typeof rr['relayUrl'] !== 'string' || !(rr['relayUrl'] as string).startsWith('ws')) {
      fail(`regions[${i}].relayUrl must be a ws:// or wss:// URL`);
    }
  }

  const calRaw = r['calendar'];
  if (!Array.isArray(calRaw)) fail('calendar must be an array (may be empty)');
  for (let i = 0; i < (calRaw as unknown[]).length; i += 1) {
    const c = (calRaw as unknown[])[i];
    if (!isPlainObject(c)) fail(`calendar[${i}] must be an object`);
    const cc = c as Record<string, unknown>;
    if (typeof cc['id'] !== 'string' || (cc['id'] as string).length === 0) {
      fail(`calendar[${i}].id must be a non-empty string`);
    }
    if (typeof cc['type'] !== 'string' || !CALENDAR_TYPES.has(cc['type'] as CalendarEntryType)) {
      fail(`calendar[${i}].type must be event|tournament|maintenance`);
    }
    if (typeof cc['startUtc'] !== 'string' || Number.isNaN(Date.parse(cc['startUtc'] as string))) {
      fail(`calendar[${i}].startUtc must be a parseable ISO-8601 string`);
    }
    if (typeof cc['endUtc'] !== 'string' || Number.isNaN(Date.parse(cc['endUtc'] as string))) {
      fail(`calendar[${i}].endUtc must be a parseable ISO-8601 string`);
    }
    if (Date.parse(cc['endUtc'] as string) <= Date.parse(cc['startUtc'] as string)) {
      fail(`calendar[${i}].endUtc must be after startUtc`);
    }
  }

  // adminRpcKey: optional. When present must be a non-empty string.
  // When absent, admin RPCs fail closed (SERVICE_UNAVAILABLE).
  const ak = r['adminRpcKey'];
  if (ak !== undefined && (typeof ak !== 'string' || (ak as string).length === 0)) {
    fail('adminRpcKey must be a non-empty string when present');
  }

  // analyticsWebhook: optional. When present must start with http(s)://.
  // No deep URL parse — we just sanity-check the scheme to catch typos.
  const wh = r['analyticsWebhook'];
  if (wh !== undefined) {
    if (typeof wh !== 'string') {
      fail('analyticsWebhook must be a string when present');
    }
    const whStr = wh as string;
    if (!whStr.startsWith('http://') && !whStr.startsWith('https://')) {
      fail('analyticsWebhook must start with http:// or https://');
    }
  }
}

// ─── Read path (NO cache) ─────────────────────────────────────────────────

/**
 * Read the liveops config from storage. Returns the bundled default
 * when storage is empty. **Every call re-reads storage** so an admin
 * override takes effect on the next request without a restart.
 *
 * Invalid storage values are logged and the bundled default is
 * returned — admins can fix the override at runtime without a crash.
 */
export function loadLiveopsConfig(nk: INakama, logger?: ILogger): LiveopsConfig {
  const reads = nk.storageRead([
    { collection: LIVEOPS_COLLECTION, key: LIVEOPS_KEY, userId: SYSTEM_USER_ID },
  ]);
  const obj = reads[0];
  if (obj === undefined || obj.value === undefined) {
    return bundled;
  }
  try {
    validate(obj.value);
  } catch (e) {
    if (logger) {
      logger.error(
        'liveops config in storage failed validation — using bundled default: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
    return bundled;
  }
  return freeze((obj.value as unknown) as LiveopsConfig);
}

// ─── Boot write path ──────────────────────────────────────────────────────

/**
 * Idempotent. Inserts the bundled default into `liveops/config` when
 * storage is empty; if storage already has a value, leaves it
 * untouched. Safe to call from every worker at `InitModule` (the
 * read-then-write race is handled by the runtime — the second writer
 * sees the row exists and is a no-op on the unique key).
 *
 * Wrapped in try/catch by the caller (`main.ts`) so a failed write
 * never crashes boot.
 */
export function bootEnsure(nk: INakama, logger: ILogger): { inserted: boolean; version: number } {
  const reads = nk.storageRead([
    { collection: LIVEOPS_COLLECTION, key: LIVEOPS_KEY, userId: SYSTEM_USER_ID },
  ]);
  const existing = reads[0];
  if (existing !== undefined && existing.value !== undefined) {
    logger.info('liveops bootEnsure — config already present (version=%d)', (existing.value as { version?: number }).version ?? -1);
    return { inserted: false, version: (existing.value as { version?: number }).version ?? -1 };
  }
  // Fresh write — NO `version` (runtime assigns one) and NO
  // createTime/updateTime/expiresAt (server-managed). Permissions
  // 0/0 = server-only.
  nk.storageWrite([
    {
      collection: LIVEOPS_COLLECTION,
      key: LIVEOPS_KEY,
      userId: SYSTEM_USER_ID,
      value: bundled as unknown as Record<string, unknown>,
      permissionRead: 0,
      permissionWrite: 0,
    },
  ]);
  logger.info('liveops bootEnsure — config inserted (version=%d)', bundled.version);
  return { inserted: true, version: bundled.version };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Test-only reset — the read path is stateless, so this is a no-op
 *  kept for symmetry with the other config modules. */
export function _resetLiveopsConfigForTests(): void {
  // no-op: loadLiveopsConfig does not cache
}

function freeze(cfg: LiveopsConfig): LiveopsConfig {
  return Object.freeze({
    schemaVersion: 1,
    version: cfg.version,
    flags: Object.freeze({
      maintenance: cfg.flags.maintenance,
      ...(cfg.flags.maintenanceMessage !== undefined
        ? { maintenanceMessage: cfg.flags.maintenanceMessage }
        : {}),
      ...(cfg.flags.maintenanceExemptUserIds !== undefined
        ? { maintenanceExemptUserIds: cfg.flags.maintenanceExemptUserIds.slice() }
        : {}),
    }),
    minClientVersion: Object.freeze({ ...cfg.minClientVersion }),
    regions: Object.freeze(cfg.regions.map((r) => Object.freeze({ ...r }))),
    calendar: Object.freeze(cfg.calendar.map((c) => Object.freeze({ ...c }))),
    ...(cfg.adminRpcKey !== undefined ? { adminRpcKey: cfg.adminRpcKey } : {}),
    ...(cfg.analyticsWebhook !== undefined ? { analyticsWebhook: cfg.analyticsWebhook } : {}),
  });
}
