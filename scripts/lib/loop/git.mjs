/**
 * Autonomous loop — git.
 *
 * R6 BRANCH DISCIPLINE. Work always happens on `loop/<bead-id>`, never on
 * `main`, and the repo is returned to `main` on every terminating path —
 * success, park, halt, crash, signal. `branchNameFor` is the single place the
 * prefix is decided so the maintainer can bulk-delete the loop's branches.
 *
 * R7 DIFFSTAT AFTER COMMIT. `lint-staged` runs `eslint --fix` and
 * `prettier --write` over staged files during the pre-commit hook, so a
 * diffstat measured before the commit is stale — it describes bytes that no
 * longer exist. `statOfHead` reads `git show --stat HEAD` instead.
 *
 * NEVER `--no-verify`. The husky pre-commit hook is lint-staged plus
 * `gitleaks protect --staged`, which is a free extra gate on every commit the
 * loop makes; skipping it is also on the guard's `forbidInDiff` list.
 */
import { parseDiffLines, parseDiffStat } from './guard.mjs';

export const branchNameFor = (beadId) => `loop/${beadId}`;

export function commitSubject(verdict, beadId) {
  const scope = verdict.commit_scope ? `(${verdict.commit_scope})` : '';
  return `${verdict.commit_type}${scope}: ${verdict.commit_subject} (${beadId})`;
}

export function makeGit({ run, cwd, dryRun = false }) {
  const git = (args, opts = {}) => run('git', args, { cwd, timeoutMs: 120000, ...opts });
  const write = async (args, opts) =>
    dryRun ? { code: 0, stdout: '', stderr: '' } : git(args, opts);

  const api = {
    async currentBranch() {
      const r = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      return r.stdout.trim();
    },
    async isClean() {
      const r = await git(['status', '--porcelain']);
      return r.stdout.trim() === '';
    },
    async toMain() {
      // The teardown path. `-q` because a detached run tees stdout to a log.
      await write(['checkout', '-q', 'main']);
      return write(['pull', '--ff-only', '-q']);
    },
    async resetHard() {
      return write(['reset', '--hard', '-q']);
    },
    async newBranch(beadId) {
      return write(['checkout', '-q', '-b', branchNameFor(beadId)]);
    },
    /**
     * Stage and commit. Explicit `add -A` is correct HERE and only here: this
     * runs in the main checkout, which the driver has already asserted was
     * clean at SELECT, so everything present is the agent's work. (The
     * `git add -A` warning in project memory is about WORKTREES, whose
     * node_modules symlinks are untracked and not gitignored.)
     */
    async commit(message) {
      const staged = await write(['add', '-A']);
      if (staged.code !== 0) return staged;
      return write(['commit', '-q', '-F', '-'], { input: message });
    },
    async push(beadId, { force = false } = {}) {
      const args = ['push', '-u', 'origin', branchNameFor(beadId)];
      // A repair amends the same branch rather than opening a second PR.
      if (force) args.push('--force-with-lease');
      return write(args);
    },
    /** Post-commit truth (R7). */
    async statOfHead() {
      const numstat = await git(['show', '--numstat', '--format=', 'HEAD']);
      const nameStatus = await git(['show', '--name-status', '--format=', 'HEAD']);
      const files = parseDiffStat(numstat.stdout, nameStatus.stdout);
      return {
        files: files.length,
        insertions: files.reduce((s, f) => s + f.insertions, 0),
        deletions: files.reduce((s, f) => s + f.deletions, 0),
      };
    },
    /** Everything the guard needs, from the branch's whole diff against main. */
    async diffForGuard() {
      const numstat = await git(['diff', '--numstat', 'main...HEAD']);
      const nameStatus = await git(['diff', '--name-status', 'main...HEAD']);
      const full = await git(['diff', 'main...HEAD']);
      return {
        files: parseDiffStat(numstat.stdout, nameStatus.stdout),
        ...parseDiffLines(full.stdout),
      };
    },
    /** Paths only — used to decide whether the Playground tier is triggered. */
    async changedPaths() {
      const r = await git(['diff', '--name-only', 'main...HEAD']);
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    },
    /** R4: CI runs this exact check, so failing it here saves a round trip. */
    async lockfileChanged() {
      const r = await git([
        'diff',
        '--exit-code',
        '--quiet',
        'main...HEAD',
        '--',
        'package-lock.json',
      ]);
      return r.code !== 0;
    },
    async deleteBranch(beadId) {
      return write(['branch', '-D', branchNameFor(beadId)]);
    },
  };
  return api;
}
