// Entry point loaded by Nakama via `--runtime.js_entrypoint=index.js`.
//
// Lifecycle (Phase 1):
//   InitModule(ctx, logger, initializer, nk):
//     1. Load game-data catalogs (chunk 3 wires the JSON sources).
//     2. Build the in-process EventBus.
//     3. Register the 6 RPCs (chunk 4+) + the shutdown hook.
//
// Bundle entry is esbuild — see package.json's "build" script.

import type { IContext, ILogger, IInitializer, INakama } from './nkruntime';

function InitModule(
  _ctx: IContext,
  logger: ILogger,
  _initializer: IInitializer,
  _nk: INakama,
): void {
  // Chunk 3 will load `tracks.json` + `modes.json` here. Until then the
  // server boots without game data and any RPC that needs catalogs
  // returns `INTERNAL` (chunk 4+).
  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};
