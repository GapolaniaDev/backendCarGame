// Phase 8 Chunk 8 — Test helper for the events scanner.
//
// The scanner is module-level state (a single setInterval handle).
// Tests that exercise the scanner call `stopEventScannerForTests`
// to clear the handle between cases. A fresh test fixture can then
// start a new scanner with `startEventScanner({...})`.

import type { EventScannerHandle } from './scanner';

let LAST_HANDLE: EventScannerHandle | null = null;

export function stopEventScannerForTests(): void {
  if (LAST_HANDLE === null) return;
  try {
    LAST_HANDLE.stop();
  } finally {
    LAST_HANDLE = null;
  }
}

export function rememberEventScannerHandle(h: EventScannerHandle): void {
  LAST_HANDLE = h;
  if (LAST_HANDLE !== null) {
    const orig = LAST_HANDLE.stop;
    LAST_HANDLE.stop = () => {
      orig();
      if (LAST_HANDLE === h) LAST_HANDLE = null;
    };
  }
}
