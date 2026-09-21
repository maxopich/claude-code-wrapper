/**
 * The hook check, and the ways it could pass on a checkout whose hooks are dead.
 *
 * `scripts/verify-git-hooks.mjs` exists because tests, lint and typecheck are
 * all green on exactly that checkout (`Cebab-o1to`), so the failure that matters
 * here is not "it reports a broken helper wrongly" — it is "it reports OK when
 * nothing can run". The cases below are built around the shape that was actually
 * measured: a package-internal file replaced by a symlink to its own parent
 * directory.
 *
 * Be precise about what that shape defeats, because it is easy to overstate.
 * `existsSync` MISSES it outright — the path is there. `statSync` does not: it
 * follows the link, reports "directory", and a check written on it would still
 * refuse. What `lstat` buys is the ATTRIBUTION — "this is a symlink" is what
 * sends someone to reinstall the package, where "this is a directory" invites
 * them to go looking for a directory that does not exist. Both are covered
 * below, separately, so neither claim rests on the other.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HELPER_NAME,
  HUSKY_HOOKS_PATH,
  SOURCE_REL,
  describePath,
  evaluate,
  readHookState,
} from './verify-git-hooks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILE = { kind: 'file', size: 551 };
const DIR = { kind: 'directory', size: null };
const ABSENT = { kind: null, size: null };
const GOOD = {
  isGitCheckout: true,
  hooksPath: HUSKY_HOOKS_PATH,
  hooksDir: DIR,
  source: FILE,
  helper: FILE,
};

const temps = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** The measured shape: `<pkg>/<pkg>` pointing at `<pkg>`. Junction on Windows,
 *  where an unprivileged process cannot create a directory symlink. */
