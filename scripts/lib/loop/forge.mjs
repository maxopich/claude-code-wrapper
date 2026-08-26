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

export function prChecksArgv(pr) {
  return ['pr', 'checks', String(pr), '--json', 'name,state,bucket,link'];
}

export function prMergeArgv(pr, { auto = false } = {}) {
  const args = ['pr', 'merge', String(pr), '--squash', '--delete-branch'];
  if (auto) args.push('--auto');
  return args;
}

const SETTLED = new Set(['pass', 'skipping', 'fail', 'cancel']);

/** Classify one poll. Pure, so every branch is testable without a network. */
export function classifyChecks(checks, requiredContext) {
  const all = checks ?? [];
  // Is anything still moving? This is what separates "the required job is
  // queued behind its `needs:`" from "no CI is running at all".
  const anyPending = all.some((c) => !SETTLED.has(c.bucket ?? ''));
  const match = all.find((c) => c.name === requiredContext);
  if (!match) return { outcome: 'pending', found: false, anyPending, total: all.length };
  const bucket = match.bucket ?? '';
  const base = { found: true, link: match.link, anyPending, total: all.length };
  if (bucket === 'pass' || bucket === 'skipping') return { outcome: 'green', ...base };
  if (bucket === 'fail' || bucket === 'cancel') return { outcome: 'red', ...base };
  return { outcome: 'pending', ...base };
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

    async pollChecks(pr, requiredContext) {
      const r = await gh(prChecksArgv(pr));
      // gh exits 8 while checks are pending and non-zero when any fails, so
      // the exit code is not the signal — the JSON is.
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        // Unknown, not empty: `anyPending` true keeps the driver waiting rather
        // than reporting a CI that may be perfectly healthy as never started.
        return { outcome: 'pending', found: false, unparsed: true, anyPending: true };
      }
      return classifyChecks(parsed, requiredContext);
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

    /** Last lines of the failing job's log, for the repair prompt. */
    async failingLog(pr, requiredContext, lines = 80) {
      const r = await gh(['pr', 'checks', String(pr), '--json', 'name,bucket,link']);
      let checks;
      try {
        checks = JSON.parse(r.stdout);
      } catch {
        return '';
      }
      const failed = checks.find((c) => c.bucket === 'fail' && c.name !== requiredContext);
      const runId = failed?.link?.split('/runs/')?.[1]?.split('/')?.[0];
      if (!runId) return '';
      const log = await gh(['run', 'view', runId, '--log-failed'], { timeoutMs: 180000 });
      return log.stdout.split('\n').slice(-lines).join('\n');
    },
  };
}
