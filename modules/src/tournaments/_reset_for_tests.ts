// Phase 8 Chunk 6 — Test helper for the tournament scanner.
//
// The scanner is module-level state (a single setInterval). Tests
// that exercise the scanner call `stopTournamentScannerForTests` to
// clear the handle between cases. A fresh test fixture can then
// start a new scanner with `startTournamentScanner({...})`.

import type { TournamentScannerHandle } from './scanner';

let LAST_HANDLE: TournamentScannerHandle | null = null;

export function stopTournamentScannerForTests(): void {
  if (LAST_HANDLE === null) return;
  try {
    LAST_HANDLE.stop();
  } finally {
    LAST_HANDLE = null;
  }
}

export function rememberTournamentScannerHandle(h: TournamentScannerHandle): void {
  LAST_HANDLE = h;
  if (LAST_HANDLE !== null) {
    const orig = LAST_HANDLE.stop;
    LAST_HANDLE.stop = () => {
      orig();
      if (LAST_HANDLE === h) LAST_HANDLE = null;
    };
  }
}
