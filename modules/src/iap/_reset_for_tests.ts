// Phase 9 Chunk 2 + 3 — Test resets for the IAP module.
//
// `verify.ts` keeps a module-level dedup cache; the purchase repo
// reads from storage so it has no module-level state; `grant.ts` is
// pure. Only the cache needs a reset between cases.

export { _resetVerifyCacheForTests, _peekVerifyCacheForTests } from './verify';
