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

import { LOOP_BRANCH_PREFIX } from './git.mjs';

export function prCreateArgv({ base, title }) {
  return ['pr', 'create', '--base', base, '--title', title, '--body-file', '-'];
}

/**
 * Every open PR and the files it touches — the input to the overlap report.
 *
 * `files` is a real `gh pr list --json` field, so this costs ONE call rather
 * than one per PR. 100 is far past the handful of branches an overnight run
 * leaves open; a repo that exceeded it would need pagination here, and the
 * report would under-state rather than mislead.
 */
export function prListArgv({ limit = 100 } = {}) {
  return [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,url,headRefName,files',
  ];
}

/**
 * Which OTHER open loop PRs touch a file this branch also touches.
 *
 * WHY THIS IS A REPORT AND NOT A FILTER. `loop.merge` defaults to false, so
 * `guard_withheld` is how an ordinary SUCCESSFUL iteration ends: the PR is
 * opened and the merge left to a human. Every later iteration then branches
 * from an `origin/main` that does not contain it, so after an `--until 8`
 * night iteration 8 is building on a main missing up to seven landed-in-spirit
 * changes. Two beads touching one file conflict, and neither the loop nor
 * either agent can see it coming — measured on the run of 2026-08-27, where
 * two PRs both created `assistant/kb/00-index.md`. `Cebab-qd2.44`.
 *
 * The SELECT-side version of this cannot work: it would need to know which
 * files a bead will touch BEFORE building it, and `select.mjs`'s own header
 * carries the measurement that kills it — beads name their files by basename
 * as often as by path. Post-hoc and certain beats pre-hoc and unreliable, and
 * it reaches the human at the moment they can still choose the merge order.
 *
 * EXCLUDED BY BRANCH AS WELL AS BY NUMBER. `excludeNumber` covers a repair,
 * where this branch's PR is already open and would otherwise report a 100%
 * overlap with itself; `excludeBranch` covers the case that has actually
 * happened — a PREVIOUS run left a PR open for this same bead (`branch-exists`),
 * so the self-match exists before `prNumber` is known.
 */
export function overlappingPrs(
  prs = [],
  changedPaths = [],
  { excludeNumber = null, excludeBranch = null, prefix = LOOP_BRANCH_PREFIX } = {},
) {
  // NO `if (mine.size === 0) return []` FAST PATH. It was here, and a
  // revert-check proved it unfalsifiable: with an empty set every candidate
  // file fails `mine.has`, so the loop returns `[]` on its own and no mutation
  // of the guard can change an answer. A line that looks like it handles a case
  // but cannot is worse than its absence — it is what makes a reader believe
  // the case is covered. The BEHAVIOUR is still pinned by a test.
  const mine = new Set(changedPaths);
  const out = [];
  for (const pr of prs ?? []) {
    if (!pr || typeof pr !== 'object') continue;
    const branch = String(pr.headRefName ?? '');
    if (!branch.startsWith(prefix)) continue;
    if (excludeBranch && branch === excludeBranch) continue;
    if (excludeNumber != null && pr.number === excludeNumber) continue;
    const files = (pr.files ?? [])
      .map((f) => (typeof f === 'string' ? f : f?.path))
      .filter((f) => f && mine.has(f));
    if (files.length === 0) continue;
    out.push({
      number: pr.number ?? null,
      url: pr.url ?? null,
      branch,
      files: [...new Set(files)].sort(),
    });
  }
  return out.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
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
 * Conclusions that mean the RUNNER STOPPED THE JOB, rather than the job having
 * decided anything about the code.
 *
 * Measured 2026-08-30, CI run 33312182698: the windows-2022 leg exceeded
 * `timeout-minutes: 15` and was killed at 902s with every emitted vitest line a
 * tick or a skip; the ubuntu leg passed the same SHA in 7m2s and a plain re-run
 * of the identical commit went green. Folded into `red`, that cost a correct
 * five-file rename a 12-turn repair attempt against a cause that did not exist,
 * and then parked it `build_failed`.
 *
 * `stale` is here because GitHub reports it for a check whose run was
 * superseded — also not a verdict on the diff. This set is deliberately SMALL
 * and closed: an unknown conclusion must keep falling through to `red`, for the
 * same reason `GREEN_CONCLUSIONS` is an allow-list. Widening it is how a real
 * failure becomes a retry.
 */
const INFRA_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'stale']);

/** `.../actions/runs/<runId>/job/<jobId>` -> `<runId>`, or null. */
export function runIdFromCheckUrl(url) {
  const id = String(url ?? '')
    .split('/runs/')[1]
    ?.split('/')[0];
  return /^\d+$/.test(id ?? '') ? id : null;
}

/** One re-run of only the failed jobs of a workflow run. */
export function rerunFailedArgv(runId) {
  return ['run', 'rerun', String(runId), '--failed'];
}

/**
 * A COMPLETED, non-green check run that is not the aggregator itself.
 *
 * ONE definition, used by both `classifyCheckRuns` (which needs the whole list,
 * because a red sibling changes what a verdict means) and `failingSibling`
 * (which needs one, for a repair log). They were written out separately and the
 * revert-check caught it: an anchor that matched twice. Two copies of a
 * predicate that decides whether CI counts as failed is the shape this repo
 * keeps being bitten by — `status: 'completed'` is easy to drop from one of
 * them, and dropping it makes an in-flight check read as a failure.
 */
