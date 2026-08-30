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
 *
 * MEASURE THE INDEX, NOT `main...HEAD`. BUILD edits the working tree and
 * commits nothing, and CLAIM's `newBranch` leaves HEAD equal to main — so
 * `git diff main...HEAD` at GATE or PUBLISH compares main to itself and
 * returns EMPTY. Measured with the real helpers against a repo holding an
 * uncommitted `.github/workflows/ci.yml` edit: `changedPaths()` was `[]` and
 * `evaluateGuard` passed with zero breaches. That is not a cosmetic bug — the
 * guard is the only thing deciding whether the loop may merge unattended, and
 * it was measuring nothing. Every pre-commit reader therefore stages first and
 * diffs the INDEX against the merge base, which is also correct AFTER a commit
 * (the index equals HEAD then), so there is one code path rather than two.
 *
 * `reset --hard` DOES NOT REMOVE UNTRACKED FILES. Measured. A file the agent
 * CREATES therefore survived teardown onto `main` and the next run's preflight
 * refused with "working tree is dirty". `restoreToMain` cleans as well as
 * resets; `clean -fd` spares gitignored paths, which is what keeps `.loop/`
 * (the lock and the ledger) and `.env` intact.
 */
import { parseDiffLines, parseDiffStat } from './guard.mjs';

/**
 * The prefix `branchNameFor` builds on, named so the two other places that need
 * to recognise a loop branch — the remote sweep below and the PR overlap report
 * in `forge.mjs` — derive it rather than spell it again. The header's claim
 * that the prefix is decided in one place was not true of its own module.
 */
export const LOOP_BRANCH_PREFIX = 'loop/';

export const branchNameFor = (beadId) => `${LOOP_BRANCH_PREFIX}${beadId}`;

/**
 * The bead id is appended only when it is not already there.
 *
 * The agent writes it into `commit_subject` on its own, because that IS this
 * repo's convention — every recent commit ends `(Cebab-xxx)` — and appending
 * unconditionally produced, on the very first PR the loop ever opened:
 *
 *   fix(web): give 8 hover-styled buttons a focus ring (Cebab-p5y) (Cebab-p5y)
 *
 * Telling the agent in the prompt not to write it would be the fragile half of
 * the fix: it depends on the model complying, every time, with an instruction
 * that contradicts the convention it can see in `git log`.
 */
export function commitSubject(verdict, beadId) {
  const scope = verdict.commit_scope ? `(${verdict.commit_scope})` : '';
  const subject = String(verdict.commit_subject ?? '').trim();
  // BOTH SPELLINGS, because the agent learned the short one from `git log`.
  // The first version matched the full id only, and the first commit the loop
  // ever merged came out as
  //
  //   fix(bus): refuse a delivery reaching the queue head after teardown
  //             (vie.32) (Cebab-vie.32) (#407)
  //
  // `vie.32` is this repo's own shorthand for a sub-bead, so this is the
  // convention working as intended and the guard being too literal — not a
  // model quirk to instruct away. Telling the agent not to write it stays the
  // fragile half of the fix: it depends on the model complying, every time,
  // with an instruction that contradicts what it can see in `git log`.
  const short = beadId.slice(beadId.indexOf('-') + 1);
  const suffixes = [`(${beadId})`, ...(short && short !== beadId ? [`(${short})`] : [])];
  const body = suffixes.some((s) => subject.endsWith(s)) ? subject : `${subject} (${beadId})`;
  return `${verdict.commit_type}${scope}: ${body}`;
}

