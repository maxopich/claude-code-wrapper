import { describe, expect, test } from 'vitest';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { classifyMutationScope } from './guardrail.js';

/**
 * Cluster F Phase D5+: unit tests for the path-scope classifier that
 * decides whether a bus worker's mutation targets a path inside the
 * agent's project folder. Pure-function tests — no DB, no SDK, no
 * filesystem reads.
 *
 * The classifier underpins the entire D5+ slice: every Write/Edit/
 * MultiEdit/NotebookEdit from a bus worker is run through it; an
 * out-of-scope verdict ships a safety_audit row + a sticky notification
 * + a UI badge on the mutation row. Getting the in/out-of-scope boundary
 * right (especially around the platform separator) is load-bearing.
 */

// The test paths look Posix-shaped for readability, but every
// expected `resolvedPath` is computed via `node:path.resolve` so the
// fixture matches the implementation's actual output on every
// platform. On Windows `resolve('/workspace/x', '/etc/passwd')` becomes
// `C:\etc\passwd` (or whatever drive is current), not `/etc/passwd` —
// hard-coding the expected value would cross-platform-break the test.
const POSIX_CWD = '/workspace/my-project';

describe('classifyMutationScope — in-scope cases', () => {
  test('undefined filePath (Bash, Task, bus_send) → in-scope', () => {
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: undefined })).toEqual({
      inScope: true,
    });
  });

  test('null filePath → in-scope', () => {
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: null })).toEqual({
      inScope: true,
    });
  });

  test('empty-string filePath → in-scope (treated as "no path")', () => {
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: '' })).toEqual({
      inScope: true,
    });
  });

  test('absolute path equal to agentCwd → in-scope', () => {
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: POSIX_CWD })).toEqual({
      inScope: true,
    });
  });

  test('absolute path strictly inside agentCwd → in-scope', () => {
    expect(
      classifyMutationScope({ agentCwd: POSIX_CWD, filePath: `${POSIX_CWD}/src/foo.ts` }),
    ).toEqual({ inScope: true });
  });

  test('deeply nested path inside agentCwd → in-scope', () => {
    expect(
      classifyMutationScope({
        agentCwd: POSIX_CWD,
        filePath: `${POSIX_CWD}/a/b/c/d/e/f.txt`,
      }),
    ).toEqual({ inScope: true });
  });

  test('relative path resolves against agentCwd → in-scope', () => {
    // `src/foo.ts` resolves to `/workspace/my-project/src/foo.ts`,
    // which is inside the cwd.
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: 'src/foo.ts' })).toEqual({
      inScope: true,
    });
  });

  test('relative path with ./ → in-scope', () => {
    expect(classifyMutationScope({ agentCwd: POSIX_CWD, filePath: './src/foo.ts' })).toEqual({
      inScope: true,
    });
  });
});

describe('classifyMutationScope — out-of-scope cases', () => {
  test('absolute path in a sibling project → out-of-scope', () => {
    const filePath = '/workspace/other-project/src/foo.ts';
    const out = classifyMutationScope({ agentCwd: POSIX_CWD, filePath });
    expect(out).toEqual({
      inScope: false,
      // Compute via the same resolver the implementation uses so the
      // test passes on both Posix (where this stays `/workspace/...`)
      // and Windows (where the leading `/` becomes drive-relative —
      // e.g. `C:\workspace\other-project\src\foo.ts`).
      resolvedPath: resolve(POSIX_CWD, filePath),
      reasonCode: 'path_outside_cwd',
    });
  });

  test('absolute system path → out-of-scope', () => {
    const filePath = '/etc/passwd';
    const out = classifyMutationScope({ agentCwd: POSIX_CWD, filePath });
    expect(out).toEqual({
      inScope: false,
      resolvedPath: resolve(POSIX_CWD, filePath),
      reasonCode: 'path_outside_cwd',
    });
  });

  test('/tmp scratch space → out-of-scope (scope is strictly the project folder)', () => {
    // The consultant prompt says "may write scratch/notes inside your
    // own project folder" — /tmp is outside the agent's folder, so it
    // counts as a violation. Operators inspecting the badge can see
    // it's a /tmp write and judge intent themselves.
    const out = classifyMutationScope({
      agentCwd: POSIX_CWD,
      filePath: '/tmp/scratch.txt',
    });
    expect(out.inScope).toBe(false);
  });

  test('relative path with ../ escaping cwd → out-of-scope', () => {
    // `../other/foo.ts` from `/workspace/my-project` resolves to
    // `/workspace/other/foo.ts`, which is outside the cwd.
    const out = classifyMutationScope({
      agentCwd: POSIX_CWD,
      filePath: '../other/foo.ts',
    });
    expect(out.inScope).toBe(false);
    if (!out.inScope) {
      expect(out.resolvedPath.endsWith(`other${sep}foo.ts`)).toBe(true);
    }
  });

  test('home-relative path NOT inside agent cwd → out-of-scope', () => {
    // `~/Documents/foo` expands to homedir(), which is not under the
    // worktree cwd in this fixture.
    const out = classifyMutationScope({
      agentCwd: POSIX_CWD,
      filePath: '~/Documents/foo.txt',
    });
    expect(out.inScope).toBe(false);
    if (!out.inScope) {
      expect(out.resolvedPath.startsWith(homedir())).toBe(true);
    }
  });
});

describe('classifyMutationScope — substring vs. boundary edge case', () => {
  test('/foo + filePath=/foobar/x is NOT in scope (separator boundary)', () => {
    // The classic prefix-match bug: a naive `resolved.startsWith(cwd)`
    // would treat `/foobar/x` as inside `/foo`. The classifier guards
    // against this with an explicit separator-suffix prefix check.
    const out = classifyMutationScope({
      agentCwd: '/foo',
      filePath: '/foobar/x',
    });
    expect(out.inScope).toBe(false);
  });

  test('/foo + filePath=/foo/x IS in scope', () => {
    expect(
      classifyMutationScope({
        agentCwd: '/foo',
        filePath: '/foo/x',
      }),
    ).toEqual({ inScope: true });
  });
});

describe('classifyMutationScope — defensive fallbacks', () => {
  test('empty agentCwd → in-scope (fail open; misconfig should not fire false positives)', () => {
    expect(
      classifyMutationScope({
        agentCwd: '',
        filePath: '/anywhere/foo.txt',
      }),
    ).toEqual({ inScope: true });
  });

  test('agentCwd with trailing separator is treated the same as without', () => {
    const withSep = classifyMutationScope({
      agentCwd: `${POSIX_CWD}${sep}`,
      filePath: `${POSIX_CWD}/src/foo.ts`,
    });
    const withoutSep = classifyMutationScope({
      agentCwd: POSIX_CWD,
      filePath: `${POSIX_CWD}/src/foo.ts`,
    });
    expect(withSep).toEqual(withoutSep);
    expect(withSep.inScope).toBe(true);
  });

  test('exact ~ (no slash) expands to homedir', () => {
    const out = classifyMutationScope({
      agentCwd: POSIX_CWD,
      filePath: '~',
    });
    expect(out.inScope).toBe(false);
    if (!out.inScope) {
      expect(out.resolvedPath).toBe(homedir());
    }
  });
});