const isFailedSibling = (r, requiredContext) =>
  r.status === 'completed' && !GREEN_CONCLUSIONS.has(r.conclusion) && r.name !== requiredContext;

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
  // EVERY completed, non-green run that is not the aggregator itself. This used
  // to be computed only on demand by `failingSibling`, for a repair log; it is
  // part of the verdict now because a red sibling changes what the verdict
  // MEANS in two different directions, below.
  const failedSiblings = runs
    .filter((r) => isFailedSibling(r, requiredContext))
    .map((r) => ({ name: r.name, conclusion: r.conclusion ?? null, link: r.html_url ?? null }));
  const match = runs.find((r) => r.name === requiredContext);
  if (!match) {
    return { outcome: 'pending', found: false, anyPending, total: runs.length, failedSiblings };
  }
  const base = {
    found: true,
    link: match.html_url,
    anyPending,
    total: runs.length,
    failedSiblings,
  };
  if (match.status !== 'completed') return { outcome: 'pending', ...base };
  if (GREEN_CONCLUSIONS.has(match.conclusion)) {
    // A GREEN REQUIRED CONTEXT IS NOT A GREEN PULL REQUEST, and this loop used
    // to assume it was. Measured 2026-08-30 on PR #432: the required context
    // passed, `Fixture review gate` — a separate REQUIRED check, red by design
    // until a CODEOWNER clears a label — did not. The loop reported green,
    // tried to merge, was refused by branch protection, fell back to
    // `--auto` and recorded `merge_queued`, which reads as "will land shortly"
    // for a PR that could never land without a human.
    //
    // `blocked` rather than `red` because the remedies share no step: a repair
    // attempt cannot remove a review label, and nothing about the diff is
    // wrong. Note this fires only on a COMPLETED non-green sibling, so a
    // still-running one leaves the outcome alone.
    return { outcome: failedSiblings.length > 0 ? 'blocked' : 'green', ...base };
  }
  // The required context is red. Did something FAIL, or was something KILLED?
  // The aggregator's own conclusion is `failure` either way — it exits 1 on
  // `needs.<job>.result != success` — so the answer is in the siblings.
  //
  // `.length > 0` guards the `.every`: on an empty array `every` is true, which
  // would make a red context with no sibling detail read as infrastructure and
  // silently convert every unexplained failure into a retry.
  const killed =
    INFRA_CONCLUSIONS.has(match.conclusion) ||
    (failedSiblings.length > 0 && failedSiblings.every((s) => INFRA_CONCLUSIONS.has(s.conclusion)));
  return { outcome: killed ? 'infra' : 'red', ...base };
}

/** The failing sibling job, whose log is worth handing to a repair. The
 *  required context itself is an aggregator — its log says only that a matrix
 *  leg failed, never which line. */
export function failingSibling(payload, requiredContext) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  return runs.find((r) => isFailedSibling(r, requiredContext)) ?? null;
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

    /**
     * `{ prs, error }` RATHER THAN AN ARRAY, because the two answers this can
     * give are "no other PR touches your files" and "I could not find out", and
     * a bare `[]` renders them identical — which is the exact shape of a report
     * that runs, succeeds and measures nothing. Not `dryRun`-gated: this is a
     * read, like `pollChecks` and `prState`, and gating it would leave the
     * rehearsal unable to exercise the path.
     */
    async openLoopPrs() {
      const r = await gh(prListArgv());
      if (r.code !== 0) {
        const said = (r.stderr || r.stdout).trim().split('\n')[0];
        return { prs: [], error: said || `gh pr list exited ${r.code}` };
      }
      try {
        const parsed = JSON.parse(r.stdout);
        if (!Array.isArray(parsed)) return { prs: [], error: 'gh pr list returned a non-array' };
        return { prs: parsed, error: null };
      } catch {
        return { prs: [], error: 'gh pr list returned unparseable JSON' };
      }
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

    /**
     * Re-run only the failed jobs of the workflow run that produced this SHA's
     * checks. The ONLY response that can help an infrastructure cancellation,
     * and before this the loop had none — so its only available reaction to a
     * runner timeout was a code repair, which cannot help by construction.
     *
     * NOT GUARDED HERE. The caller owns "at most once per iteration", because
     * the budget being protected is the iteration's, not the forge's, and a
     * limit enforced inside a stateless helper would have to invent state to
     * hold it. `watchCi` is the single call site and it carries the flag.
     */
    async rerunFailedChecks(sha, requiredContext) {
      if (dryRun) return { ok: false, error: 'dry run' };
      const r = await gh(checkRunsArgv(sha));
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return { ok: false, error: 'check-runs payload was not JSON' };
      }
      // The run id can come from ANY check run of that workflow — they share
      // one — so fall back to the aggregator when no sibling carries a url.
      const verdict = classifyCheckRuns(parsed, requiredContext);
      const runId =
        verdict.failedSiblings.map((f) => runIdFromCheckUrl(f.link)).find(Boolean) ??
        runIdFromCheckUrl(verdict.link);
      if (!runId) return { ok: false, error: 'no workflow run id in the check payload' };
      const out = await gh(rerunFailedArgv(runId), { timeoutMs: 120000 });
      if (out.code !== 0) {
        const said = (out.stderr || out.stdout).trim().split('\n')[0];
        return { ok: false, error: said || `gh run rerun exited ${out.code}` };
      }
      return { ok: true, error: null, runId };
    },
  };
  return api;
}
