/**
 * `Cebab-ormv`: the conformance gate for `mcp_control.ts`'s SDK surface.
 *
 * THREE OF THE SIX METHODS IT DRIVES ARE NOT IN `sdk.d.ts`. Measured
 * 2026-09-18 against 0.3.251: `mcpAuthenticate`, `mcpClearAuth` and
 * `mcpSubmitOAuthCallbackUrl` read `function` off a real `query()` object and
 * appear nowhere in the shipped types, while `mcpServerStatus`,
 * `reconnectMcpServer` and `toggleMcpServer` are declared. So half of what the
 * MCP panel does rests on an undocumented surface that a patch release can take
 * away with no compile error anywhere in this repo — the same failure shape
 * `Cebab-ioh` filed for mock dispatch's dependence on `_registeredTools`.
 *
 * So this reads the shipped bundle, exactly as `claude.env_scrubbed.test.ts`
 * does and for exactly its reason: a test that compares Cebab's hand-written
 * list against another hand-written list agrees with itself and never with the
 * CLI.
 *
 * IT ASSERTS BOTH DIRECTIONS, and the second is the one that will matter first.
 * If the SDK DROPS a method, the presence case reddens and the panel's button
 * is known-dead before an operator finds it. If the SDK TYPES one, the
 * absent-from-types case reddens and tells us to delete that arm of the
 * `ControlQuery` cast — without it, the cast would quietly outlive its reason
 * and keep `any`-shaped code alive against a typed API.
 *
 * No spawn: a `query()` object would answer this too (the methods are on it
 * before any iteration), but constructing one starts a `claude` process, and a
 * gate that needs a working CLI is a gate that goes flaky in CI on a runner
 * with no credentials.
 */
import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { REQUIRED_SDK_METHODS, UNTYPED_SDK_METHODS } from './mcp_control.js';

const require_ = createRequire(import.meta.url);

/** Resolved through the SERVER workspace, where the dependency is declared —
 *  not from a repo-root path, which a lockfile move breaks with no source
 *  change (`project_lockfile_moves_break_root_anchored_resolve`). */
function sdkPath(file: string): string {
  const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
  return path.join(path.dirname(entry), file);
}

function read(file: string): string {
  const p = sdkPath(file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

describe('the SDK surface mcp_control.ts depends on', () => {
  test('ANTI-VACUITY: the bundle is readable and is the minified SDK', () => {
    // Without this, every bundle assertion below passes trivially on an empty
    // string — the exact "the gate's own helper is what measures nothing"
    // failure `project_gates_pass_vacuously` names.
    const src = read('sdk.mjs');
    expect(src.length).toBeGreaterThan(100_000);
    // A name the SDK has always exported, so a bundle that loaded but is the
    // wrong file still fails here rather than in a confusing place below.
    expect(src.includes('mcpServerStatus')).toBe(true);
  });

  test.each(REQUIRED_SDK_METHODS)('the bundle still defines %s', (method) => {
    const src = read('sdk.mjs');
    // `async <name>(` is how the minifier emits these class methods — measured
    // against the shipped bundle, e.g. `async mcpAuthenticate(e,t){`. Anchoring
    // on the definition rather than on a bare mention is what stops a stray
    // occurrence in a comment or a string from satisfying the gate.
    //
    // Boolean, not `toContain`: a failed `toContain` prints the whole 1.4MB
    // minified haystack, and a gate whose output nobody can read is a gate
    // nobody acts on.
    expect(
      src.includes(`async ${method}(`),
      `${method} is gone from the SDK bundle — mcp_control.ts drives a method that no longer exists`,
    ).toBe(true);
  });

  test.each(UNTYPED_SDK_METHODS)('%s is STILL absent from sdk.d.ts', (method) => {
    const types = read('sdk.d.ts');
    expect(types.length).toBeGreaterThan(10_000);
    expect(
      types.includes(method),
      `${method} is now declared in sdk.d.ts — delete its arm of the ControlQuery cast in mcp_control.ts and use the typed method`,
    ).toBe(false);
  });

  test('CONTROL: the typed trio really is in sdk.d.ts', () => {
    // The other half of the direction check. Without it, a broken `read()`
    // would make every "still absent" case above pass for the wrong reason.
    const types = read('sdk.d.ts');
    for (const method of ['mcpServerStatus', 'reconnectMcpServer', 'toggleMcpServer']) {
      expect(
        types.includes(method),
        `${method} should be declared — if it is not, the split in UNTYPED_SDK_METHODS is stale`,
      ).toBe(true);
    }
  });
});
