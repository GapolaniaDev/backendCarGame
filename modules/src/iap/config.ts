// Receipt verification settings from `runtime.env` (plan T-24, PC-04).
//
// Before T-24 the provider came from LiveOps (`iapVerification`), whose
// bundled default was the mock: any JSON receipt bought coins. Now the
// mock is only on with `IAP_MOCK=true`, and the real verifiers take their
// credentials from `runtime.env` (`.env` → `docker-compose.yml`). The
// LiveOps `iapVerification` block is still accepted but ignored.

import type { IContext } from '../nkruntime';
import { envFlag, envString } from '../core/runtime_env';
import type { IapRuntimeConfig } from './types';

export const IAP_TIMEOUT_MS = 10_000;

export function iapConfigFromEnv(ctx: IContext | null | undefined): IapRuntimeConfig {
  return {
    mock: envFlag(ctx, 'IAP_MOCK'),
    appleSharedSecret: envString(ctx, 'IAP_APPLE_SHARED_SECRET'),
    googleClientEmail: envString(ctx, 'IAP_GOOGLE_CLIENT_EMAIL'),
    // A PEM pasted on one line keeps its newlines as `\n` escapes.
    googlePrivateKey: envString(ctx, 'IAP_GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    googlePackageName: envString(ctx, 'IAP_GOOGLE_PACKAGE_NAME'),
    timeoutMs: IAP_TIMEOUT_MS,
  };
}

export function appleConfigured(cfg: IapRuntimeConfig): boolean {
  return cfg.appleSharedSecret.length > 0;
}

export function googleConfigured(cfg: IapRuntimeConfig): boolean {
  return cfg.googleClientEmail.length > 0 && cfg.googlePrivateKey.length > 0 && cfg.googlePackageName.length > 0;
}
