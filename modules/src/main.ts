// Entry point loaded by Nakama via `--runtime.js_entrypoint=index.js`.
//
// Lifecycle (Phase 1):
//   InitModule(ctx, logger, nk, initializer):
//     1. Load game-data catalogs (chunk 3 wires the JSON sources).
//     2. Register the 6 RPCs (chunks 4+) + the shutdown hook.
//
// Bundle entry is esbuild — see package.json's "build" script.
//
// IMPORTANT: The Go runtime calls this function positionally as
// `initModFn(goja.Null(), ctx, jsLoggerInst, nk, init)`, so the JS
// param order is (ctx, logger, nk, initializer) — the initializer is
// the FOURTH argument, not the third.

import type { IContext, ILogger, IInitializer, INakama } from './nkruntime';
import { loadCatalogs, type TracksCatalog, type ModesCatalog } from './core/catalog';
import {
  config_get,
  race_session_create,
  race_session_join,
  race_session_start,
  race_session_get,
  race_submit_result,
} from './race/rpcs';
import tracksJson from './catalogs/tracks.json';
import modesJson from './catalogs/modes.json';

function InitModule(
  _ctx: IContext,
  logger: ILogger,
  nk: INakama,
  initializer: IInitializer,
): void {
  // Embed tracks/modes into the bundle via esbuild's default JSON loader.
  loadCatalogs(
    logger,
    {
      tracks: tracksJson as unknown as TracksCatalog,
      modes: modesJson as unknown as ModesCatalog,
    },
    (s: string): string => nk.sha256Hash(s),
  );

  // Register the 6 RPCs as individual top-level statements.
  //
  // Nakama's goja runtime uses an AST scanner to extract the RPC
  // function names at boot. The scanner walks top-level
  // ExpressionStatements and TryStatement bodies — it does NOT recurse
  // into ForStatement, IfStatement, BlockStatement, etc. So we cannot
  // use a loop here; the calls must be inlined. Each call also uses
  // the bare identifier `config_get` (not a member expression) because
  // the scanner returns the first arg as a string and `checkFnScope`
  // then verifies that `globalThis[arg]` is a function.
  try {
    initializer.registerRpc('config_get', config_get);
    initializer.registerRpc('race_session_create', race_session_create);
    initializer.registerRpc('race_session_join', race_session_join);
    initializer.registerRpc('race_session_start', race_session_start);
    initializer.registerRpc('race_session_get', race_session_get);
    initializer.registerRpc('race_submit_result', race_submit_result);
  } catch (e) {
    logger.error('rpc registration failed: %s', e instanceof Error ? e.message : String(e));
  }

  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};