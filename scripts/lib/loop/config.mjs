/**
 * Autonomous loop — configuration, and the `--until` stop condition.
 *
 * PURE. No fs, no process, no clock. `parseUntil` and every predicate below
 * take `now` as an argument, which is what makes the deadline arithmetic
 * testable at all: a helper that read `Date.now()` internally could only be
 * tested by sleeping, and the overnight paths (stop at 07:00, reserve 45 min
 * before a deadline) are exactly the ones nobody will sit through.
 *
 * WHY UNKNOWN KEYS ARE AN ERROR RATHER THAN A WARNING. The config carries
 * `guard.denyPaths` — the list that decides which files the loop refuses to
 * merge unattended. A typo there (`denyPath`, `deny_paths`) silently produces
 * an EMPTY deny list layered under the defaults, and the guard then passes
 * everything it was configured to stop. That is the `project_gates_pass_
 * vacuously` shape: a gate that runs, reports success, and measures nothing.
 * So a key the defaults do not define is refused by name, and the driver
 * exits 2 rather than starting a run on a config it did not understand.
 */

/** Thrown for anything the operator can fix by editing config or CLI flags. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Built-in defaults. This object is also the SCHEMA: `resolveConfig` rejects
 * any key an override introduces that does not appear here, so adding a
 * setting means adding it to this literal.
 *
 * Every budget limit ships wired but OFF (null / 0 / empty). The maintainer
 * wants to see where consumption actually goes across real runs before
 * anything is capped, and a limit that fires unasked during the first week is
 * indistinguishable from a bug. `loop.merge` is false for the same reason:
 * the first runs must be observable before anything merges itself.
 */
export const DEFAULTS = Object.freeze({
  select: {
    maxPriority: 2,
    // `loop-declined` is the second half of `loop-stuck` — see `beads.mjs`.
    // BOTH exclude, and the exclusion is the point in both cases; the label
    // only says WHICH kind of no this was. Omitting it here would make the new
    // label decorative and re-select every declined bead on the next run.
    excludeLabels: ['loop-stuck', 'loop-declined', 'needs-human', 'epic'],
    excludeTypes: ['epic', 'decision'],
    excludeIdPrefixes: [],
    // THE LOOP'S OWN EPIC. Every bead filed under it is about the driver, and
    // the deny-path text scan only catches the ones that spell a full path out
    // — measured 2026-08-27, when a bead discussing `machine.mjs` and
    // `teardown` by basename was selected and began a full BUILD. `parent` is
    // present on every `bd ready --json` row, so this costs nothing.
    //
    // Repo-specific, like `guard.denyPaths` right below it, and for the same
    // reason: what the loop must not touch is a fact about THIS repo.
    excludeParents: ['Cebab-qd2'],
    sortPolicy: 'hybrid',
  },
  build: {
    model: 'opus',
    effort: 'high',
    maxTurns: 60,
    permissionMode: 'acceptEdits',
    timeoutMs: 2400000,
    tiers: [],
  },
  gate: {
    playgroundTier: 'auto',
    // An EXEMPT list, not a trigger list — see `playgroundTriggered`. Anything
    // not named here reaches the Playground tier, so a subsystem nobody
    // thought of is covered by default instead of silently skipped. A leading
    // `*` is a suffix match; `[]` means literally no exceptions.
    playgroundExemptPaths: ['web/', 'docs/', '*.md'],
    playgroundRoot: '../Playground',
    // ON. The tier without live smokes is a boot check: it proves the server
    // starts, and nothing about the behaviour the bead changed. Measured over
    // the run of 2026-09-01 (`.loop/runs.jsonl`, 41 records): `playgroundRan`
    // true 23 times, `liveSmokesRan` false 41 times — so four managed-agent
    // PRs shipped without `managed_file_smoke.ts`, the smoke CLAUDE.md names
    // by hand for exactly that verification, ever running. These spawn real
    // `claude` sessions and bill the subscription; that is the intended trade.
    liveSmokes: true,
    auditGate: true,
    stepTimeoutMs: 900000,
  },
  guard: {
    denyPaths: [
      // THE LOOP'S OWN HARNESS, and it is the same argument that put
      // `audit-gate.mjs` and `security-test-gate.mjs` on this list — the
      // omission was an oversight, since the deny list predates these files.
      //
      // Measured: before this, `evaluateGuard` passed a diff editing
      // `scripts/loop.mjs` with zero breaches, so with `--merge` the loop
      // could rewrite the driver it was running from and land it unattended.
      // The already-loaded module is unaffected mid-run, so the hazard is not
      // a crash — it is that the REST of an overnight `--until 8` runs a
      // driver no human read, and every safety property the loop has (this
      // very list, the circuit breaker, the usage-limit halt, LAND's
      // read-back) lives in these files.
      //
      // The tests are denied too: a loop that can edit its own tests can turn
      // a broken guard green. Nothing is blocked by this — a breach does not
      // abort, it opens the PR labelled `loop-guard` and withholds LAND, which
      // is exactly right for a diff that changes the harness.
      'scripts/loop.mjs',
      'scripts/loop.test.mjs',
      'scripts/loop-rehearsal.mjs',
      'scripts/loop-rehearsal.test.mjs',
      'scripts/lib/loop/**',
      '.github/**',
      '.husky/**',
      '.semgrep/**',
      '.npmrc',
      '.gitleaks.toml',
      'osv-scanner.toml',
      'eslint.config.js',
      'vitest.config.ts',
      'vitest.setup.mjs',
      'scripts/audit-gate.mjs',
      'scripts/security-test-gate.mjs',
      'scripts/kanban-sync.mjs',
      'scripts/kanban-sync.test.mjs',
      'package-lock.json',
    ],
    maxFilesChanged: 25,
    maxNetLinesAdded: 600,
    allowTestDeletions: false,
    forbidInDiff: ['--no-verify'],
  },
  ci: {
    requiredContext: 'Lint, Typecheck, Test',
    pollIntervalMs: 30000,
    // Measured: Cebab's required check `needs:` the ubuntu+windows matrix and
    // first appeared 11m23s after the workflow started. The driver's primary
    // guard against a false `absent` is "nothing else is pending"; this is the
    // backstop for a CI that produces no checks at all, so it sits well past
    // the matrix rather than inside it.
    appearTimeoutMs: 900000,
    completeTimeoutMs: 2700000,
  },
  loop: {
    until: ['1'],
    maxRepairs: 2,
    consecutiveParkLimit: 3,
    // Higher than the park limit ON PURPOSE. A decline costs a handful of turns
    // and tells the truth about one bead; three of them in a row is a plausible
    // run of unsuitable queue head, not a symptom. Five is where "this queue is
    // not for the loop" starts being the better explanation than chance.
    consecutiveDeclineLimit: 5,
    merge: false,
  },
  limits: {
    // THE RUN CEILING IS IN TOKENS, NOT DOLLARS, because the loop runs on a
    // Claude subscription: a dollar figure prices a transaction that never
    // happens, and the constraint the operator actually has is a rolling usage
    // window. Counted as input + output + cache WRITES — `meteredTokens` in
    // `usage.mjs` owns that definition and the reason cache reads are left out.
    tokenCeiling: null,
    // Still dollars, and it has to be: this is passed straight through as the
    // CLI's own `--max-budget-usd`, which is the only per-bead budget the CLI
    // enforces mid-turn. There is no `--max-tokens` equivalent (measured
    // 2026-08-27 against `claude --help`), and a driver-side token sum can only
    // notice an overrun it has already paid for. Treat the number as a proxy
    // for tokens, not as a bill.
    beadCostCeilingUsd: null,
    cooldownMsBetweenBeads: 0,
    reserveMs: 2700000,
    onSessionLimit: 'halt',
    onWeeklyLimit: 'halt',
  },
  harvest: {
    followUpPriority: 3,
    followUpLabel: 'loop-found',
    syncBoardAtEnd: true,
  },
});

