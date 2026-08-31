import fs from 'node:fs';
import os from 'node:os';
import { afterAll, describe, expect, test } from 'vitest';
import { join, resolve, sep } from 'node:path';
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
 *
 * `Cebab-2t9.3`: no longer purely a pure-function file. The classifier now
 * resolves both sides through symlinks, so the cases at the bottom build real
 * directories and real links under `os.tmpdir()`. The cases above stay
 * filesystem-free and still pass, because a path that does not exist falls
 * back to the lexical comparison — which is the property that makes the
 * change unable to invent a false positive.
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
    // `Cebab-2t9.3` REWROTE this case rather than deleting it. It used to
    // assert `resolvedPath === resolve(POSIX_CWD, filePath)`, i.e. the path as
    // typed. The classifier now reports the path actually written, and on
    // macOS those differ for this very fixture: `/etc` is a symlink to
    // `/private/etc`. The verdict — the part that matters — is unchanged, and
    // is still asserted exactly.
    //
    // The expectation is derived with `fs.realpathSync`, Node's own primitive,
    // NOT with a reimplementation of the classifier's ancestor walk. A test
    // that ports the implementation agrees with its bugs. The try/catch is the
    // cross-platform half: on Windows this resolves drive-relative to
    // something that does not exist, and the classifier then falls back to
    // lexical — so the test must too.
    const filePath = '/etc/passwd';
    const out = classifyMutationScope({ agentCwd: POSIX_CWD, filePath });
    const lexical = resolve(POSIX_CWD, filePath);
    let expected = lexical;
    try {
      expected = fs.realpathSync(lexical);
    } catch {
      /* absent on this platform — lexical is the classifier's answer too */
    }
    expect(out).toEqual({
      inScope: false,
      resolvedPath: expected,
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

/**
 * `Cebab-2t9.3` — the symlink horn of the mutation detector.
 *
 * THE ESCAPE THESE EXIST FOR, and it is reachable rather than theoretical.
 * `Bash` reaches the classifier with `filePath: undefined` and returns
 * in-scope before any path logic runs, so an agent can create a link with a
 * shell command that is never path-classified, then `Write` through it with a
 * path that is lexically inside its own cwd. The old comparison was
 * `resolve()` only — purely lexical — so it called that in-scope while the
 * write landed wherever the link pointed.
 *
 * REAL LINKS ON DISK, not a mocked `fs`. A fake would model what I believe
 * `realpathSync` does, and the two bugs found while writing this were both in
 * that belief: an ancestor walk that turned `/workspace` into `/orkspace`, and
 * the assumption that resolving only the target side was safe (it is not —
 * `os.tmpdir()` is itself a symlink on macOS, which is why every fixture here
 * would read as out-of-scope if the cwd were not resolved too).
 */
describe('classifyMutationScope — symlinks (Cebab-2t9.3)', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'cebab-guardrail-link-'));
  const cwd = join(root, 'project');
  const outside = join(root, 'outside');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(join(outside, 'secret.txt'), 'x');
  fs.writeFileSync(join(cwd, 'real.txt'), 'x');

  // Can this platform make symlinks at all? Windows needs a privilege or
  // Developer Mode, so the answer is genuinely "sometimes". Probed rather
  // than assumed — and the probe is what turns a silent always-skip into a
  // visible one.
  let canLink = true;
  try {
    fs.symlinkSync(join(outside, 'secret.txt'), join(root, '__probe'));
    fs.unlinkSync(join(root, '__probe'));
  } catch {
    canLink = false;
  }

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('the fixture is real, and the control is in-scope', () => {
    // Without this the escape cases below could pass for the wrong reason —
    // e.g. a cwd that resolves to nothing would make EVERYTHING out-of-scope.
    // `os.tmpdir()` is a symlink on macOS, so this also pins the both-sides
    // rule: resolving only the target would redden this line.
    expect(fs.existsSync(join(cwd, 'real.txt'))).toBe(true);
    expect(classifyMutationScope({ agentCwd: cwd, filePath: join(cwd, 'real.txt') })).toEqual({
      inScope: true,
    });
    expect(classifyMutationScope({ agentCwd: cwd, filePath: 'real.txt' })).toEqual({
      inScope: true,
    });
  });

  test.skipIf(!canLink)('a link inside cwd pointing OUT is out-of-scope', () => {
    // The bead's case, end to end. Lexically `<cwd>/notes.txt` — the old
    // classifier said in-scope; the write lands in `outside/`.
    const link = join(cwd, 'notes.txt');
    fs.symlinkSync(join(outside, 'secret.txt'), link);
    const out = classifyMutationScope({ agentCwd: cwd, filePath: link });
    expect(out.inScope).toBe(false);
    expect(out.inScope === false && out.reasonCode).toBe('path_outside_cwd');
    // It names the file actually written, which is the operator's question.
    expect(out.inScope === false && out.resolvedPath).toBe(
      fs.realpathSync(join(outside, 'secret.txt')),
    );
  });

  test.skipIf(!canLink)('a symlinked PARENT redirects a file that does not exist yet', () => {
    // The case a leaf-only `realpathSync` misses, and the one a `Write`
    // actually takes: the target file is about to be created, so nothing at
    // the leaf can be resolved. The escape is one level up.
    const linkDir = join(cwd, 'notes');
    fs.symlinkSync(outside, linkDir);
    const out = classifyMutationScope({ agentCwd: cwd, filePath: join(linkDir, 'brand-new.txt') });
    expect(out.inScope).toBe(false);
    expect(out.inScope === false && out.resolvedPath).toBe(
      join(fs.realpathSync(outside), 'brand-new.txt'),
    );
  });

  test.skipIf(!canLink)('a link pointing back INSIDE cwd stays in-scope', () => {
    // The other direction, and the one that decides whether this is safe to
    // leave on for every mutation. Following links must not manufacture a
    // violation for a link that resolves within the agent's own folder.
    const link = join(cwd, 'alias.txt');
    fs.symlinkSync(join(cwd, 'real.txt'), link);
    expect(classifyMutationScope({ agentCwd: cwd, filePath: link })).toEqual({ inScope: true });
  });

  test.skipIf(!canLink)('a DANGLING link is judged by where it points', () => {
    // `realpathSync` throws on these, so a naive implementation falls back to
    // lexical and calls it in-scope. A write through a dangling link creates
    // the target — outside — so the honest answer is out-of-scope.
    const link = join(cwd, 'dangling.txt');
    fs.symlinkSync(join(outside, 'not-there-yet.txt'), link);
    const out = classifyMutationScope({ agentCwd: cwd, filePath: link });
    expect(out.inScope).toBe(false);
    expect(out.inScope === false && out.resolvedPath).toBe(
      join(fs.realpathSync(outside), 'not-there-yet.txt'),
    );
  });

  test('a cwd that does not exist yet still classifies correctly', () => {
    // NOT a fallback case, which is why the first draft of this test was wrong
    // and worth keeping the correction visible: neither side existing does not
    // mean neither side RESOLVES. The walk climbs to the deepest ancestor that
    // does exist — here `root` — so both sides come back resolved and the
    // comparison is the strong one.
    const ghost = join(root, 'no-such-dir');
    expect(classifyMutationScope({ agentCwd: ghost, filePath: 'a/b.txt' })).toEqual({
      inScope: true,
    });
    const out = classifyMutationScope({ agentCwd: ghost, filePath: join(root, 'elsewhere.txt') });
    expect(out.inScope).toBe(false);
    expect(out.inScope === false && out.resolvedPath).toBe(
      join(fs.realpathSync(root), 'elsewhere.txt'),
    );
  });

  test('past the ancestor cap it falls back to lexical, byte for byte', () => {
    // The actual fallback, reached deterministically by out-running
    // MAX_ANCESTOR_WALK rather than by hoping a filesystem call fails.
    //
    // This is the safety property of the whole change and the reason it needs
    // no opt-in: when resolution gives up, the answer must be EXACTLY the one
    // the old lexical code gave, so the change can only add detections and can
    // never invent one. Asserted against `resolve()` — the old implementation's
    // own primitive.
    const deep = join(root, ...Array.from({ length: 80 }, () => 'x'), 'file.txt');
    const out = classifyMutationScope({ agentCwd: cwd, filePath: deep });
    expect(out.inScope).toBe(false);
    expect(out.inScope === false && out.resolvedPath).toBe(resolve(cwd, deep));
    // And the in-scope direction of the same fallback: a deep path under the
    // agent's own folder must NOT become a violation just because resolution
    // gave up.
    const deepInside = join(cwd, ...Array.from({ length: 80 }, () => 'x'), 'file.txt');
    expect(classifyMutationScope({ agentCwd: cwd, filePath: deepInside })).toEqual({
      inScope: true,
    });
  });
});
