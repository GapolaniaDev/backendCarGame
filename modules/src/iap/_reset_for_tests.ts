// Phase 9 — Test resets for the IAP module.
//
// `verify.ts` keeps a module-level dedup cache; `subscription_scanner.ts`
// holds the setInterval handle. `admin_repo.ts` keeps a 60s stats
// cache. The purchase + subscription repos are stateless on the JS
// side (every call hits storage).
//
// Tests that exercise the dedup cache, the scanner timer, or the
// stats cache need to wipe state between cases.

export {
  _resetVerifyCacheForTests,
  _peekVerifyCacheForTests,
} from './verify';

export { stopSubscriptionScanner } from './subscription_scanner';
export { invalidateRevenueStatsCache } from './admin_repo';
