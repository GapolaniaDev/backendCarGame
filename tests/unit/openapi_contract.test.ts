// Plan T-27 (PC-15): the documented contract matches what the server registers.
//
// - Every RPC registered in `main.ts` that a client may call is a
//   `/v2/rpc/{id}` path of the client OpenAPI, and every such path is a
//   registered RPC (JSON and its YAML mirror).
// - The operator `admin_*` RPCs are deliberately NOT in the client OpenAPI:
//   their contract index is the inventory table of `docs/admin.md` §2, which
//   must list exactly the registered `admin_*` RPCs.
// - The `ErrorCode` enum of the OpenAPI and the error table of
//   `docs/unity-api.md` §4 list exactly `ERROR_CODES`.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { ERROR_CODES } from '../../modules/src/core/errors';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RPC_PREFIX = '/v2/rpc/';

function registeredRpcs(): string[] {
  const src = read('modules/src/main.ts');
  return [...src.matchAll(/registerRpc\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

interface OpenApiDoc {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, { enum?: string[] }> };
}

function openApiJson(): OpenApiDoc {
  return JSON.parse(read('docs/openapi/unity-client.openapi.json')) as OpenApiDoc;
}

function rpcPathsOf(paths: string[]): string[] {
  return paths.filter((p) => p.startsWith(RPC_PREFIX)).map((p) => p.slice(RPC_PREFIX.length));
}

function yamlTopLevelPaths(): string[] {
  // Path keys are the 2-space-indented quoted keys under `paths:`.
  const lines = read('docs/openapi/unity-client.openapi.yaml').split(/\r?\n/);
  const start = lines.indexOf('paths:');
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) break;
    const m = /^ {2}"([^"]+)":$/.exec(line);
    if (m) out.push(m[1] as string);
  }
  return out;
}

function adminInventory(): string[] {
  const doc = read('docs/admin.md');
  const start = doc.indexOf('## 2. RPC inventory');
  const end = doc.indexOf('\n## 3.', start);
  const section = doc.slice(start, end);
  return [...section.matchAll(/^\| `(admin_[a-z0-9_]+)`/gm)].map((m) => m[1] as string);
}

const sorted = (xs: string[]): string[] => [...xs].sort();

describe('client contract (plan T-27)', () => {
  const registered = registeredRpcs();
  const clientRpcs = registered.filter((id) => !id.startsWith('admin_'));
  const adminRpcs = registered.filter((id) => id.startsWith('admin_'));

  it('registers each RPC id once', () => {
    expect(registered.length).toBeGreaterThan(100);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('every registered client RPC is in the OpenAPI and every OpenAPI RPC is registered', () => {
    const documented = rpcPathsOf(Object.keys(openApiJson().paths));
    expect(sorted(documented)).toEqual(sorted(clientRpcs));
  });

  it('the YAML mirror documents the same paths as the JSON', () => {
    expect(yamlTopLevelPaths()).toEqual(Object.keys(openApiJson().paths));
  });

  it('no admin_* RPC is in the client OpenAPI', () => {
    const documented = rpcPathsOf(Object.keys(openApiJson().paths));
    expect(documented.filter((id) => id.startsWith('admin_'))).toEqual([]);
  });

  it('docs/admin.md §2 lists exactly the registered admin_* RPCs', () => {
    const inventory = adminInventory();
    expect(new Set(inventory).size).toBe(inventory.length);
    expect(sorted(inventory)).toEqual(sorted(adminRpcs));
  });

  it('the OpenAPI ErrorCode enum is ERROR_CODES', () => {
    const codes = openApiJson().components.schemas['ErrorCode']?.enum ?? [];
    expect(sorted(codes)).toEqual(sorted([...ERROR_CODES]));
  });

  it('docs/unity-api.md §4 lists exactly ERROR_CODES', () => {
    const doc = read('docs/unity-api.md');
    const start = doc.indexOf('## 4. Error codes');
    const end = doc.indexOf('\n## 5.', start);
    const rows = [...doc.slice(start, end).matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1] as string);
    expect(sorted(rows)).toEqual(sorted([...ERROR_CODES]));
  });
});