const UNTIL_COUNT = /^\d+$/;
const UNTIL_CLOCK = /^(\d{1,2}):(\d{2})$/;
const UNTIL_DURATION = /^(\d+)([hm])$/;

/**
 * `--until` is one flag with four forms, because bead-count, clock-time and
 * wall-clock budget are the same decision. Parse by SHAPE.
 *
 * Clock and duration both reduce to `{ kind: 'deadline', at }` — the caller
 * needs no case analysis, and `reserveBlocks` below has exactly one kind to
 * look at. `raw` survives so `--status` can name which condition tripped.
 *
 * Anything unrecognised THROWS. There is deliberately no fallback to the
 * default: `--until 8h30m` silently meaning "one bead" is worse than refusing
 * to start, because the operator finds out at 3am by way of an empty ledger.
 */
export function parseUntil(value, now) {
  if (typeof value !== 'string') {
    throw new ConfigError(`--until expects a string, received ${typeof value}`);
  }
  const raw = value.trim();
  if (raw === 'drain') return { kind: 'drain', raw };

  if (UNTIL_COUNT.test(raw)) {
    const count = Number(raw);
    if (count < 1) throw new ConfigError(`--until ${raw}: iteration count must be at least 1`);
    return { kind: 'count', raw, count };
  }

  const clock = UNTIL_CLOCK.exec(raw);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23) throw new ConfigError(`--until ${raw}: hour must be 00-23`);
    if (minutes > 59) throw new ConfigError(`--until ${raw}: minute must be 00-59`);
    const base = new Date(now);
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes, 0, 0);
    // "Next occurrence of that LOCAL time" — already past today means tomorrow.
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return { kind: 'deadline', raw, at: at.getTime() };
  }

  const duration = UNTIL_DURATION.exec(raw);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount < 1) throw new ConfigError(`--until ${raw}: duration must be at least 1`);
    const ms = duration[2] === 'h' ? amount * 3600000 : amount * 60000;
    return { kind: 'deadline', raw, at: now + ms };
  }

  throw new ConfigError(
    `--until ${raw}: unrecognised. Expected an iteration count (8), a local time (07:00), ` +
      `a duration (2h, 90m), or the literal 'drain'.`,
  );
}

