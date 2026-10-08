// Phase 9 Chunk 2 — Test reset for the receipt verification module.
//
// The `verifyReceipt` dispatcher keeps a module-level dedup cache
// (`CACHED`) and a `LAST_EVICT_AT` sentinel. Tests that exercise
// the cache (hit/miss, ttl expiry) need to wipe these between cases
// to stay deterministic.
//
// The mock catalog (`iap_packs.json`) reuses `_resetIapPacksCatalogForTests`
// from `iap/catalog.ts`; the liveops `iapVerification` config has no
// cached state on the JS side (every receipt call hits `loadLiveopsConfig`
// which re-reads storage). Only the verify.ts cache is module-local.

export { _resetVerifyCacheForTests, _peekVerifyCacheForTests } from './verify';
