// Phase 9 Chunk 1 — Ad reward types.
//
// The catalog (`catalogs/ad_rewards.json`) defines 4 reward tiers:
// `small` / `medium` / `large` / `xlarge`. Each carries a coin reward
// AND a per-tier cooldown (seconds). The runtime types here mirror
// that catalog and add the `AdProvider` discriminator + the
// `AdWatchEvent` wire shape used by the ad RPCs (Chunk 5).
//
// D64: cap = 10 ad rewards per UTC day (anti-cookie spam).
// D68: provider is `mock` for now — real AdMob / Unity Ads integration
//      is deferred until API keys are provisioned.

export type AdProvider = 'admob' | 'unityads' | 'mock';
export type AdTier = 'small' | 'medium' | 'large' | 'xlarge';

export interface AdRewardTier {
  tier: AdTier;
  coins: number;
  /** Minimum seconds between ad watches of this tier per user. */
  cooldownSeconds: number;
}

export interface AdWatchEvent {
  userId: string;
  tier: AdTier;
  provider: AdProvider;
  /** Provider-specific ad unit id (AdMob: 'ca-app-pub-xxx/yyy'). */
  adUnitId: string;
  watchedAtUtc: number;
  rewardGranted: boolean;
}

/** Persisted at `ad_last_watched/{userId}/{tier}`. */
export interface AdLastWatched {
  lastWatchedAtUtc: number;
  lastImpressionId: string;
}

/** Persisted at `ad_daily_count/{userId}/{utcDate}`. */
export interface AdDailyCount {
  count: number;
  lastUpdatedUtc: number;
}

/** Persisted at `ad_watch_log/{userId}/{impressionId}`. */
export interface AdWatchLog {
  tier: AdTier;
  adUnitId: string;
  provider: AdProvider;
  watchedAtUtc: number;
  grantedAtUtc: number;
  coinsGranted: number;
  newBalance: number;
  idempotencyKey: string;
}

const AD_TIERS: ReadonlySet<AdTier> = new Set<AdTier>([
  'small', 'medium', 'large', 'xlarge',
]);

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validate the raw `ad_rewards.json` payload. Returns the typed array
 * on success or a human-readable reason on failure. Cooldown must be at
 * least 60 seconds (anti-spam D64) and coins must be non-negative.
 */
export function validateAdRewardsFile(raw: unknown): ValidateResult<AdRewardTier[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'expected an array of tiers' };
  }
  if (raw.length < 1) {
    return { ok: false, reason: 'ad_rewards.json must contain at least 1 tier' };
  }
  const seen = new Set<AdTier>();
  const out: AdRewardTier[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const ctx = `tier[${i}]`;
    if (!isPlainObject(r)) {
      return { ok: false, reason: `${ctx} must be an object` };
    }
    const tier = r['tier'];
    if (typeof tier !== 'string' || !AD_TIERS.has(tier as AdTier)) {
      return { ok: false, reason: `${ctx}.tier must be one of small|medium|large|xlarge` };
    }
    if (seen.has(tier as AdTier)) {
      return { ok: false, reason: `${ctx}.tier duplicate: ${tier}` };
    }
    seen.add(tier as AdTier);
    const coins = r['coins'];
    if (typeof coins !== 'number' || !Number.isInteger(coins) || coins < 0) {
      return { ok: false, reason: `${ctx}.coins must be a non-negative integer` };
    }
    const cd = r['cooldownSeconds'];
    if (typeof cd !== 'number' || !Number.isInteger(cd) || cd < 60) {
      return { ok: false, reason: `${ctx}.cooldownSeconds must be a non-negative integer >= 60` };
    }
    out.push({ tier: tier as AdTier, coins, cooldownSeconds: cd });
  }
  return { ok: true, value: out };
}
