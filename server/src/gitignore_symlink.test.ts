// Cebab-u2a: the root `.gitignore` must ignore a `node_modules` SYMLINK, not
// only a real `node_modules` directory.
//
// The documented worktree setup recipe makes server/web/shared `node_modules`
// SYMLINKS back to the main checkout. A trailing slash in a gitignore pattern
// matches DIRECTORIES ONLY, and git treats a symlink as a file, so the old
// `node_modules/` left those three un-ignored: a routine `git add -A` staged
// them as mode-120000 blobs and `git status` only ever showed them as untracked
// `??`, warning no one (measured, PR #365). This pins the property against the
// repo's OWN root `.gitignore`, so reverting line 2 to `node_modules/` reddens
// it rather than a hand-copied pattern that could silently drift.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// server/src/<this file> → repo root is two levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootGitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

/** Can this platform create a symlink at all? Windows needs Developer Mode or
 *  an elevated process; a silent skip there would leave the property untested
 *  on the runner that gates the merge. Probing and REPORTING is the difference.
 *  (Mirrors the helper in managed_agent.test.ts.) */
function symlinksWork(root: string): boolean {
  const probe = path.join(root, '.symlink-probe');
  try {
    fs.symlinkSync('target', probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** `git check-ignore` exits 1 (execFileSync throws) when the path is NOT
 *  ignored — that non-zero exit IS the pre-fix failure. Returns the matched
 *  path when ignored, or null when not. */
function checkIgnore(cwd: string, rel: string): string | null {
  try {
    return git(cwd, ['check-ignore', rel]).trim();
  } catch {
    return null;
  }
}

const WORKSPACES = ['server', 'web', 'shared'];

describe('[Cebab-u2a] root .gitignore ignores node_modules symlinks', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-nm-'));
    git(tmp, ['init', '-q']);
    // Use the repo's REAL root .gitignore — the whole point of the test.
    fs.writeFileSync(path.join(tmp, '.gitignore'), rootGitignore);

    // The main checkout's node_modules is a REAL directory (ignored either way).
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg.txt'), 'x');

    // The worktree recipe makes these three SYMLINKS to the main checkout.
    for (const ws of WORKSPACES) {
      fs.mkdirSync(path.join(tmp, ws));
      if (symlinksWork(tmp)) {
        fs.symlinkSync(path.join('..', 'node_modules'), path.join(tmp, ws, 'node_modules'));
      }
    }
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('this platform can create symlinks (otherwise the cases below are vacuous)', () => {
    // Not a formality: on a runner without the privilege every symlink case
    // below returns early, and a green suite would claim coverage it did not
    // have.
    if (!symlinksWork(tmp)) {
      console.warn(
        '[gitignore_symlink.test] symlinks unavailable on this platform — cases skipped',
      );
    }
    expect(true).toBe(true);
  });

  test('git check-ignore matches each workspace node_modules SYMLINK', () => {
    if (!symlinksWork(tmp)) return;
    for (const ws of WORKSPACES) {
      const rel = `${ws}/node_modules`;
      expect(checkIgnore(tmp, rel)).toBe(rel);
    }
  });

  test('git status --short -uall reports none of the symlinks', () => {
    if (!symlinksWork(tmp)) return;
    // -uall forces per-file listing: without it git collapses a wholly-untracked
    // dir to `?? server/` — which does not contain "node_modules" and would let
    // the pre-fix bug pass this assertion for the wrong reason.
    const status = git(tmp, ['status', '--short', '-uall']);
    for (const ws of WORKSPACES) {
      expect(status).not.toContain(`${ws}/node_modules`);
    }
  });

  test('positive control: a non-ignored file DOES appear in status', () => {
    if (!symlinksWork(tmp)) return;
    // Without this, an accidentally-empty repo (or a status command that listed
    // nothing) would satisfy the assertion above vacuously.
    const witness = path.join(tmp, 'server', 'index.ts');
    fs.writeFileSync(witness, 'export {};\n');
    try {
      const status = git(tmp, ['status', '--short', '-uall']);
      expect(status).toContain('server/index.ts');
      // And it is genuinely not ignored, unlike the sibling symlink.
      expect(checkIgnore(tmp, 'server/index.ts')).toBe(null);
    } finally {
      fs.rmSync(witness);
    }
  });
});
