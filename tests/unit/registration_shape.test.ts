// Static shape check of the built bundle (`modules/index.js`) against the
// rules of Nakama 3.27's registration scanner (audit N0).
//
// At boot, goja's `initializer.register*` bindings do not use the function
// they receive: they re-parse the bundle and look the handler name up in
// the AST (`getRegisteredFnIdentifier`, `getHookFnIdentifier`,
// `getMatchHookFnIdentifier` in server/runtime_javascript_init.go). That
// scanner only finds a registration when:
//   1. `InitModule` is a top-level function declaration with >= 4 params
//      (the 4th is the initializer);
//   2. the call is an expression statement at the top level of the
//      `InitModule` body, or at the top level of a `try` block that is
//      itself a top-level statement (no `if`, loop, nested block, helper);
//   3. the handler argument is a bare identifier of a global function
//      (RPC / match functions are later looked up by name in fresh VMs);
//   4. `registerMatch` gets an object literal whose 7 handler properties
//      are identifiers.
// The scanner also does an unchecked `callee.Left.(*ast.Identifier)` on
// every `x.y(...)` statement it walks, so a top-level `a.b.c(...)` or
// `this.x(...)` statement would panic the boot.
//
// The node:vm e2e suite cannot see any of this (it calls the handlers it
// receives), which is how 108 of 110 RPCs went missing in production.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const BUNDLE = path.resolve(__dirname, '..', '..', 'modules', 'index.js');

/** Register calls whose handler is the 2nd argument (1st is the id). */
const KEYED_REGISTRATIONS = new Set([
  'registerRpc',
  'registerRtBefore',
  'registerRtAfter',
  'registerStorageIndexFilter',
]);

const MATCH_HANDLER_KEYS = [
  'matchInit',
  'matchJoinAttempt',
  'matchJoin',
  'matchLeave',
  'matchLoop',
  'matchTerminate',
  'matchSignal',
];

interface ShapeReport {
  violations: string[];
  rpcIds: string[];
  hooks: string[];
  matches: string[];
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Names that become global-object properties when the bundle runs as a
 * script: top-level function declarations and initialised top-level
 * `var`s (e.g. `var party_create = party_create_impl;`). Top-level
 * `let` / `const` are NOT global-object properties, so goja's
 * `GlobalObject().Get(name)` would not find them. Whether a `var` holds a
 * function is checked by Nakama itself at registration (`AssertFunction`).
 */
function collectGlobalFunctions(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      out.add(st.name.text);
    } else if (
      ts.isVariableStatement(st) &&
      (st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.add(d.name.text);
      }
    }
  }
  return out;
}

