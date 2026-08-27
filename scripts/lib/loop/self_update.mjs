/**
 * Autonomous loop — the driver is not immune to the pull it performs.
 *
 * THE DEFECT, MEASURED 2026-08-27 FROM A REAL RUN'S OWN ARTIFACTS. Node imports
 * `scripts/loop.mjs` and every `scripts/lib/loop/*.mjs` at process start.
 * Preflight then runs `git fetch` + `git pull --ff-only` to make `main` current
 * — CHANGING those files on disk, after they are already in memory. The reflog
 * and the ledger line up to the second:
 *
 *   main@{14:23:22 +0300}  pull --ff-only -q: Fast-forward -> d72439b
 *   run  startedAt         2026-08-27T11:23:21.206Z   (= 14:23:21 +0300)
 *
 * The process started with `main` three merges behind and one second later its
 * own preflight advanced the checkout. Every module in memory stayed at the old
 * revision for the whole run, so `select.excludeParents` — merged that morning
 * precisely to keep the loop off its own epic — did not exist in the running
 * copy, and two beads under that epic were selected, built, and closed through
 * a path a merged commit had already replaced.
 *
 * WHY IT IS WORSE THAN IT LOOKS. The pull is REQUIRED: preflight refuses to
 * start on a `main` that is not current, so beads are never built on stale
 * code. The loop therefore reliably updates the repo it is about to work in and
 * reliably does not update itself — and the more actively the loop is being
 * improved, the staler the running copy. `Cebab-qd2.35`.
 *
 * THE FIX IS TO RE-EXEC, ONCE. Of the four candidates on the bead, this is the
 * only one that makes the running code match the pulled code:
 *
 *   refuse instead        — cheap and honest, but every first run after a merge
 *                           then fails, which trains people to ignore it.
 *   a launcher process    — clean, but costs a process on EVERY run, including
 *                           the overwhelming majority where nothing was behind.
 *   record the revision   — not a fix. Done as well, see `driverRevision` in
 *                           the ledger: it turns an invisible failure into a
 *                           diagnosable one and composes with this.
 *
 * THE WINDOW IS EXACT. Preflight runs before `acquireLock`, so at the moment
 * this decides, no lock is held, no bead is claimed and nothing is in flight —
 * the child re-runs preflight from scratch and the parent has nothing to undo.
 * A re-exec anywhere later would have to hand over a lock and a claimed bead.
 *
 * PURE. `reexecPlan` takes two revisions and a flag; the spawning lives in the
 * driver, which is the only thing that owns `process`.
 */

/** Set on the child so a second pull cannot start a third process. */
export const REEXEC_ENV = 'CEBAB_LOOP_REEXEC';

/**
 * @param {object} input `{ headBefore, headAfter, alreadyReexeced }`
 * @returns {{action: 'continue'|'reexec'|'refuse', from?: string, to?: string, headUnknown?: boolean}}
 *
 * `continue` when nothing moved — the overwhelming majority of runs, and it
 * must cost nothing.
 *
 * `reexec` when preflight's pull advanced the checkout under a driver that was
 * already in memory.
 *
 * `refuse` when it moved AGAIN in the child. One more re-exec would be a loop
 * with no bound, and a second move inside two consecutive preflights is not a
 * routine "someone merged while I started" — it is a repository doing something
 * this run should not race. Exit 2 and let the operator re-run.
 *
 * AN UNREADABLE HEAD CONTINUES, and is flagged rather than silently treated as
 * unchanged. Refusing on it would make an unrelated `git rev-parse` failure
 * stop the night; re-execing on it would spawn a process on no evidence. The
 * caller logs `headUnknown` so the ledger's revision field being null has a
 * stated cause.
 */
export function reexecPlan({ headBefore, headAfter, alreadyReexeced = false } = {}) {
  if (!headBefore || !headAfter) return { action: 'continue', headUnknown: true };
  if (headBefore === headAfter) return { action: 'continue' };
  if (alreadyReexeced) return { action: 'refuse', from: headBefore, to: headAfter };
  return { action: 'reexec', from: headBefore, to: headAfter };
}

/**
 * The child's argv, from this process's own.
 *
 * `slice(1)` drops the node executable and keeps the SCRIPT PATH plus every
 * user flag — `process.argv[1]` is the driver itself, and dropping it too would
 * re-exec node with no program at all. Pinned by a test because that off-by-one
 * fails as an interactive REPL rather than as an error.
 *
 * Note the child is spawned as `node <script>` even when the parent was started
 * through `npm run loop`: npm's wrapper contributes nothing the driver reads,
 * and going straight to node removes a process from the chain.
 */
export function reexecArgv(argv) {
  return argv.slice(1);
}

/** The child's env: the parent's, plus the guard that stops a third process. */
export function reexecEnv(env) {
  return { ...env, [REEXEC_ENV]: '1' };
}