function selfSymlink(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('evaluate', () => {
  test('a healthy git checkout passes', () => {
    expect(evaluate(GOOD)).toMatchObject({ ok: true, verdict: 'ok' });
  });

  test('a source that is a symlink FAILS, and the message names the file', () => {
    // The measured ENOTSUP case. `source.kind` is the only field that moves.
    const r = evaluate({ ...GOOD, source: { kind: 'symlink', size: null } });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('source-not-a-file');
    expect(r.message).toContain(SOURCE_REL);
  });

  test('a missing helper FAILS, and says every hook fails with it', () => {
    const r = evaluate({ ...GOOD, helper: ABSENT });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('helper-missing');
    expect(r.message).toContain(`${HUSKY_HOOKS_PATH}/${HELPER_NAME}`);
  });

  test('a helper that is a directory FAILS rather than counting as present', () => {
    const r = evaluate({ ...GOOD, helper: { kind: 'directory', size: null } });
    expect(r).toMatchObject({ ok: false, verdict: 'helper-not-a-file' });
  });

  test('an EMPTY helper FAILS — readable, and does nothing', () => {
    // A zero-byte helper is the one broken state that looks like success from
    // the outside: every hook sources it, exits 0, and checks silently stop.
    const r = evaluate({ ...GOOD, helper: { kind: 'file', size: 0 } });
    expect(r).toMatchObject({ ok: false, verdict: 'helper-empty' });
  });

  test('a git checkout with no core.hooksPath FAILS when husky IS installed', () => {
    // The two halves are separate findings: husky present + no hooksPath means
    // the install ran and did not take, which is a real failure. Husky absent
    // is the warning above. Asserted together so neither can absorb the other.
    expect(evaluate({ ...GOOD, hooksPath: null })).toMatchObject({
      ok: false,
      verdict: 'hooks-not-installed',
    });
    expect(evaluate({ ...GOOD, hooksPath: null, source: ABSENT }).ok).toBe(true);
  });

  test('hooks managed by something other than husky PASS, deliberately', () => {
    // Narrow on purpose: this check knows nothing about another manager's
    // layout and must not fail a repo it has no authority over.
    const r = evaluate({ ...GOOD, hooksPath: '.config/other-hooks', hooksDir: DIR });
    expect(r).toMatchObject({ ok: true, verdict: 'not-husky-managed' });
  });

  test('...but a hooksPath pointing at NOTHING fails, standing down or not', () => {
    // Standing down is not approving. A hooksPath aimed at a directory that
    // does not exist means git runs no hooks and says nothing — the same
    // silent state, reached another way. `bd init` repoints this repo at
    // `.beads/hooks`, which is gitignored, so `git clean -xdff` produces it.
    const r = evaluate({ ...GOOD, hooksPath: '.beads/hooks', hooksDir: ABSENT });
    expect(r).toMatchObject({ ok: false, verdict: 'hooks-path-missing' });
    expect(r.message).toContain('.beads/hooks');
  });

  test('husky not installed at all WARNS rather than aborting', () => {
    // NODE_ENV=production, --omit=dev and npm_config_omit=dev all skip
    // devDependencies, so husky never arrives and no hooks were ever going to
    // exist. Failing would brick an otherwise-successful install for no gain,
    // which is the call `verify:native` already makes for an unknown platform.
    const r = evaluate({ ...GOOD, source: ABSENT, helper: ABSENT, hooksPath: null });
    expect(r).toMatchObject({ ok: true, verdict: 'installer-absent' });
    expect(r.message).toMatch(/omit|production/i);
  });

  test('a non-git checkout PASSES, and is the only absent-hooks pass', () => {
    const r = evaluate({ ...GOOD, isGitCheckout: false, hooksPath: null, helper: ABSENT });
    expect(r).toMatchObject({ ok: true, verdict: 'no-git' });
  });
});

describe('describePath sees the link, where the cheap checks do not', () => {
  test('a self-symlink reports as a symlink, not as what it points at', () => {
    const root = tempDir('cebab-hooks-link-');
    const pkg = path.join(root, 'husky');
    fs.mkdirSync(pkg);
    const link = path.join(pkg, 'husky');
    selfSymlink(pkg, link);

    // Controls, one per cheaper implementation, and they do NOT say the same
    // thing. `existsSync` is satisfied by the broken tree, so a check built on
    // it passes on a repo whose hooks are dead.
    expect(fs.existsSync(link)).toBe(true);
    // `statSync` is not fooled — it resolves to a directory — so it would also
    // refuse. It just cannot say a link is involved, which is the difference
    // between "reinstall husky" and a hunt for a missing directory.
    expect(fs.statSync(link).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isDirectory()).toBe(false);

    expect(describePath(link)).toMatchObject({ kind: 'symlink' });
    const r = evaluate({ ...GOOD, source: describePath(link) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('symlink');
  });

  test('a real file reports as a file, with its size', () => {
    const root = tempDir('cebab-hooks-file-');
    const f = path.join(root, 'h');
    fs.writeFileSync(f, '#!/usr/bin/env sh\n');
    expect(describePath(f)).toMatchObject({ kind: 'file' });
    expect(describePath(f).size).toBeGreaterThan(0);
  });

  test('an absent path reports null rather than throwing', () => {
    expect(describePath(path.join(tempDir('cebab-hooks-gone-'), 'nope'))).toEqual(ABSENT);
  });
});

describe('readHookState against real checkouts', () => {
  /**
   * Git reads `core.hooksPath` from GLOBAL and SYSTEM scope too, and
   * `git config --global core.hooksPath` is the standard way to install hooks
   * for every repo on a machine. Without this isolation the fresh-repo cases
   * below inherit a contributor's own setting and report `not-husky-managed`
   * on a repo that has nothing — the same class as the CRLF and locale traps:
   * green here, a coin flip on somebody else's machine.
   */
  let emptyConfig;
  const savedEnv = {};
  beforeAll(() => {
    emptyConfig = path.join(tempDir('cebab-hooks-cfg-'), 'gitconfig');
    fs.writeFileSync(emptyConfig, '');
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
      savedEnv[k] = process.env[k];
      process.env[k] = emptyConfig;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function initRepo() {
    const root = tempDir('cebab-hooks-repo-');
    execFileSync('git', ['-C', root, 'init', '--quiet'], { stdio: 'ignore' });
    return root;
  }
  /** Just the package file husky copies FROM. */
  function installSource(root) {
    fs.mkdirSync(path.join(root, 'node_modules', 'husky'), { recursive: true });
    fs.writeFileSync(path.join(root, SOURCE_REL), '#!/usr/bin/env sh\n');
  }
  function setHooksPath(root, value) {
    execFileSync('git', ['-C', root, 'config', 'core.hooksPath', value], { stdio: 'ignore' });
  }
  /** A correct, complete install. */
  function installHooks(root) {
    setHooksPath(root, HUSKY_HOOKS_PATH);
    fs.mkdirSync(path.join(root, HUSKY_HOOKS_PATH), { recursive: true });
    fs.writeFileSync(path.join(root, HUSKY_HOOKS_PATH, HELPER_NAME), '#!/usr/bin/env sh\n');
    installSource(root);
  }

  test('a directory that is not a repo reads as no-git', () => {
    const root = tempDir('cebab-hooks-bare-');
    expect(readHookState(root)).toMatchObject({ isGitCheckout: false, hooksPath: null });
    expect(evaluate(readHookState(root))).toMatchObject({ ok: true, verdict: 'no-git' });
  });

  test('a fresh repo with husky never installed WARNS', () => {
    const root = initRepo();
    expect(readHookState(root).isGitCheckout).toBe(true);
    expect(evaluate(readHookState(root))).toMatchObject({
      ok: true,
      verdict: 'installer-absent',
    });
  });

  test('a fresh repo WITH husky present but no hooksPath FAILS', () => {
    // The install ran and did not take. Distinguished from the case above only
    // by the presence of the package, which is the whole point of the split.
    const root = initRepo();
    installSource(root);
    expect(evaluate(readHookState(root))).toMatchObject({
      ok: false,
      verdict: 'hooks-not-installed',
    });
  });

  test('a correctly installed repo PASSES — the green control', () => {
    const root = initRepo();
    installHooks(root);
    expect(evaluate(readHookState(root))).toMatchObject({ ok: true, verdict: 'ok' });
  });

  test('an ABSOLUTE hooksPath naming the same directory is still husky', () => {
    // Comparing the raw string would stand the check down on this repo's own
    // hook tree because the operator spelled the path differently, and the old
    // join() would then have built a nonsense helper path from it.
    const root = initRepo();
    installHooks(root);
    setHooksPath(root, path.join(root, HUSKY_HOOKS_PATH));
    expect(readHookState(root).hooksPath).toBe(HUSKY_HOOKS_PATH);
    expect(evaluate(readHookState(root))).toMatchObject({ ok: true, verdict: 'ok' });

    fs.rmSync(path.join(root, HUSKY_HOOKS_PATH, HELPER_NAME));
    expect(evaluate(readHookState(root))).toMatchObject({ ok: false, verdict: 'helper-missing' });
  });

  test('a hooksPath pointing at a directory that does not exist FAILS', () => {
    const root = initRepo();
    installSource(root);
    setHooksPath(root, '.beads/hooks');
    expect(evaluate(readHookState(root))).toMatchObject({
      ok: false,
      verdict: 'hooks-path-missing',
    });
  });

  test('the SAME repo fails once the source becomes a self-symlink', () => {
    // End to end, through the real readers, with only the measured mutation
    // between the green control above and this red. Nothing else differs.
    const root = initRepo();
    installHooks(root);
    const pkg = path.join(root, 'node_modules', 'husky');
    fs.rmSync(path.join(pkg, 'husky'));
    selfSymlink(pkg, path.join(pkg, 'husky'));

    expect(evaluate(readHookState(root))).toMatchObject({
      ok: false,
      verdict: 'source-not-a-file',
    });
  });

  test('the SAME repo fails once the installed helper is removed', () => {
    const root = initRepo();
    installHooks(root);
    fs.rmSync(path.join(root, HUSKY_HOOKS_PATH, HELPER_NAME));
    expect(evaluate(readHookState(root))).toMatchObject({ ok: false, verdict: 'helper-missing' });
  });

  test('the SCRIPT exits non-zero on a broken repo and zero on a good one', () => {
    // The exit code is what bootstrap acts on, and asserting it here is the
    // only part of the abort that is tested for real rather than by reading
    // bootstrap's source. Both directions, because a script that always exited
    // 1 would satisfy the red half alone.
    const script = path.join(repoRoot, 'scripts', 'verify-git-hooks.mjs');
    const run = (root) => {
      try {
        execFileSync(process.execPath, [script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
        return 0;
      } catch (err) {
        return err.status ?? 1;
      }
    };
    const good = initRepo();
    installHooks(good);
    expect(run(good), 'a correct install must exit 0').toBe(0);

    const bad = initRepo();
    installHooks(bad);
    fs.rmSync(path.join(bad, HUSKY_HOOKS_PATH, HELPER_NAME));
    expect(run(bad), 'a dead helper must exit non-zero').not.toBe(0);
  });
});

describe('bootstrap wiring', () => {
  // The check is only worth anything if it RUNS, in the right order, and can
  // stop the install. All three are properties of bootstrap.mjs rather than of
  // the check, so none of the cases above can see them.
  const bootstrap = fs.readFileSync(new URL('./bootstrap.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  test('the npm script bootstrap invokes actually exists', () => {
    // Not cosmetic: `npm run <missing>` exits non-zero, so a typo here would
    // abort EVERY install rather than only broken ones.
    expect(pkg.scripts['verify:hooks']).toContain('verify-git-hooks.mjs');
  });

  test('bootstrap runs the check AFTER the hook installer, and aborts on it', () => {
    // Be honest about what this is: a SOURCE assertion, because bootstrap is a
    // top-level-await script whose first step is a real `npm install`, and
    // there is no cheap way to execute its abort. An earlier version of this
    // case only checked that `process.exit(hooksCode)` appeared somewhere
    // after `'verify:hooks'` — which `if (hooksCode === 0) process.exit(...)`
    // also satisfies, so bootstrap could be mutated to never abort and this
    // stayed green. The guard EXPRESSION is pinned now, and the exit code that
    // matters end to end is covered for real by the script case above.
    const husky = bootstrap.indexOf("'husky'");
    const verify = bootstrap.indexOf("'verify:hooks'");
    expect(husky, 'husky invocation not found — locate by content').toBeGreaterThan(-1);
    expect(verify, 'verify:hooks invocation not found').toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(husky);
    expect(bootstrap.slice(verify)).toMatch(
      /if \(hooksCode !== 0\) \{[\s\S]{0,300}?process\.exit\(hooksCode\);/,
    );
  });
});
