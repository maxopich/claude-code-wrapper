/**
 * Verify that this checkout's git hooks can actually run.
 *
 *   node scripts/verify-git-hooks.mjs
 *
 * WHY THIS EXISTS (`Cebab-o1to`). On 2026-09-18 an unattended run died in 27
 * SECONDS having spent zero turns, and parked three P1 beads as permanently
 * excluded for a fault none of them had. The cause was four steps removed from
 * anything the run touched:
 *
 *   1. `node_modules/husky/husky` — the helper the installer COPIES into place
 *      — was a symlink pointing at its own parent directory instead of a
 *      551-byte sh script.
 *   2. So `husky` died with `ENOTSUP: operation not supported on socket,
 *      copyfile … -> .husky/_/h`, and `.husky/_/h` was never written.
 *   3. `core.hooksPath` is `.husky/_`, and every shim there is
 *      `. "$(dirname "$0")/h"`. With `h` missing, EVERY git hook fails.
 *   4. So every `git checkout -b` failed, and a driver that cuts a branch per
 *      unit of work could not claim anything.
 *
 * THE POINT IS THAT NOTHING REPORTED IT. `npm test` (449 files), `lint`,
 * `typecheck` and every gate were green on a checkout whose git hooks could not
 * run — green is exactly what a repo looks like when its pre-commit checks have
 * silently stopped executing. The failure surfaced only as an unattended run
 * that did nothing all night and poisoned its own queue on the way out.
 *
 * SCOPE. This reports the broken state; it does not repair it, and it makes no
 * attempt to find whatever produced the self-symlinks (a scan found the same
 * `<pkg>/<pkg> -> <pkg>` shape on a dozen unrelated packages, all stamped the
 * same minute — cause unknown, deliberately out of scope). It is also NOT a
 * husky wrapper: if this repo's hooks are managed by something else, that is
 * not ours to judge and the check stands down.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where husky 9 installs, and the only hooksPath this check claims authority over. */
export const HUSKY_HOOKS_PATH = '.husky/_';

/** The file every shim in `.husky/_` sources. Missing `h` = every hook fails. */
export const HELPER_NAME = 'h';

/** The package-internal file husky copies FROM. A non-file here is the ENOTSUP case. */
export const SOURCE_REL = 'node_modules/husky/husky';

/**
 * Describe a path the way this check needs to see it: by `lstat`, so a symlink
 * reports as a symlink rather than as whatever it points at. That distinction
 * IS the bug — `stat` on the measured self-symlink answers "directory", and a
 * symlink to a real file would answer "file" while still not being the thing
 * npm was supposed to have installed.
 *
 * @returns {{kind: 'file'|'symlink'|'directory'|'other'|null, size: number|null}}
 */
export function describePath(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return { kind: null, size: null };
  }
  if (st.isSymbolicLink()) return { kind: 'symlink', size: null };
  if (st.isDirectory()) return { kind: 'directory', size: null };
  if (st.isFile()) return { kind: 'file', size: st.size };
  return { kind: 'other', size: null };
}

/**
 * The whole decision, as a pure function so every verdict is testable without
 * a git repo, an npm install, or a broken machine.
 *
 * Two verdicts pass on purpose and both are narrow. `no-git` is a tarball or
 * non-git checkout, where hooks are neither installed nor needed.
 * `not-husky-managed` is a checkout whose `core.hooksPath` points somewhere
 * else — this check knows nothing about that arrangement and must not fail it.
 * Everything else in a git checkout means the hooks are installed-but-dead,
 * which is the silent state this exists to make loud.
 *
 * @returns {{ok: boolean, verdict: string, message: string}}
 */