export function checkRegistrationShape(source: string): ShapeReport {
  const sf = ts.createSourceFile('index.js', source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const report: ShapeReport = { violations: [], rpcIds: [], hooks: [], matches: [] };
  const v = (node: ts.Node, msg: string): void => {
    report.violations.push(`line ${lineOf(sf, node)}: ${msg}`);
  };

  const init = sf.statements.find(
    (st): st is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(st) && st.name?.text === 'InitModule',
  );
  if (!init || !init.body) {
    report.violations.push('InitModule is not a top-level function declaration');
    return report;
  }
  const initParam = init.parameters[3];
  if (!initParam || !ts.isIdentifier(initParam.name)) {
    report.violations.push('InitModule must take (ctx, logger, nk, initializer)');
    return report;
  }
  const initName = initParam.name.text;
  const globals = collectGlobalFunctions(sf);

  // Statements the scanner walks: top level + top-level try blocks.
  const scanned = new Set<ts.Statement>();
  for (const st of init.body.statements) {
    scanned.add(st);
    if (ts.isTryStatement(st)) {
      for (const inner of st.tryBlock.statements) scanned.add(inner);
    }
  }

  // Panic hazard: `a.b.c(...)` / `this.x(...)` statements.
  for (const st of scanned) {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
    const callee = st.expression.expression;
    if (ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee.expression)) {
      v(st, `statement \`${callee.getText(sf)}(...)\` would panic the 3.27 scanner (left side must be an identifier)`);
    }
  }

  const checkHandler = (node: ts.Expression | undefined, what: string): void => {
    if (!node || !ts.isIdentifier(node)) {
      v(node ?? init, `${what}: handler must be a bare identifier, got \`${node?.getText(sf) ?? 'nothing'}\``);
      return;
    }
    if (!globals.has(node.text)) {
      v(node, `${what}: \`${node.text}\` is not a global function of the bundle`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === initName &&
      node.expression.name.text.startsWith('register')
    ) {
      const method = node.expression.name.text;
      const stmt = node.parent;
      if (!ts.isExpressionStatement(stmt) || !scanned.has(stmt)) {
        v(node, `${method} is not a top-level statement of InitModule or of a top-level try block`);
      }
      if (method === 'registerMatch') {
        const [nameArg, handlers] = node.arguments;
        const matchName = nameArg && ts.isStringLiteral(nameArg) ? nameArg.text : '?';
        if (!nameArg || !ts.isStringLiteral(nameArg)) v(node, 'registerMatch: name must be a string literal');
        report.matches.push(matchName);
        if (!handlers || !ts.isObjectLiteralExpression(handlers)) {
          v(node, `registerMatch(${matchName}): handlers must be an inline object literal`);
        } else {
          for (const key of MATCH_HANDLER_KEYS) {
            const prop = handlers.properties.find(
              (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                p.name.getText(sf).replace(/['"]/g, '') === key,
            );
            if (!prop) {
              v(handlers, `registerMatch(${matchName}): missing ${key}`);
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              checkHandler(prop.name, `registerMatch(${matchName}).${key}`);
            } else if (ts.isPropertyAssignment(prop)) {
              checkHandler(prop.initializer, `registerMatch(${matchName}).${key}`);
            }
          }
        }
      } else if (KEYED_REGISTRATIONS.has(method)) {
        const [idArg, fnArg] = node.arguments;
        if (!idArg || !ts.isStringLiteral(idArg)) {
          v(node, `${method}: id must be a string literal`);
        } else if (method === 'registerRpc') {
          report.rpcIds.push(idArg.text);
        }
        checkHandler(fnArg, `${method}(${idArg && ts.isStringLiteral(idArg) ? idArg.text : '?'})`);
      } else {
        report.hooks.push(method);
        checkHandler(node.arguments[0], method);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(init.body);

  const seen = new Set<string>();
  for (const id of report.rpcIds) {
    if (seen.has(id)) report.violations.push(`duplicate RPC id ${id}`);
    seen.add(id);
  }
  const seenHooks = new Set<string>();
  for (const h of report.hooks) {
    if (seenHooks.has(h)) report.violations.push(`hook ${h} registered twice (3.27 keeps only one)`);
    seenHooks.add(h);
  }
  return report;
}

describe('registration shape of the built bundle (Nakama 3.27 scanner rules)', () => {
  it('modules/index.js exists (run `npm run build` first)', () => {
    expect(fs.existsSync(BUNDLE)).toBe(true);
  });

  it('every initializer.register* call is scanner-visible with a global handler', () => {
    const report = checkRegistrationShape(fs.readFileSync(BUNDLE, 'utf8'));
    expect(report.violations).toEqual([]);
    expect(report.rpcIds.length).toBeGreaterThanOrEqual(100);
  });

  it('the regional relay surface is gone (D-01)', () => {
    const report = checkRegistrationShape(fs.readFileSync(BUNDLE, 'utf8'));
    expect(report.rpcIds).not.toContain('relay_token');
    expect(report.hooks).not.toContain('registerBeforeAuthenticateDevice');
  });
});

describe('checkRegistrationShape (self-test on synthetic bundles)', () => {
  const wrap = (body: string, extra = ''): string => `
"use strict";
function rpc_a(ctx, logger, nk, payload) { return ''; }
function hook_a(ctx, logger, nk, data) {}
${extra}
function InitModule(ctx, logger, nk, initializer) {
${body}
}
globalThis.InitModule = InitModule;
`;

  it('accepts flat registrations inside a top-level try', () => {
    const r = checkRegistrationShape(wrap(`
  logger.info('boot');
  try {
    initializer.registerRpc('a', rpc_a);
    initializer.registerAfterAuthenticateDevice(hook_a);
  } catch (e) {}
`));
    expect(r.violations).toEqual([]);
    expect(r.rpcIds).toEqual(['a']);
  });

  it('flags a registration inside an if (the N0 shape)', () => {
    const r = checkRegistrationShape(wrap(`
  const homeRelay = true;
  try {
    if (homeRelay) {
      initializer.registerRpc('a', rpc_a);
    }
  } catch (e) {}
`));
    expect(r.violations.join('\n')).toMatch(/registerRpc is not a top-level statement/);
  });

  it('flags a registration made from a helper function', () => {
    const r = checkRegistrationShape(wrap(`
  helper(initializer);
`, `function helper(init) { init.registerAfterAuthenticateDevice(hook_a); }`));
    // The helper's call does not use the InitModule parameter name, so the
    // scanner never sees it: the hook is simply missing from the report.
    expect(r.hooks).toEqual([]);
  });

  it('flags inline and non-global handlers', () => {
    const r = checkRegistrationShape(wrap(`
  try {
    initializer.registerRpc('a', function () { return ''; });
    initializer.registerRpc('b', missing_fn);
  } catch (e) {}
`));
    expect(r.violations.join('\n')).toMatch(/registerRpc\(a\): handler must be a bare identifier/);
    expect(r.violations.join('\n')).toMatch(/`missing_fn` is not a global function/);
  });

  it('flags statements that would panic the scanner', () => {
    const r = checkRegistrationShape(wrap(`
  nk.foo.bar();
  try { initializer.registerRpc('a', rpc_a); } catch (e) {}
`));
    expect(r.violations.join('\n')).toMatch(/would panic/);
  });

  it('checks registerMatch handler objects', () => {
    const extra = ['matchInit', 'matchJoinAttempt', 'matchJoin', 'matchLeave', 'matchLoop', 'matchTerminate']
      .map((k) => `function svc_${k}() {}`).join('\n');
    const r = checkRegistrationShape(wrap(`
  try {
    initializer.registerMatch('svc', {
      matchInit: svc_matchInit, matchJoinAttempt: svc_matchJoinAttempt, matchJoin: svc_matchJoin,
      matchLeave: svc_matchLeave, matchLoop: svc_matchLoop, matchTerminate: svc_matchTerminate,
    });
  } catch (e) {}
`, extra));
    expect(r.matches).toEqual(['svc']);
    expect(r.violations.join('\n')).toMatch(/missing matchSignal/);
  });
});
