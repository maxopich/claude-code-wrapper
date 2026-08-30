/**
 * Autonomous loop — the run ledger (`.loop/runs.jsonl`, append-only).
 *
 * `buildRecord` and `validateRecord` are PURE; `appendRecord` takes an injected
 * writer so the tests never touch a filesystem.
 *
 * BUILD A RECORD FROM NOTHING. Every field defaults, because the driver wraps
 * each iteration so that a THROWN stage still appends its record — and a record
 * builder that needed a complete iteration would throw inside the `finally`
 * that exists to salvage the incomplete one. The crash case is the one the
 * maintainer most needs a row for.
 */

/** §9.1. */
export const DISPOSITIONS = Object.freeze([
  'merged',
  'merge_queued',
  'parked',
  'guard_withheld',
  'no_change_needed',
  'halted',
  'dry_run',
]);

/**
 * Which named check a command line is talking about. Used only to compute
 * `verdictVsGate`; both sides are normalised through this same table so the
 * comparison cannot drift between them.
 */
const CHECK_TOKENS = Object.freeze([
  'lint',
  'typecheck',
  'format',
  'test:security',
  'test',
  'smoke',
  'build',
]);

function tokensIn(text) {
  const found = new Set();
  const lower = String(text).toLowerCase();
  for (const token of CHECK_TOKENS) {
    if (lower.includes(token)) found.add(token);
  }
  // `npm run test:security` contains both `test:security` and `test`; keep the
  // most specific so a security-gate claim is not credited to `npm test`.
  if (found.has('test:security')) found.delete('test');
  return found;
}

/**
 * Did the checks the agent CLAIMED to have run come back green from the gate?
 *
 * `agree` — every check it named passed when re-run.
 * `disagree` — it named a check that the gate then found red.
 * `unknown` — it named nothing comparable, so there is no claim to test.
 *
 * NEVER BRANCH ON THIS. It is a signal for the maintainer, recorded and moved
 * past; the gate's own exit codes are what control flow reads. `unknown` is
 * not in the spec's two-value list on purpose: calling "the agent claimed
 * nothing" an agreement would manufacture reassurance out of silence.
 */
export function compareVerdictToGate(commandsRun = [], gateSteps = []) {
  const claimed = new Set();
  for (const command of commandsRun) {
    for (const token of tokensIn(command)) claimed.add(token);
  }
  if (claimed.size === 0) return 'unknown';

  for (const step of gateSteps) {
    if (step.exitCode === 0 || step.exitCode === undefined) continue;
    for (const token of tokensIn(step.name)) {
      if (claimed.has(token)) return 'disagree';
    }
  }
  return 'agree';
}

/**
 * One verdict-vs-gate answer for an iteration that ran the gate SEVERAL times.
 *
 * `compareVerdictToGate` answers for one pairing: a build's claimed commands
 * against the gate that followed it. An iteration can gate more than once — a
 * gate failure buys a repair, so does a CI red — and the driver assigned each
 * answer over the last, which made `disagree` structurally unreachable for any
 * failure that was subsequently repaired. By the time the row was written the
 * gate was green, so "the agent claimed lint passed and the gate found it red"
 * could not be recorded at all. That is the field's entire purpose, and the
 * second governing rule it serves. `Cebab-qd2.43`.
 *
 * DISAGREEMENT IS STICKY. An agent that misreported has misreported; a later
 * attempt getting it right does not unmake the first, and a row that forgets
 * is exactly the reassurance the rule exists to refuse. `unknown` loses to
 * both because it is the ABSENCE of a claim rather than a claim that held.
 */
const VERDICT_RANK = Object.freeze({ unknown: 0, agree: 1, disagree: 2 });

