/**
 * Autonomous loop — GitHub, via `gh`.
 *
 * WATCH READS `bucket`, NOT `state`. `gh pr checks --json` exposes a `bucket`
 * field that collapses the raw state into `pass | fail | pending | skipping |
 * cancel` — already the split §6.6 branches on, and stable across the check
 * states GitHub adds over time. Reading raw `state` means re-deriving that
 * mapping here and getting it wrong the first time GitHub returns something
 * unexpected.
 *
 * THE THREE OUTCOMES ARE NOT TWO. `absent` is distinct from `red`, and is not
 * repaired: it means the repo or the runner is wrong, not this bead's diff, so
 * a rebuild cannot fix it and it counts toward the circuit breaker.
 *
 * WHICH IS WHY `absent` CANNOT MEAN "HAS NOT APPEARED YET". Cebab's required
 * check is a job with `needs: [quality]`, and GitHub creates no check run for
 * a job until its dependencies finish — so the required context is genuinely
 * missing from `gh pr checks` for as long as the matrix takes. Measured on
 * PR #402's head SHA: the workflow started at 08:12:13Z and
 * `Lint, Typecheck, Test` first appeared at 08:23:36Z, 11m23s later, against
 * an `appearTimeoutMs` of five minutes. Every real run would have parked
 * `ci_never_started`, and three of those halt the loop on the breaker.
 *
 * So `anyPending` is reported alongside the match, and the driver only calls a
 * run absent when nothing at all is still moving. A pending sibling check is
 * positive evidence that CI is alive and the required job is merely queued
 * behind it; zero checks, or all of them settled without the required name
 * ever showing up, is the real "never started".
 */

export function prCreateArgv({ base, title }) {
  return ['pr', 'create', '--base', base, '--title', title, '--body-file', '-'];
}

/**
 * Checks for ONE COMMIT, never for "the PR".
 *
 * `gh pr checks <n>` is PR-scoped and lags a force-push: for a window after a
 * repair it still serves the PREVIOUS commit's results. Measured on the first
 * repair the loop ever ran — the ledger recorded
 *
 *     ci: { conclusion: "failure", waitedMs: 1185, runUrl: ".../job/98126852808" }
 *
 * 1.2 seconds after the push, naming the OLD run's job, while the rerun for the
 * new SHA was still `in_progress` and the required check did not exist for it
 * yet. So every repair burned an attempt instantly on a stale verdict, and with
 * `maxRepairs: 2` a single red consumed both repairs in seconds and parked a
 * bead whose fix had in fact landed.
 *
 * `{owner}/{repo}` are resolved by `gh` from the checkout, so no slug is
 * threaded through. 100 is well past this repo's dozen checks; a repo that
 * exceeded it would need pagination here.
 */
export function checkRunsArgv(sha) {
  return ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`];
}

export function prMergeArgv(pr, { auto = false } = {}) {
  const args = ['pr', 'merge', String(pr), '--squash', '--delete-branch'];
  if (auto) args.push('--auto');
  return args;
}

/**
 * A completed check that did not succeed is RED, including a conclusion this
 * code has never seen. The alternative — an allow-list of failure words —
 * makes the first conclusion GitHub adds read as a pass, which is the one
 * direction that must never happen silently.
 *
 * `skipped` is green because a skipped required check is how a path-filtered
 * job reports "nothing to do here", exactly as `bucket: skipping` did.
 */
const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Classify one poll of the SHA-scoped payload. Pure, so every branch is
 * testable without a network.
 *
 * This re-derives what `gh pr checks`'s `bucket` used to collapse for us, and
 * the header there warned against exactly that. It is done anyway because the
 * commit-scoped endpoint does not expose `bucket`, and reading another
 * commit's verdict is strictly worse than owning a two-line mapping that has
 * cases in both directions.
 */
export function classifyCheckRuns(payload, requiredContext) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  // Is anything still moving? This is what separates "the required job is
  // queued behind its `needs:`" from "no CI is running at all".
  const anyPending = runs.some((r) => r.status !== 'completed');
  const match = runs.find((r) => r.name === requiredContext);
  if (!match) return { outcome: 'pending', found: false, anyPending, total: runs.length };
  const base = { found: true, link: match.html_url, anyPending, total: runs.length };
  if (match.status !== 'completed') return { outcome: 'pending', ...base };
  if (GREEN_CONCLUSIONS.has(match.conclusion)) return { outcome: 'green', ...base };
  return { outcome: 'red', ...base };
}

/** The failing sibling job, whose log is worth handing to a repair. The
 *  required context itself is an aggregator — its log says only that a matrix
 *  leg failed, never which line. */
export function failingSibling(payload, requiredContext) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  return (
    runs.find(
      (r) =>
        r.status === 'completed' &&
        !GREEN_CONCLUSIONS.has(r.conclusion) &&
        r.name !== requiredContext,
    ) ?? null
  );
}

export function makeForge({ run, cwd, dryRun = false }) {
  const gh = (args, opts = {}) => run('gh', args, { cwd, timeoutMs: 120000, ...opts });

  return {
    async createPr({ base, title, body }) {
      if (dryRun) return { number: null, url: null };
      const r = await gh(prCreateArgv({ base, title, body }), { input: body });
      if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
      const url = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      const number = Number(url.split('/').pop());
      return { number: Number.isFinite(number) ? number : null, url };
    },

    async pollChecks(sha, requiredContext) {
      const r = await gh(checkRunsArgv(sha));
      // The exit code is not the signal — the JSON is.
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        // Unknown, not empty: `anyPending` true keeps the driver waiting rather
        // than reporting a CI that may be perfectly healthy as never started.
        return { outcome: 'pending', found: false, unparsed: true, anyPending: true };
      }
      return classifyCheckRuns(parsed, requiredContext);
    },

    async merge(pr) {
      if (dryRun) return { merged: false, sha: null };
      let r = await gh(prMergeArgv(pr));
      if (r.code !== 0) {
        // Branch protection can refuse an immediate merge; queueing counts as
        // success, since the required checks are already green.
        r = await gh(prMergeArgv(pr, { auto: true }));
        if (r.code !== 0) return { merged: false, sha: null, error: r.stderr.trim() };
        return { merged: true, sha: null, queued: true };
      }
      return { merged: true, sha: null };
    },

    async addLabel(pr, label) {
      if (dryRun) return true;
      const r = await gh(['pr', 'edit', String(pr), '--add-label', label]);
      return r.code === 0;
    },

    /**
     * Last lines of the failing job's log, for the repair prompt. SHA-scoped
     * for the same reason as `pollChecks`, and the consequence of getting it
     * wrong is sharper here: handing a repair the PREVIOUS commit's log asks
     * the agent to fix something it has already fixed. Measured — attempt 3
     * read the stale log, found its own fix already in place, and returned
     * `no_change_needed` with `needs_human`.
     */
    async failingLog(sha, requiredContext, lines = 80) {
      const r = await gh(checkRunsArgv(sha));
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return '';
      }
      const failed = failingSibling(parsed, requiredContext);
      const runId = failed?.html_url?.split('/runs/')?.[1]?.split('/')?.[0];
      if (!runId) return '';
      const log = await gh(['run', 'view', runId, '--log-failed'], { timeoutMs: 180000 });
      return log.stdout.split('\n').slice(-lines).join('\n');
    },
  };
}
