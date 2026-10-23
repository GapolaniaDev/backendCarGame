// Server-side settings from `runtime.env` (plan T-24, T-25).
//
// `docker-compose.yml` writes `runtime.env` into the generated
// `nakama.yml` from `.env`; Nakama hands the entries to every RPC as
// `ctx.env`. Secrets (store credentials, the LevelPlay signing key) live
// only there: never in a catalog, LiveOps or the bundle. An unset or
// blank entry reads as `''`.

import type { IContext } from '../nkruntime';

/** The trimmed `runtime.env` value of `name`, or `''` when missing. */
export function envString(ctx: IContext | null | undefined, name: string): string {
  const v = ctx?.env?.[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** `true` only for an explicit `true` / `1` / `yes` (any case). */
export function envFlag(ctx: IContext | null | undefined, name: string): boolean {
  const v = envString(ctx, name).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
