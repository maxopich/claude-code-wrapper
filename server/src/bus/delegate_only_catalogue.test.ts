/**
 * [security] `DELEGATE_ONLY_DISALLOWED` must cover the SDK's whole tool
 * catalogue, and the catalogue is the thing that moves.
 *
 * WHAT WENT WRONG. The list was hand-written against an older CLI and its only
 * test was `expect(opts.disallowedTools).toEqual([...DELEGATE_ONLY_DISALLOWED])`
 * — the constant compared to itself, which is green for any content whatsoever
 * (`project_gates_pass_vacuously`). Measured on 2026-09-08 against the pinned
 * SDK 0.3.251: three names in the list (`KillShell`, `BashOutput`, `Task`) no
 * longer exist, and ten tools that do exist were missing, including `Agent`,
 * `Workflow`, `REPL` and `EnterWorktree`. SECURITY.md meanwhile credited this
 * layer with denying "a future built-in that nobody remembered to list".
 *
 * WHY IT IS ONLY MEDIUM, stated so nobody over-reads the fix: `makeCanUseTool`
 * independently default-denies anything that is not `bus_send` or
 * `AskUserQuestion`, so a gap here widens the orchestrator's CONTEXT (it can
 * see a tool it will then be refused), not its reach. The two layers were
 * designed to back each other; one had silently stopped.
 *
 * THE APPROACH is `claude.env_scrubbed.test.ts`'s (`Cebab-m99x`): do not
 * compare two hand-written lists, extract the expectation from the shipped
 * artifact. Here that artifact is the SDK's generated `sdk-tools.d.ts`, whose
 * `ToolInputSchemas` union is the CLI's own tool-input catalogue.
 *
 * PARSING NOTE, and it is the one thing that could make this wrong: three type
 * names are not the tool name (`FileEditInput` is the `Edit` tool). The map
 * below is the whole translation, and the anti-vacuity cases pin that the
 * extraction found a real catalogue rather than an empty one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { DELEGATE_ONLY_DISALLOWED } from './runner.js';

/** Type-name → tool-name, for the three that differ. */
const TYPE_NAME_ALIASES: Record<string, string> = {
  FileEdit: 'Edit',
  FileRead: 'Read',
  FileWrite: 'Write',
};

/** The only tool a delegate-only agent may use besides the injected `bus_send`. */
const DELEGATE_ONLY_ALLOWED = ['AskUserQuestion'];

function readSdkToolNames(): string[] | null {
  let dts: string;
  try {
    // Resolve from THIS workspace's declaring package, not the repo root — a
    // lockfile bump can relocate a workspace dep with no source change and a
    // root-anchored resolve then breaks silently
    // (`project_lockfile_moves_break_root_anchored_resolve`).
    // Resolve the package MAIN, not `package.json`: the SDK's `exports` map
    // does not expose `./package.json`, so the obvious form throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED and this gate would skip itself into
    // permanent green.
    const require = createRequire(import.meta.url);
    const main = require.resolve('@anthropic-ai/claude-agent-sdk');
    dts = fs.readFileSync(path.join(path.dirname(main), 'sdk-tools.d.ts'), 'utf8');
  } catch {
    return null;
  }
  // `export type ToolInputSchemas =` … up to the first `;`. The union's last
  // member is `ToolOutputSchemas`, which is not a tool.
  const m = dts.match(/export type ToolInputSchemas\s*=([\s\S]*?);/);
  if (!m) return null;
  return [...m[1]!.matchAll(/\|\s*([A-Za-z0-9_]+)Input\b/g)]
    .map((x) => x[1]!)
    .map((n) => TYPE_NAME_ALIASES[n] ?? n);
}

const sdkTools = readSdkToolNames();

describe('[security] delegate-only strip list vs the SDK tool catalogue', () => {
  test('the extraction actually found the catalogue — anti-vacuity', () => {
    // Without this, a rename in the generated file turns every assertion below
    // into a scan of an empty list, which passes for any constant at all.
    expect(sdkTools).not.toBeNull();
    expect(sdkTools!.length).toBeGreaterThan(20);
    // Two spot checks that the alias map is being applied: the d.ts says
    // `FileEditInput`, the tool is `Edit`, and a name with no alias survives.
    expect(sdkTools).toContain('Edit');
    expect(sdkTools).toContain('Bash');
    expect(sdkTools).not.toContain('FileEdit');
  });

  test('every catalogue tool is either stripped or explicitly allowed', () => {
    const covered = new Set([...DELEGATE_ONLY_DISALLOWED, ...DELEGATE_ONLY_ALLOWED]);
    const uncovered = sdkTools!.filter((t) => !covered.has(t));
    expect(
      uncovered,
      'The SDK ships a built-in that a delegate-only agent would still see in ' +
        'context. Add it to DELEGATE_ONLY_DISALLOWED, or to DELEGATE_ONLY_ALLOWED ' +
        'here with the reason a router legitimately needs it.',
    ).toEqual([]);
  });

  test('the two allowed tools are NOT stripped', () => {
    // The other direction of the same rule: over-wide is a different bug from
    // too-narrow, and this list is the one that would silently break routing.
    for (const t of DELEGATE_ONLY_ALLOWED) expect(DELEGATE_ONLY_DISALLOWED).not.toContain(t);
    expect(DELEGATE_ONLY_DISALLOWED.some((t) => t.startsWith('mcp__'))).toBe(false);
  });

  test('no duplicate entries', () => {
    expect(new Set(DELEGATE_ONLY_DISALLOWED).size).toBe(DELEGATE_ONLY_DISALLOWED.length);
  });
});
