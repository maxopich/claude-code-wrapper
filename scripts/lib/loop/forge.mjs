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

/**
 * `--match-head-commit` IS RULE 2 APPLIED TO THE MERGE. WATCH validated one
 * commit; without this flag LAND asks GitHub to merge "the PR", which is
 * whatever its head happens to be by then. The flag makes the forge refuse
 * anything else, so the loop can only ever land the commit it actually saw go
 * green — the same reason `pollChecks` is SHA-scoped rather than PR-scoped.
 */
export function prMergeArgv(pr, { auto = false, headSha = null } = {}) {
  const args = ['pr', 'merge', String(pr), '--squash', '--delete-branch'];
  if (headSha) args.push('--match-head-commit', headSha);
  if (auto) args.push('--auto');
  return args;
}

/** What actually happened, read back from the forge. See `merge` below. */
export function prStateArgv(pr) {
  return ['pr', 'view', String(pr), '--json', 'state,mergeCommit,mergedAt'];
}

/**
 * Pure half of the read-back, so both branches are testable without a network.
 * `mergeCommit` is null until the merge exists, which is exactly the difference
 * between a merge and a queued one.
 */
export function parsePrState(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: null, sha: null, mergedAt: null, unparsed: true };
  }
  return {
    state: typeof parsed?.state === 'string' ? parsed.state : null,
    sha: typeof parsed?.mergeCommit?.oid === 'string' ? parsed.mergeCommit.oid : null,
    mergedAt: parsed?.mergedAt ?? null,
  };
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

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeForge({ run, cwd, dryRun = false, sleep = defaultSleep }) {
  const gh = (args, opts = {}) => run('gh', args, { cwd, timeoutMs: 120000, ...opts });

  const api = {
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

    /**
     * MERGED IS A STATE READ BACK, NOT AN EXIT CODE.
     *
     * The previous version returned `{ merged: true, queued: true }` when the
     * direct merge failed and `--auto` succeeded. But `gh pr merge --auto` does
     * not merge — its own help says it "automatically merge[s] only after
     * necessary requirements are met", i.e. it ENABLES auto-merge and returns.
     * The comment beside it read "queueing counts as success, since the
     * required checks are already green", which is true at the instant of
     * queueing and stops being true immediately afterwards. That is a
     * PREDICTION recorded as an OUTCOME, and everything downstream believed it:
     * the bead was closed, the breaker reset, `git pull --ff-only` fetched a
     * `main` that did not contain the change, and the next bead branched from
     * it.
     *
     * So both paths now finish by asking the forge what the PR's state IS.
     * `merged` requires `state === 'MERGED'` and carries the real
     * `mergeCommit.oid` — the field that was hardcoded `null` on every ledger
     * row ever written, which is why no record could be checked against `main`.
     *
     * THE READ-BACK RETRIES, and the asymmetry is deliberate: a direct merge
     * that exited 0 has already happened, so a state that is not yet `MERGED`
     * is replication lag, and reporting it as a failure would park a bead whose
     * change is on `main`. A queued merge has NOT happened, so it is read once.
     */
    async merge(pr, { headSha = null } = {}) {
      const outcome = (extra) => ({ merged: false, queued: false, sha: null, ...extra });
      if (dryRun) return outcome({ state: null });

      const direct = await gh(prMergeArgv(pr, { headSha }));
      if (direct.code === 0) {
        const state = await api.confirmMerged(pr);
        if (state.state === 'MERGED') {
          return { merged: true, queued: false, sha: state.sha, state: state.state };
        }
        return outcome({
          state: state.state,
          error: `gh pr merge exited 0 but the PR reads ${state.state ?? 'unknown'}`,
        });
      }

      const auto = await gh(prMergeArgv(pr, { auto: true, headSha }));
      if (auto.code !== 0) {
        return outcome({ state: null, error: (auto.stderr || direct.stderr).trim() });
      }
      // `--auto` can still land immediately when the requirements were already
      // met, so the state decides which of the two this was.
      const state = await api.prState(pr);
      if (state.state === 'MERGED') {
        return { merged: true, queued: false, sha: state.sha, state: state.state };
      }
      return { merged: false, queued: true, sha: null, state: state.state };
    },

    async prState(pr) {
      const r = await gh(prStateArgv(pr));
      if (r.code !== 0) return { state: null, sha: null, mergedAt: null, failed: true };
      return parsePrState(r.stdout);
    },

    /** Up to `attempts` reads for a merge that has already been accepted. */
    async confirmMerged(pr, { attempts = 3, delayMs = 2000 } = {}) {
      let state = await api.prState(pr);
      for (let i = 1; i < attempts && state.state !== 'MERGED'; i += 1) {
        await sleep(delayMs);
        state = await api.prState(pr);
      }
      return state;
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
  return api;
}
