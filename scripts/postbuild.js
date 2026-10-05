#!/usr/bin/env node
// Post-build step: esbuild emits an IIFE wrapper that hides our top-level
// `function InitModule` inside a closure. Nakama's goja runtime parses
// the entrypoint with an AST scanner that requires `function InitModule`
// (or `var InitModule = function literal`) at the top level of the file.
// Stripping the IIFE wrapper exposes the function at top level while
// keeping all the bundled support code intact.
//
// Bundle shape from esbuild --format=iife:
//   "use strict";
//   (() => {
//     ... module code ...
//     function InitModule(...) { ... }
//     globalThis.InitModule = InitModule;
//   })();
//
// We rewrite to:
//   "use strict";
//   ... module code ...
//   function InitModule(...) { ... }
//   globalThis.InitModule = InitModule;

'use strict';

const fs = require('fs');
const path = require('path');

const ENTRY = path.resolve(__dirname, '..', 'modules', 'index.js');

const original = fs.readFileSync(ENTRY, 'utf8');
const lines = original.split('\n');

if (lines.length < 4) {
  console.error('postbuild: bundle too short to unwrap');
  process.exit(1);
}

// Detect the IIFE wrapper: the first IIFE opener `(() => {` and the
// matching closer `})();` mark the boundaries. We strip those two and
// keep everything else (including any `"use strict";` preamble).
const startIdx = lines.findIndex((l) => l.trim() === '(() => {');
const endIdx = lines.lastIndexOf('})();');

if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  console.error(
    `postbuild: could not locate IIFE wrapper (startIdx=${startIdx} endIdx=${endIdx})`,
  );
  process.exit(1);
}

const unwrapped = [
  ...lines.slice(0, startIdx),
  ...lines.slice(startIdx + 1, endIdx),
  ...lines.slice(endIdx + 1),
].join('\n');

fs.writeFileSync(ENTRY, unwrapped);
console.log(`postbuild: unwrapped IIFE for ${path.relative(process.cwd(), ENTRY)}`);