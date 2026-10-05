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
import { loadCatalogs, type TracksCatalog, type ModesCatalog } from './core/catalog';
import tracksJson from './catalogs/tracks.json';
import modesJson from './catalogs/modes.json';

function InitModule(
  _ctx: IContext,
  logger: ILogger,
  _initializer: IInitializer,
  nk: INakama,
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

  // Chunk 4+ will build the in-process EventBus, register the 6 RPCs,
  // and wire a fake RaceCompleted subscriber that logs the event.
  logger.info('core ready');
}

// Install the global so the JS runtime can find it. The runtime looks
// up `globalThis.InitModule` after the bundle evaluates.
(globalThis as { InitModule: typeof InitModule }).InitModule = InitModule;

export {};