export function mergeVerdictVsGate(previous, next) {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
  // `'constructor' in VERDICT_RANK` is TRUE and its "rank" is a function that
  // no comparison can beat — one stray value would freeze the field for the
  // rest of the iteration. Not reachable from `compareVerdictToGate`'s closed
  // three-value set, and cheaper to make impossible than to reason about.
  const known = (v) => (Object.hasOwn(VERDICT_RANK, v) ? v : 'unknown');
  const a = known(previous);
  const b = known(next);
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

/**
 * @param {object} parts  whatever the iteration managed to produce
 * @param {number} now    epoch ms, injected
 */
export function buildRecord(parts = {}, now = 0) {
  const build = parts.build ?? {};
  const gate = parts.gate ?? {};
  const guard = parts.guard ?? {};
  const diffstat = parts.diffstat ?? {};
  const pr = parts.pr ?? {};
  const ci = parts.ci ?? {};
  const land = parts.land ?? {};
  const harvest = parts.harvest ?? {};

  const steps = gate.steps ?? [];
  return {
    ts: new Date(now).toISOString(),
    bead: parts.bead ?? null,
    beadTitle: parts.beadTitle ?? null,
    branch: parts.branch ?? null,
    build: {
      sessionId: build.sessionId ?? null,
      numTurns: build.numTurns ?? null,
      // RECORDED, NEVER PRINTED. The loop runs on a Claude subscription, so this
      // prices a transaction that never happens and says nothing about the usage
      // window a run consumed — but it is the CLI's own number and the only free
      // cross-model normaliser, and every row ever written carries it. `tokens`
      // beside it is what the human-facing output reports. See `usage.mjs`.
      costUsd: build.costUsd ?? null,
      // NULL, NOT ZEROS, when the envelope could not say — an unknown and a free
      // turn are different facts, and `land.sha: null` on every row is what
      // taught this loop the difference.
      tokens: build.tokens ?? null,
      durationMs: build.durationMs ?? null,
      exitCode: build.exitCode ?? null,
      outcome: build.outcome ?? null,
      risk: build.risk ?? null,
      // The agent's own account of what it did or refused to do. For a DECLINE
      // this is the only content the iteration produced (Cebab-qd2.36): the
      // build succeeded, so `detail` is empty, and no gate, CI or PR ever ran.
      summary: build.summary ?? null,
      attempts: build.attempts ?? 0,
      // EVERY invocation of this iteration, where the fields above are the LAST
      // one's. Added alongside rather than folded in: accumulating in place
      // would silently re-point the meaning of `numTurns`/`costUsd`/`tokens` on
      // every row already written, in an append-only corpus. Measured gap on
      // the run of 2026-08-27 — the rows accounted for 23% of its turns and 19%
      // of its cache reads. `Cebab-qd2.39`.
      totals: build.totals ?? null,
      // How many times a turn cap was RESUMED. Apart from `attempts` because a
      // resume no longer costs one (Cebab-qd2.37), so `attempts` alone can no
      // longer say how many `claude` invocations a bead cost.
      capResumes: build.capResumes ?? 0,
      // Present only on a failed BUILD; `jq 'select(.build.failure)'` is the
      // morning triage query.
      ...(build.failure ? { failure: build.failure } : {}),
      ...(build.detail ? { detail: build.detail } : {}),
    },
    // WHICH DRIVER PRODUCED THIS ROW. Node imports the driver at process start
    // and preflight then pulls `main` under it, so a run can execute a revision
    // older than the checkout it is working in — and nothing recorded it, which
    // made "the fix did not fire" indistinguishable from "the fix does not work"
    // after the fact. `restarted` is true on a row written by the child of a
    // self-restart. `Cebab-qd2.35`.
    driver: {
      revision: parts.driverRevision ?? null,
      restarted: parts.driverRestarted ?? false,
    },
    gate: {
      steps,
      // EVERY gate run this iteration made, present only when it made more than
      // one — `steps` above stays the LAST run's, which is what every row
      // already written means. Absent-is-good, so `jq 'select(.gate.attempts)'`
      // reads as "iterations whose gate ran twice", i.e. every failure that was
      // repaired. Across the 32 rows written before this existed, rows carrying
      // a non-zero gate step numbered ZERO while the console of one night held
      // six `gate: FAILED at format:check` lines — the durable record said the
      // gate had never once reddened. Added ALONGSIDE rather than folded in for
      // the same reason `build.totals` was: re-pointing `steps` would silently
      // change the meaning of an append-only corpus. `Cebab-qd2.43`.
      ...(gate.attempts?.length > 1 ? { attempts: gate.attempts } : {}),
      playgroundRan: gate.playgroundRan ?? false,
      liveSmokesRan: gate.liveSmokesRan ?? false,
      // Present only when the gate's one mechanical autofix fired. Absent is
      // the good state, so this is `jq 'select(.gate.formatAutofixed)'` for
      // "how often is the BUILD prompt's formatting instruction being ignored"
      // — the measurement that says whether that instruction is working, which
      // the failure itself no longer records now that it is repaired in place.
      ...(gate.formatAutofixed ? { formatAutofixed: true } : {}),
    },
    verdictVsGate: parts.verdictVsGate ?? compareVerdictToGate(parts.commandsRun ?? [], steps),
    diffstat: {
      files: diffstat.files ?? 0,
      insertions: diffstat.insertions ?? 0,
      deletions: diffstat.deletions ?? 0,
    },
    guard: { passed: guard.passed ?? null, breaches: guard.breaches ?? [] },
    pr: { number: pr.number ?? null, url: pr.url ?? null },
    // OTHER open loop PRs this one shares a file with, present only when there
    // are any. `loop.merge` defaults to false, so every successful iteration
    // leaves its PR open and the next one branches from a main without it —
    // which makes a same-file collision the ordinary case rather than an edge
    // one, and nothing could see it coming. `jq 'select(.fileOverlaps)'` is
    // "which PRs of last night's run will fight each other". `Cebab-qd2.44`.
    ...(parts.fileOverlaps?.length ? { fileOverlaps: parts.fileOverlaps } : {}),
    ci: {
      conclusion: ci.conclusion ?? null,
      waitedMs: ci.waitedMs ?? null,
      runUrl: ci.runUrl ?? null,
      // ADDED ALONGSIDE `conclusion`, never folded into it — 32 rows already
      // carry success/failure and re-pointing that would change what every one
      // of them means. Present only when CI said something other than yes or
      // no, so `jq 'select(.ci.outcome)'` is the query for "the loop's own
      // signal was green and the PR still could not merge", and for "CI was
      // killed rather than failed". `Cebab-qd2.45`, `Cebab-qd2.46`.
      ...(ci.outcome ? { outcome: ci.outcome } : {}),
      // Which check, by name. The whole cost of the qd2.45 defect was that the
      // operator could not see WHAT was blocking without opening the PR.
      ...(ci.failedChecks?.length ? { failedChecks: ci.failedChecks } : {}),
      ...(ci.rerun ? { rerun: true } : {}),
    },
    // `queued` and `state` are what stop a PREDICTION reading as an OUTCOME:
    // `gh pr merge --auto` returns success without merging, and this row used
    // to record that as `merged: true`. `sha` was hardcoded `null` on every row
    // ever written, so no record could be checked against `main` at all.
    land: {
      merged: land.merged ?? false,
      queued: land.queued ?? false,
      sha: land.sha ?? null,
      state: land.state ?? null,
    },
    harvest: {
      beadClosed: harvest.beadClosed ?? false,
      // Present only when the bead write FAILED. `bd update --add-label
      // loop-stuck` is the loop's only cross-run memory, so a park that did not
      // land means this bead is selected again tomorrow — the one thing the
      // morning triage has to see. `jq 'select(.harvest.parkFailed)'`.
      ...(harvest.parkFailed ? { parkFailed: true } : {}),
      ...(harvest.noted !== undefined ? { noted: harvest.noted } : {}),
      followUps: harvest.followUps ?? [],
      // Findings the agent recognised as already tracked, as `{ id, title }` —
      // the TITLE too, so the row keeps the claim rather than only the pointer.
      // Present only when the verb was used AND the id resolved, so
      // `jq 'select(.harvest.alreadyTracked)'` measures whether it is being
      // used at all — the number that says whether the duplicate-filing fix is
      // working. `Cebab-7t6`.
      ...(harvest.alreadyTracked?.length ? { alreadyTracked: harvest.alreadyTracked } : {}),
    },
    // Present only once an iteration got as far as its teardown. `pulled:false`
    // after a merged row is the stale-main halt's evidence.
    ...(parts.restore ? { restore: parts.restore } : {}),
    disposition: parts.disposition ?? null,
    ...(parts.haltReason ? { haltReason: parts.haltReason } : {}),
    ...(parts.reason ? { reason: parts.reason } : {}),
    // Present only when an iteration threw. `jq 'select(.crash)'` is the other
    // half of the morning triage query, beside `.build.failure`.
    ...(parts.crash ? { crash: parts.crash } : {}),
  };
}

/** Shape check against §9.1. Returns every problem, like the guard does. */
export function validateRecord(record) {
  const errors = [];
  const need = (path, ok) => {
    if (!ok) errors.push(path);
  };
  if (!record || typeof record !== 'object') return { valid: false, errors: ['record'] };

  need('ts', typeof record.ts === 'string' && record.ts.length > 0);
  need('build', record.build && typeof record.build === 'object');
  need('gate.steps', Array.isArray(record.gate?.steps));
  need('gate.attempts', record.gate?.attempts === undefined || Array.isArray(record.gate.attempts));
  need('guard.breaches', Array.isArray(record.guard?.breaches));
  need('diffstat', record.diffstat && typeof record.diffstat === 'object');
  need('harvest.followUps', Array.isArray(record.harvest?.followUps));
  // A row may not claim both. Cheap, and it is the exact confusion `merge_queued`
  // exists to prevent.
  need('land', !(record.land?.merged === true && record.land?.queued === true));
  need('disposition', record.disposition === null || DISPOSITIONS.includes(record.disposition));
  return { valid: errors.length === 0, errors };
}

/**
 * Append one record. `appendLine` is injected — in the driver it is an
 * `fs.appendFileSync` bound to `.loop/runs.jsonl`; in tests it is a push onto
 * an array. Returns the serialised line so a caller can echo it under `--json`.
 */
export function appendRecord(record, { appendLine }) {
  const line = `${JSON.stringify(record)}\n`;
  appendLine(line);
  return line;
}