export function makeGit({ run, cwd, dryRun = false }) {
  const git = (args, opts = {}) => run('git', args, { cwd, timeoutMs: 120000, ...opts });
  const write = async (args, opts) =>
    dryRun ? { code: 0, stdout: '', stderr: '' } : git(args, opts);
  /**
   * Restore operations run even under `--dry-run`, and that is the opposite of
   * every other mutation here for a reason: `--dry-run` skips branch creation
   * but NOT the BUILD stage (it runs SELECT..GATE by definition), so the
   * agent's edits land on `main` itself. Guarding the restore would leave them
   * there — the one outcome §12 names explicitly, "leaves the repo on main
   * with a clean tree". A dry run has MORE to clean up than a real one, not
   * less.
   */
  const restore = (args, opts) => git(args, opts);

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
      await restore(['checkout', '-q', 'main']);
      return restore(['pull', '--ff-only', '-q']);
    },
    /**
     * Put the checkout back exactly as preflight demands to find it: on main,
     * current, with nothing left over. Called at the END OF EVERY ITERATION,
     * not just at teardown — `newBranch` branches from whatever is checked
     * out, so without this the second bead branched off the first bead's
     * branch and its PR carried the first bead's commits.
     *
     * Order is load-bearing: discard tracked edits, remove the untracked files
     * `reset` leaves behind, and only then checkout — `git checkout main` with
     * uncommitted changes either refuses or carries them across.
     */
    async restoreToMain() {
      await restore(['reset', '--hard', '-q']);
      await restore(['clean', '-fdq']);
      await restore(['checkout', '-q', 'main']);
      const pulled = await restore(['pull', '--ff-only', '-q']);
      // THE PULL RESULT IS THE POINT, not a leftover return value. After a
      // merged iteration this pull is the ONLY thing that advances `main`, and
      // every later bead branches from whatever it leaves behind — so a pull
      // that fails silently makes bead 2..8 of an `--until 8` run build against
      // a base missing everything that landed ahead of them. It used to be
      // returned and discarded by all three callers, which is indistinguishable
      // from not measuring it at all.
      return {
        pulled: pulled.code === 0,
        detail: (pulled.stderr || pulled.stdout).trim().split('\n')[0] ?? '',
      };
    },
    /** Preflight only: is local `main` current with the remote? */
    async fetchMain() {
      return git(['fetch', 'origin', 'main', '--quiet']);
    },
    /**
     * The commit this branch diverged from. Everything measured before the
     * commit is measured against THIS, never against `main` directly, so a
     * main that moved while the bead was being built cannot show up as a
     * reversal inside the bead's own diff.
     */
    async base() {
      const r = await git(['merge-base', 'main', 'HEAD']);
      return r.stdout.trim() || 'main';
    },
    /**
     * Stage the agent's work so the pre-commit readers can see it, INCLUDING
     * files it created — those are invisible to `git diff` at any revision
     * until they are in the index.
     *
     * Deliberately not `write`: staging is local and the teardown discards it,
     * and a `--dry-run` has to measure the guard and the Playground trigger
     * too, which is the entire point of a dry run.
     */
    async stageAll() {
      return git(['add', '-A']);
    },
    async resetHard() {
      return restore(['reset', '--hard', '-q']);
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
    /** The commit WATCH must ask about. Polling by PR number reads whatever
     *  GitHub currently associates with the PR, which after a repair
     *  force-push is still the previous commit. */
    /**
     * Which `loop/<bead-id>` branches already exist on the remote.
     *
     * ONE call for the whole set, which is what makes it worth doing at all.
     * A bead whose earlier attempt left its branch on the remote is re-selected
     * as normal — nothing labels it — and the loop then spends a full turn
     * budget on BUILD and the entire gate before `push` fails non-fast-forward
     * at PUBLISH, because attempt 1 pushes without `--force`. Measured instance:
     * `Cebab-p5y`, whose PR #403 sat on `loop/Cebab-p5y` while the bead stayed
     * selectable.
     *
     * Returns bead IDS, not refs, so the caller can intersect with a ready set
     * without knowing the naming convention. `[]` on any failure — this feeds a
     * REPORT, and a network hiccup must not be able to stop a run.
     */
    async remoteLoopBeads() {
      const r = await git(['ls-remote', '--heads', 'origin', `refs/heads/${LOOP_BRANCH_PREFIX}*`]);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\n')
        .map((line) => line.split(`refs/heads/${LOOP_BRANCH_PREFIX}`)[1]?.trim())
        .filter(Boolean);
    },

    async headSha() {
      const r = await git(['rev-parse', 'HEAD']);
      return r.stdout.trim();
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
    /**
     * Everything the guard needs, from the branch's whole change against its
     * base. Stages first: an unstaged edit and a newly created file are both
     * invisible to a revision-to-revision diff, and this runs BEFORE the
     * commit.
     */
    async diffForGuard() {
      await api.stageAll();
      const base = await api.base();
      const numstat = await git(['diff', '--cached', '--numstat', base]);
      const nameStatus = await git(['diff', '--cached', '--name-status', base]);
      const full = await git(['diff', '--cached', base]);
      return {
        files: parseDiffStat(numstat.stdout, nameStatus.stdout),
        ...parseDiffLines(full.stdout),
      };
    },
    /** Paths only — used to decide whether the Playground tier is triggered. */
    async changedPaths() {
      await api.stageAll();
      const base = await api.base();
      const r = await git(['diff', '--cached', '--name-only', base]);
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    },
    /** R4: CI runs this exact check, so failing it here saves a round trip. */
    async lockfileChanged() {
      const base = await api.base();
      const r = await git([
        'diff',
        '--cached',
        '--exit-code',
        '--quiet',
        base,
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
