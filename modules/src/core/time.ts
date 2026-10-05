// Server-side time helpers. Uses the JS Date object — the racing server
// stamps startedAt and validates reported times against `Date.now()`,
// never against the client's clock (relay-pure design per Phase 1 spec).

export function serverNowMs(): number {
  return Date.now();
}

/** ISO 8601 timestamp at `Date.now()`. Useful for log fields. */
export function serverIsoNow(): string {
  return new Date(serverNowMs()).toISOString();
}