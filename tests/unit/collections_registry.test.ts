// The central collection registry (plan T-16) must list every storage
// collection the code uses, or account_delete would leave that data
// behind. Fails when a `*_COLLECTION` constant or a
// `collection: '<literal>'` in modules/src is not registered.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COLLECTIONS, COLLECTION_NAMES } from '../../modules/src/core/collections';

const SRC = resolve(__dirname, '..', '..', 'modules', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function usedCollections(): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /\b[A-Z][A-Z0-9_]*_COLLECTION\s*(?::\s*string\s*)?=\s*'([^']+)'/g,
    /\bcollection:\s*'([^']+)'/g,
  ];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) found.set(m[1] as string, file.slice(SRC.length + 1));
    }
  }
  return found;
}

describe('core/collections registry', () => {
  it('registers every collection the code declares', () => {
    const used = usedCollections();
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter(([name]) => !COLLECTION_NAMES.has(name)).map(([n, f]) => `${n} (${f})`);
    expect(missing).toEqual([]);
  });

  it('has no duplicates and explains every system collection it keeps', () => {
    expect(COLLECTION_NAMES.size).toBe(COLLECTIONS.length);
    for (const c of COLLECTIONS) {
      if (c.owner === 'system' && c.purge.length === 0) expect(c.retained, c.name).toBeTruthy();
    }
  });

  it('includes the collections later cards added (idem T-11, race_active T-08, the legacy inbox)', () => {
    for (const name of ['idem', 'race_active', 'race_open', 'race_presence', 'liveops_inbox', 'inbox']) {
      expect(COLLECTION_NAMES.has(name), name).toBe(true);
    }
  });
});
