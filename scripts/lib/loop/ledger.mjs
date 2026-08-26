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
      costUsd: build.costUsd ?? null,
      exitCode: build.exitCode ?? null,
      outcome: build.outcome ?? null,
      risk: build.risk ?? null,
      attempts: build.attempts ?? 0,
      // Present only on a failed BUILD; `jq 'select(.build.failure)'` is the
      // morning triage query.
      ...(build.failure ? { failure: build.failure } : {}),
      ...(build.detail ? { detail: build.detail } : {}),
    },
    gate: {
      steps,
      playgroundRan: gate.playgroundRan ?? false,
      liveSmokesRan: gate.liveSmokesRan ?? false,
    },
    verdictVsGate: parts.verdictVsGate ?? compareVerdictToGate(parts.commandsRun ?? [], steps),
    diffstat: {
      files: diffstat.files ?? 0,
      insertions: diffstat.insertions ?? 0,
      deletions: diffstat.deletions ?? 0,
    },
    guard: { passed: guard.passed ?? null, breaches: guard.breaches ?? [] },
    pr: { number: pr.number ?? null, url: pr.url ?? null },
    ci: {
      conclusion: ci.conclusion ?? null,
      waitedMs: ci.waitedMs ?? null,
      runUrl: ci.runUrl ?? null,
    },
    land: { merged: land.merged ?? false, sha: land.sha ?? null },
    harvest: { beadClosed: harvest.beadClosed ?? false, followUps: harvest.followUps ?? [] },
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
  need('guard.breaches', Array.isArray(record.guard?.breaches));
  need('diffstat', record.diffstat && typeof record.diffstat === 'object');
  need('harvest.followUps', Array.isArray(record.harvest?.followUps));
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
