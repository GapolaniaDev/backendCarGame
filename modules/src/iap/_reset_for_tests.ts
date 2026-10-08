// Phase 9 — Test resets for the IAP module.
//
// `verify.ts` keeps a module-level dedup cache; `subscription_scanner.ts`
// holds the setInterval handle. The purchase + subscription repos
// are stateless on the JS side (every call hits storage).
//
// Tests that exercise the dedup cache or the scanner timer need to
// wipe state between cases.

export {
  _resetVerifyCacheForTests,
  _peekVerifyCacheForTests,
} from './verify';

export { stopSubscriptionScanner } from './subscription_scanner';
