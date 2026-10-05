// E2E boot test for Phase 3 — confirms the bundle loads all five
// new catalogs without throwing, and that the FakeInitializer still
// wires up cleanly so the existing Phase 1+2 tests can rely on it.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadBundleForTest } from './_stubs';

describe('Phase 3 boot (Chunk 1)', () => {
  let env: ReturnType<typeof loadBundleForTest>;

  beforeEach(() => {
    env = loadBundleForTest();
  });

  it('bundle boots without errors and exposes Phase 1+2 RPCs', () => {
    const rpcs = env.rpcs.map((r) => r.key).sort();
    expect(rpcs).toContain('config_get');
    expect(rpcs).toContain('race_session_create');
    expect(rpcs).toContain('lb_get');
    expect(rpcs).toContain('profile_get');
    expect(rpcs).toContain('profile_update');
  });

  it('logger records the Phase 3 catalog load lines', () => {
    const lines = env.fakeLogger.lines.join('\n');
    expect(lines).toMatch(/catalogs loaded: tracks=\d+ modes=\d+/);
    expect(lines).toMatch(/rewards catalog loaded: sizes=2,4,6/);
    expect(lines).toMatch(/levels catalog loaded: curve=table levels=50 maxLevel=50/);
    expect(lines).toMatch(/garage catalog loaded: cars=\d+ cosmetics=\d+/);
    expect(lines).toMatch(/store catalog loaded: sections=3 dailyPoolSize=3/);
  });
});