/** Has one parsed condition tripped? `drained` comes from SELECT finding nothing. */
export function untilTripped(condition, { iterations, now, drained }) {
  switch (condition.kind) {
    case 'count':
      return iterations >= condition.count;
    case 'deadline':
      return now >= condition.at;
    case 'drain':
      return drained === true;
    default:
      throw new ConfigError(`unknown --until kind: ${condition.kind}`);
  }
}

/** First condition to trip wins; returns it so the run can report which one. */
export function firstTripped(conditions, ctx) {
  for (const condition of conditions) {
    if (untilTripped(condition, ctx)) return condition;
  }
  return null;
}

/**
 * "Do not start a bead you cannot finish." With less than `reserveMs` left
 * against a DEADLINE, stop before SELECT rather than beginning an iteration
 * that gets cut off half-built.
 *
 * Count and drain conditions have no deadline to reserve against, so
 * `reserveMs` is inert for them — that is specified behaviour, not an
 * oversight, and the test asserts it in both directions.
 */
export function reserveBlocks(conditions, { now }, reserveMs) {
  if (!reserveMs || reserveMs <= 0) return null;
  for (const condition of conditions) {
    if (condition.kind !== 'deadline') continue;
    if (condition.at - now < reserveMs) return condition;
  }
  return null;
}

/**
 * SETTINGS WHOSE VALUE SPACE THE CODE ACTUALLY IMPLEMENTS.
 *
 * The module already refuses an unknown KEY by name, and the same argument
 * applies to a VALUE nothing reads. `limits.onSessionLimit` and
 * `limits.onWeeklyLimit` were defined here and grepped for exactly twice — both
 * times this file. `machine.mjs` halts on ANY usage limit regardless of kind,
 * so today's behaviour matched the defaults by accident, and an operator could
 * set `onWeeklyLimit: 'wait'`, have it validated, and have it silently ignored.
 * That is strictly worse than a typo, which at least exits 2 with the key name.
 *
 * `gate.playgroundTier` is here for the sharper version of the same problem:
 * `playgroundTriggered` treats every unrecognised value as `auto`, so
 * `"nver"` does not disable the Playground tier — it enables the default one,
 * which is the opposite of what was asked for.
 *
 * Implementing `wait` is the larger job and is deliberately not done: `resetsAt`
 * is free text taken verbatim from the CLI ("3:45pm", "Monday"), never parsed,
 * so a waiting implementation would have to parse what the detector refuses to.
 */
const IMPLEMENTED_VALUES = Object.freeze({
  'limits.onSessionLimit': ['halt'],
  'limits.onWeeklyLimit': ['halt'],
  'gate.playgroundTier': ['auto', 'always', 'never'],
});

function unimplementedValues(config) {
  const bad = [];
  for (const [path, allowed] of Object.entries(IMPLEMENTED_VALUES)) {
    const [group, key] = path.split('.');
    const value = config[group]?.[key];
    if (!allowed.includes(value)) {
      bad.push(`${path}=${JSON.stringify(value)} (implemented: ${allowed.join(', ')})`);
    }
  }
  return bad;
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-merge overrides onto defaults, collecting every unknown key rather than
 * throwing at the first — the operator should see the whole list, not fix one
 * typo per run. Arrays are REPLACED wholesale: a `denyPaths` override means
 * "this list", never "the defaults plus these", which would make removing a
 * default entry impossible.
 */
function mergeLayer(base, override, path, unknown) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const here = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      unknown.push(here);
      continue;
    }
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      out[key] = mergeLayer(base[key], value, here, unknown);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * defaults -> file -> CLI. Later layers win. Throws ConfigError naming every
 * unknown key across all layers; the driver turns that into exit 2.
 */
export function resolveConfig({ file = {}, cli = {} } = {}) {
  const unknown = [];
  let merged = mergeLayer(DEFAULTS, file, '', unknown);
  merged = mergeLayer(merged, cli, '', unknown);
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown config key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    );
  }
  // A key the defaults define but whose VALUE nothing implements. See above:
  // silently ignoring it is worse than refusing an unknown key.
  const unimplemented = unimplementedValues(merged);
  if (unimplemented.length > 0) {
    throw new ConfigError(
      `config value${unimplemented.length > 1 ? 's' : ''} not implemented: ` +
        `${unimplemented.join('; ')}`,
    );
  }
  return merged;
}