export function evaluate({ isGitCheckout, hooksPath, source, helper }) {
  if (!isGitCheckout) {
    return {
      ok: true,
      verdict: 'no-git',
      message: 'not a git checkout — no hooks to install, nothing to verify.',
    };
  }
  if (hooksPath && hooksPath !== HUSKY_HOOKS_PATH) {
    return {
      ok: true,
      verdict: 'not-husky-managed',
      message: `core.hooksPath is "${hooksPath}", not "${HUSKY_HOOKS_PATH}" — hooks are managed by something other than husky, so this check stands down.`,
    };
  }
  if (!hooksPath) {
    return {
      ok: false,
      verdict: 'hooks-not-installed',
      message:
        'git core.hooksPath is unset after the hook installer ran, so git is ' +
        'using .git/hooks and none of this repo’s hooks will fire. Run ' +
        '`npm run bootstrap` again and read the husky step’s output.',
    };
  }
  if (source.kind === null) {
    return {
      ok: false,
      verdict: 'source-missing',
      message:
        `${SOURCE_REL} does not exist, so the hook helper cannot be installed. ` +
        'Reinstall dependencies with `npm install --ignore-scripts`.',
    };
  }
  if (source.kind !== 'file') {
    return {
      ok: false,
      verdict: 'source-not-a-file',
      message:
        `${SOURCE_REL} is a ${source.kind}, not a regular file — the installed ` +
        'husky package is corrupt. This is the case that reports itself as an ' +
        'opaque `ENOTSUP … copyfile` from the installer. Delete node_modules/husky ' +
        'and run `npm install --ignore-scripts`.',
    };
  }
  const helperRel = `${hooksPath}/${HELPER_NAME}`;
  if (helper.kind === null) {
    return {
      ok: false,
      verdict: 'helper-missing',
      message:
        `${helperRel} does not exist. Every shim in ${hooksPath} sources it, so ` +
        'EVERY git hook fails — including post-checkout, which makes `git ' +
        'checkout -b` exit non-zero. Run `npm run bootstrap` again.',
    };
  }
  if (helper.kind !== 'file') {
    return {
      ok: false,
      verdict: 'helper-not-a-file',
      message:
        `${helperRel} is a ${helper.kind}, not a regular file. Every git hook ` +
        'sources it and will fail. Delete it and run `npm run bootstrap` again.',
    };
  }
  if (helper.size === 0) {
    return {
      ok: false,
      verdict: 'helper-empty',
      message:
        `${helperRel} is empty. An empty file is readable, so git hooks "run" and ` +
        'do nothing — which looks exactly like hooks that passed. Delete it and ' +
        'run `npm run bootstrap` again.',
    };
  }
  return {
    ok: true,
    verdict: 'ok',
    message: `git hooks are installed and ${helperRel} is a regular file.`,
  };
}

/** Ask git what it is actually doing, rather than assuming from a `.git` entry. */
export function readGitState(repoRoot = REPO_ROOT) {
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let isGitCheckout;
  try {
    isGitCheckout = git(['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return { isGitCheckout: false, hooksPath: null };
  }
  if (!isGitCheckout) return { isGitCheckout: false, hooksPath: null };
  let hooksPath;
  try {
    hooksPath = git(['config', 'core.hooksPath']) || null;
  } catch {
    // `git config` exits 1 when the key is unset. That is the unset case, not
    // an error — and it is a FAILING verdict, so it must not be swallowed into
    // a pass by pretending the key said something.
    hooksPath = null;
  }
  return { isGitCheckout, hooksPath };
}

/** Read everything `evaluate` needs from a real checkout. */
export function readHookState(repoRoot = REPO_ROOT) {
  const { isGitCheckout, hooksPath } = readGitState(repoRoot);
  return {
    isGitCheckout,
    hooksPath,
    source: describePath(path.join(repoRoot, SOURCE_REL)),
    helper: describePath(path.join(repoRoot, hooksPath ?? HUSKY_HOOKS_PATH, HELPER_NAME)),
  };
}

function main() {
  const result = evaluate(readHookState());
  const label = result.ok ? 'ok  ' : 'FAIL';
  console[result.ok ? 'log' : 'error'](`[hooks-verify] ${label} ${result.message}`);
  if (!result.ok) {
    console.error(
      '[hooks-verify] git hooks that cannot run are invisible to tests, lint ' +
        'and typecheck — they all pass while every pre-commit check is skipped.',
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
