// Phase 5 Chunk 9 unit tests — per-RPC gate verification.
//
// Static checks that the source for each Chunk-9-gated RPC contains
// `assertNotInMaintenance` (or `liveopsGate`, which already includes
// the maintenance check). Catches accidental drift when the wire
// contract or a peer adds a new RPC.

import { describe, it, expect as e } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', 'modules', 'src', rel), 'utf8');
}

describe('liveops_remaining_gates (Phase 5 Chunk 9) — per-RPC gate presence', () => {
  it('race/rpcs.ts: 5 race RPCs each call assertNotInMaintenance', () => {
    const src = readSrc('race/rpcs.ts');
    const gates = (src.match(/assertNotInMaintenance\(/g) ?? []).length;
    e(gates).toBeGreaterThanOrEqual(5);
  });

  it('profiles/rpcs.ts: profile_get + profile_update both use liveopsGate', () => {
    const src = readSrc('profiles/rpcs.ts');
    const gates = (src.match(/liveopsGate\(/g) ?? []).length;
    e(gates).toBeGreaterThanOrEqual(2);
  });

  it('matchmaking/rpcs.ts: mm_ticket_params calls assertNotInMaintenance', () => {
    const src = readSrc('matchmaking/rpcs.ts');
    e(src).toMatch(/assertNotInMaintenance\(/);
  });

  it('ranked/rpcs.ts: ranked_get calls assertNotInMaintenance', () => {
    const src = readSrc('ranked/rpcs.ts');
    e(src).toMatch(/assertNotInMaintenance\(/);
  });

  it('account/rpcs.ts: account_link + account_link_resolve_conflict use liveopsGate', () => {
    const src = readSrc('account/rpcs.ts');
    const gates = (src.match(/liveopsGate\(/g) ?? []).length;
    e(gates).toBeGreaterThanOrEqual(2);
  });

  it('account/rpcs.ts: account_delete bypasses maintenance (no gate)', () => {
    const src = readSrc('account/rpcs.ts');
    const start = src.indexOf('account_delete_impl:');
    e(start).toBeGreaterThan(-1);
    const slice = src.slice(start, start + 12000);
    e(slice).not.toMatch(/assertNotInMaintenance\(/);
    e(slice).not.toMatch(/liveopsGate\(/);
  });

  it('liveops/rpcs.ts: liveops_config_get has no gate (splash-safe)', () => {
    const src = readSrc('liveops/rpcs.ts');
    const start = src.indexOf('liveops_config_get_impl:');
    const end = src.indexOf('\nexport const inbox_list_impl:', start);
    e(start).toBeGreaterThan(-1);
    e(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    e(slice).not.toMatch(/assertNotInMaintenance\(/);
    e(slice).not.toMatch(/liveopsGate\(/);
  });

  it('liveops/rpcs.ts: inbox_claim uses liveopsGate (inbox_list has none)', () => {
    const src = readSrc('liveops/rpcs.ts');
    const claimStart = src.indexOf('inbox_claim_impl:');
    e(claimStart).toBeGreaterThan(-1);
    // The claim function body is short; 4000 chars after the impl
    // marker is enough to find liveopsGate.
    const claimBody = src.slice(claimStart, claimStart + 4000);
    e(claimBody).toMatch(/liveopsGate\(/);

    const listStart = src.indexOf('inbox_list_impl:');
    e(listStart).toBeGreaterThan(-1);
    // Slice from inbox_list_impl to inbox_claim_impl (exclusive).
    const listEnd = src.indexOf('inbox_claim_impl:', listStart);
    e(listEnd).toBeGreaterThan(listStart);
    const listBody = src.slice(listStart, listEnd);
    e(listBody).not.toMatch(/liveopsGate\(/);
    e(listBody).not.toMatch(/assertNotInMaintenance\(/);
  });

  it('core/admin/analytics.ts: declares all Chunk-9 event names', () => {
    const src = readSrc('core/admin/analytics.ts');
    for (const name of [
      'profile_updated',
      'mm_ticket_params_called',
      'account_linked',
      'account_link_conflict',
      'account_link_conflict_resolved',
      'account_deleted',
    ]) {
      e(src).toMatch(new RegExp(`'${name}'`));
    }
  });
});