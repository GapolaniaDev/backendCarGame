// Phase 9 Chunk 5 — Test reset for the ad reward module.
//
// The `grant.ts` and `verify_mock.ts` are pure (no module-level state).
// `repo.ts` is stateless on the JS side. This file exists for parity
// with the iap module's _reset_for_tests — future-proofing in case
// the module later caches state (e.g. a verification dedup cache).

export { _resetAdRewardsCatalogForTests } from './catalog';
