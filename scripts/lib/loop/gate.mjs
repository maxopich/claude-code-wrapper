/**
 * Autonomous loop — GATE. Re-runs what the agent says it ran.
 *
 * THE AGENT'S REPORT IS NOT EVIDENCE. Nothing here reads the verdict; the
 * steps below are the same ones `.github/workflows/ci.yml` runs, in the same
 * order, and their exit codes are what decide. The verdict is compared to them
 * afterwards and the disagreement is RECORDED, never branched on.
 *
 * R3 — TEARDOWN IS IN A `finally`, ALWAYS. `tsx watch` does not exit when its
 * child dies: it reparents to launchd and squats port 4319 forever. A loop
 * that starts the server twenty times a night leaves twenty behind, and
 * `predev-server.mjs` only sweeps at the NEXT start. So the Playground tier
 * kills its own process group and then invokes `predev-server.mjs` to sweep
 * anything that outlived it — reusing the existing cross-platform ps/wmic scan
 * rather than reimplementing it here.
 *
 * R2 — THE PLAYGROUND PRECONDITION IS A HARD GATE, AND PREFLIGHT OWNS IT.
 * `.env` is gitignored and often absent, and absent it means `dev:server` runs
 * against the operator's REAL `~/.cebab` and `~/agents`. `assertPlaygroundEnv`
 * lives here but is called from preflight, so a missing `.env` is one exit 2
 * at second zero rather than three parked beads that each misdescribe it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from './config.mjs';
import { killTree, spawnDetached } from './run.mjs';

/** §6.4, in CI's order. `npm` is resolved per-platform by the run seam. */
export const DETERMINISTIC_STEPS = Object.freeze([
  // `--cached` IS THE WHOLE STEP. Without it this compares the working tree to
  // the INDEX — and the driver calls `git.changedPaths()` immediately before
  // GATE, which opens with `git add -A`. Everything is staged by then, so there
  // is no unstaged diff left to find and the step could not fail. Measured:
  // with package-lock.json genuinely modified, the un-cached form exits 1
  // before staging and 0 after, so it reported a pass in every ledger row ever
  // written while checking nothing.
  //
  // `--cached` compares the INDEX to HEAD, and the branch is fresh from main,
  // so it sees exactly the agent's own lockfile change. Measured in both
  // directions: 1 when the lockfile moved, 0 when only other files did.
  //
  // The real protection was never absent — `git.lockfileChanged()` at PUBLISH
  // uses the same comparison against the merge base and hard-parks. What was
  // absent is the early exit this step exists for. `Cebab-qd2.30`.
  {
    name: 'lockfile',
    file: 'git',
    args: ['diff', '--cached', '--exit-code', 'package-lock.json'],
  },
  { name: 'lint', file: 'npm', args: ['run', 'lint'] },
  { name: 'format:check', file: 'npm', args: ['run', 'format:check'] },
  { name: 'typecheck', file: 'npm', args: ['run', 'typecheck'] },
  { name: 'audit-gate', file: 'node', args: ['scripts/audit-gate.mjs'], skippableOnNetwork: true },
  { name: 'test', file: 'npm', args: ['test'] },
  { name: 'test:security', file: 'npm', args: ['run', 'test:security'] },
  { name: 'smoke', file: 'npm', args: ['run', 'smoke'] },
  { name: 'build', file: 'npm', args: ['run', 'build'] },
  {
    name: 'ci_smoke',
    file: 'npm',
    args: ['--workspace', 'server', 'exec', 'tsx', 'src/ci_smoke.ts'],
  },
]);

const NETWORK_HINTS = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'network'];

/**
 * Does this diff warrant the Playground tier?
 *
 * AN EXEMPT LIST, NOT A TRIGGER LIST, AND THE DIRECTION IS THE WHOLE POINT.
 * This was `playgroundTriggerPaths: ['server/', 'shared/']` — an allow-list,
 * so the tier fired only for the two roots someone had thought of. A change
 * under `scripts/`, a migration outside those roots, or a root config change
 * reached `main` having never started a server. The operator's rule is the
 * inverse: anything that is not UI has to go through the tier, and cost is not
 * the constraint, because reworking an unattended merge costs more.
 *
 * So the default is now RUN, and an exemption has to be named. A subsystem
 * nobody anticipated is covered instead of silently skipped, which is the
 * failure mode an allow-list has and a deny-list does not.
 *
 * Exempt means "cannot change runtime behaviour": `web/` is the UI the rule
 * carves out by name, and documentation is the deliverable for a docs bead
 * (`build-prompt.md` says so — no test is required for one).
 *
 * An entry beginning with `*` is a SUFFIX match, everything else a path
 * prefix, which is why `*.md` is an entry rather than a hardcoded extra
 * condition: the doc defects this loop files are usually in root `CLAUDE.md`
 * or `README.md`, so the extension rule is needed — but a rule living outside
 * the list would make `playgroundExemptPaths: []` a lie, still silently
 * exempting every markdown file while claiming no exceptions. One list, no
 * hidden rules. (Caught by the `[]` case in `loop.test.mjs`, which failed
 * against exactly that first implementation.)
 *
 * EVERY path must be exempt for the diff to skip. A bead that touches
 * `web/src/store.ts` AND `server/src/ws/server.ts` runs the tier — the mixed
 * diff is exactly where a UI change and a protocol change disagree.
 *
 * `'always'` and `'never'` still override outright; `IMPLEMENTED_VALUES` in
 * `config.mjs` refuses any other tier value rather than treating it as `auto`.
 */
export function playgroundTriggered(changedPaths, gate) {
  if (gate.playgroundTier === 'always') return true;
  if (gate.playgroundTier === 'never') return false;
  // No diff, nothing to exercise. Not the same as "everything was exempt":
  // `[].every()` is true, so without this the empty case would read as exempt
  // by accident rather than by decision.
  if (changedPaths.length === 0) return false;
  const exempt = gate.playgroundExemptPaths ?? [];
  const matches = (entry, p) =>
    entry.startsWith('*') ? p.endsWith(entry.slice(1)) : p.startsWith(entry);
  return !changedPaths.every((p) => exempt.some((e) => matches(e, p)));
}

/** Parse a dotenv file well enough for the two keys that matter. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const expandHome = (p) => (p.startsWith('~') ? path.join(process.env.HOME ?? '', p.slice(1)) : p);

/**
 * The env BOTH halves of the Playground tier run with.
 *
 * `ws_smoke.ts` (and its siblings) fall back to `~/.cebab/auth-token` when
 * `CEBAB_AUTH_TOKEN_FILE` is unset. The server loads `../.env` on its own and
 * writes its per-launch token into the Playground data dir, so a smoke spawned
 * with plain `process.env` read the operator's REAL data dir, got a token
 * belonging to some other server, and was refused: measured as
 * `ws_smoke FAIL 240ms Unexpected server response: 401`, every time, which is
 * why this tier had never once passed. Reaching into `~/.cebab` at all is the
 * second half of it — an isolated gate touching live operator data is the
 * outcome R2 exists to prevent, and it was doing that on the way to failing.
 */
export function playgroundSmokeEnv(parsedEnv, baseEnv = process.env) {
  const dataDir = path.resolve(expandHome(parsedEnv.CEBAB_DATA_DIR ?? ''));
  return {
    ...baseEnv,
    ...parsedEnv,
    CEBAB_DATA_DIR: dataDir,
    CEBAB_AUTH_TOKEN_FILE: path.join(dataDir, 'auth-token'),
  };
}

/**
 * Which smokes the tier runs. NEVER `ws_smoke`.
 *
 * `ci_smoke` is deterministic step 10 and already runs `ws_smoke` correctly —
 * it spawns its own mock server over a temp workspace it populates with a
 * `Cebab` directory, because `ws_smoke.ts` looks a project up by that exact
 * name and exits when it is missing. Run bare against the Playground it could
 * never pass: that workspace holds ten agent projects and none is called
 * `Cebab`. Provisioning one would not fix it either — `ci_smoke` also sets
 * `MOCK=1`, and without that `ws_smoke`'s `send_message` spawns a REAL
 * `claude` turn, so a green gate step would quietly bill the subscription.
 *
 * What the tier contributes instead is the boot itself: that the server this
 * bead changed comes up against a real data dir and answers /health, which is
 * exactly what `ci_smoke`'s mock server cannot show.
 */
export function playgroundSmokes(gate) {
  if (!gate.liveSmokes) return [];
  // These spawn REAL `claude` sessions against the operator's subscription.
  // That is the accepted cost of the rule in `playgroundTriggered`, not a
  // reason to keep them off — a boot check cannot observe the behaviour a bead
  // changed, and four managed-agent PRs merged unreviewed in the run of
  // 2026-09-01 without `managed_file_smoke` running once.
  //
  // EVERY ENTRY HERE MUST FAIL ON A FAILED ASSERTION, because `runPlayground`
  // branches on the exit code and nothing else. Verified per script before
  // adding: `live_smoke` ends `process.exit(resumed ? 0 : 1)`;
  // `bus_max_turns_smoke` ends `process.exit(failures.length === 0 ? 0 : 1)`;
  // `managed_file_smoke`, `mcp_scope_smoke` and `system_prompt_smoke` each set
  // `process.exitCode = 1` on a failed check, and `system_prompt_smoke` carries
  // its own positive control so a silent no-op reads as a failure rather than
  // as a pass.
  //
  // `bus_pause_gate_smoke.ts` IS DELIBERATELY ABSENT and must stay absent. It
  // is a MEASUREMENT script: its only `process.exit(1)` is the `MOCK=1` guard,
  // and it prints a summary of `consulted` / `bypassed` / `inconclusive` and
  // then falls off the end at exit 0 whatever it found. As a gate step it
  // could not fail — a step that always passes reads as coverage and is none.
  // `playground_smokes_assert` pins the exclusion so it is not re-added by
  // symmetry with its neighbours.
  return [
    { name: 'live_smoke', script: 'src/live_smoke.ts' },
    { name: 'mcp_scope_smoke', script: 'src/mcp_scope_smoke.ts' },
    { name: 'managed_file_smoke', script: 'src/managed_file_smoke.ts' },
    { name: 'bus_max_turns_smoke', script: 'src/bus_max_turns_smoke.ts' },
    { name: 'system_prompt_smoke', script: 'src/system_prompt_smoke.ts' },
  ];
}

/**
 * R2. Throws unless `.env` exists and BOTH data paths resolve inside the
 * Playground root. Never returns a soft "skip" — testing against the
 * maintainer's live data is the worst outcome this design exists to prevent,
 * and it is the DEFAULT when `.env` is missing, so silence is the dangerous
 * answer.
 *
 * Throws `ConfigError` specifically, because every one of these is something
 * the operator fixes by editing a file. Only `ConfigError` maps to exit 2 in
 * `loop.mjs`; a plain `Error` here exits 1 and prints a stack trace, which is
 * how the very first thing an operator hits — `.env` is gitignored, so it is
 * absent on a fresh clone — reported itself as an internal crash.
 */
export function assertPlaygroundEnv({ repoRoot, gate, readFile = fs.readFileSync }) {
  const envPath = path.join(repoRoot, '.env');
  let text;
  try {
    text = readFile(envPath, 'utf8');
  } catch {
    throw new ConfigError(
      `the Playground gate tier needs ${envPath}, which does not exist. Without it the ` +
        `gate's dev:server runs against the real ~/.cebab and ~/agents. ` +
        `Playground/README.md carries the exact four lines to write, or set ` +
        `gate.playgroundTier to "never".`,
    );
  }
  const env = parseEnvFile(text);
  const root = path.resolve(repoRoot, gate.playgroundRoot);
  for (const key of ['CEBAB_DATA_DIR', 'WORKSPACE_ROOT']) {
    const value = env[key];
    if (!value)
      throw new ConfigError(`${envPath} does not set ${key}; refusing to run the Playground tier.`);
    const resolved = path.resolve(expandHome(value));
    // `relative` rather than `startsWith`: /a/Playground-evil starts with the
    // root string but is not inside it.
    const rel = path.relative(root, resolved);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!inside) {
      throw new ConfigError(
        `${envPath}: ${key}=${value} resolves to ${resolved}, which is OUTSIDE ${root}. ` +
          `Refusing to run — this is how a gate ends up testing against live operator data.`,
      );
    }
  }
  return { root, env };
}

export function makeGate({ run, cwd, config, log = () => {} }) {
  const stepTimeout = config.gate.stepTimeoutMs;

  async function runDeterministic() {
    const steps = [];
    for (const step of DETERMINISTIC_STEPS) {
      if (step.name === 'audit-gate' && config.gate.auditGate === false) continue;
      log(`gate: ${step.name}`);
      const r = await run(step.file, step.args, { cwd, timeoutMs: stepTimeout });
      // A network error on the audit gate is a SKIP, not a failure: the
      // advisory feed is not this bead's diff. Recorded as skipped so it never
      // reads as a pass.
      if (step.skippableOnNetwork && r.code !== 0) {
        const blob = `${r.stdout}\n${r.stderr}`;
        if (NETWORK_HINTS.some((h) => blob.includes(h))) {
          steps.push({ name: step.name, exitCode: 0, ms: r.ms, skipped: 'network' });
          continue;
        }
      }
      steps.push({ name: step.name, exitCode: r.code, ms: r.ms });
      if (r.code !== 0) {
        return { passed: false, steps, failedStep: step.name, output: tail(r) };
      }
    }
    return { passed: true, steps };
  }

  /**
   * The env the Playground tier runs BOTH halves with.
   *
   * The server loads `../.env` by itself (`server/package.json` passes
   * `--env-file-if-exists`), so it writes its per-launch auth token into the
   * Playground data dir. The SMOKES were spawned with plain `process.env`, and
   * `ws_smoke.ts` falls back to `~/.cebab/auth-token` when
   * `CEBAB_AUTH_TOKEN_FILE` is unset — so it read the operator's REAL data
   * dir, got a token belonging to some other server, and was refused. Measured:
   * `ws_smoke  FAIL  240ms  Unexpected server response: 401`, every time, which
   * is why this whole tier had never passed.
   *
   * Reading `~/.cebab` at all is the second half of the problem: an isolated
   * gate that reaches into live operator data is the outcome R2 exists to
   * prevent, and it was doing it on the way to failing.
   */
  function playgroundEnv() {
    const { env } = assertPlaygroundEnv({ repoRoot: cwd, gate: config.gate });
    return playgroundSmokeEnv(env);
  }

  async function runPlayground() {
    const steps = [];
    let server = null;
    const env = playgroundEnv();
    try {
      log('gate: starting Playground dev:server');
      server = spawnDetached('npm', ['run', 'dev:server'], { cwd, env });
      const ready = await waitForHealth(config.ci.pollIntervalMs, env.PORT);
      if (!ready) {
        steps.push({ name: 'dev:server', exitCode: 1, ms: 60000 });
        return { passed: false, steps, failedStep: 'dev:server', output: server.readOutput() };
      }
      // Booting IS the baseline signal, and it is the one thing `ci_smoke`
      // cannot give: that the server this bead changed comes up against a real
      // data dir and answers /health. Recorded as its own step so a tier that
      // did nothing else is still visible in the ledger.
      steps.push({ name: 'dev:server', exitCode: 0, ms: 0 });

      // NOT `ws_smoke`. It is already covered by `ci_smoke`, which is
      // deterministic step 10 and passes — and `ci_smoke` runs it correctly,
      // spawning its own mock server over a temp workspace it populates with a
      // `Cebab` directory, because `ws_smoke.ts` looks up a project by that
      // exact name and exits if it is missing.
      //
      // Run bare against the Playground it could never pass: that workspace
      // holds ten agent projects and none is called `Cebab`, so this tier
      // failed with `Cebab project not found in workspace` on every server
      // bead. Provisioning one would not fix it either — `ci_smoke` also sets
      // `MOCK=1`, and without that `ws_smoke`'s `send_message` spawns a REAL
      // `claude` turn, so a green gate step would quietly bill the operator's
      // subscription.
      const smokes = playgroundSmokes(config.gate);

      for (const smoke of smokes) {
        log(`gate: ${smoke.name}`);
        const r = await run('npm', ['--workspace', 'server', 'exec', 'tsx', smoke.script], {
          cwd,
          env,
          timeoutMs: stepTimeout,
        });
        steps.push({ name: smoke.name, exitCode: r.code, ms: r.ms });
        if (r.code !== 0) return { passed: false, steps, failedStep: smoke.name, output: tail(r) };
      }
      return { passed: true, steps };
    } finally {
      // R3. Own group first, then the repo's existing sweep for anything that
      // outlived it.
      killTree(server?.child);
      await run('node', ['scripts/predev-server.mjs'], { cwd, timeoutMs: 30000 }).catch(() => {});
    }
  }

  async function waitForHealth(intervalMs, playgroundPort) {
    const deadline = Date.now() + 60000;
    // The Playground's own PORT, not the loop process's — the loop never loads
    // `.env`, so `process.env.PORT` here is whatever the operator's shell had.
    const port = playgroundPort ?? process.env.PORT ?? '4319';
    while (Date.now() < deadline) {
      try {
        const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, intervalMs)));
    }
    return false;
  }

  return {
    /**
     * THE ONE GATE FAILURE WITH A MECHANICAL FIX.
     *
     * Measured 2026-08-28 across every run the loop has ever made: EVERY gate
     * failure was `format:check` and nothing else — 6 of 6 in the console log,
     * 5 of 8 builds in the run of 2026-08-27, with zero lint, typecheck, test,
     * build, smoke or ci_smoke failures in that whole night. Each one cost a
     * full repair: a second `claude -p` invocation re-establishing the entire
     * bead context to run one command that takes two seconds.
     *
     * The CONSOLE LOG, not the ledger — no ledger row records a gate failure at
     * all, because `parts.gate` is reassigned per attempt and keeps the passing
     * retry (`Cebab-qd2.43`). The driver exempts THIS path by keeping the failing
     * run's steps, which is what makes the claim below true rather than
     * aspirational.
     *
     * WHY THIS RUNS AFTER THE FAILURE AND NOT BEFORE IT, which is the opposite
     * of the obvious design. `Cebab-oit` proposed inserting `npm run format` as
     * a step immediately BEFORE `format:check` — and that would make the check
     * green by construction, since `prettier --write` followed by
     * `prettier --check` can only disagree about a file prettier cannot parse.
     * A gate step that can no longer fail is a gate step measuring nothing,
     * which is the defect class this repo is least willing to add. Running it
     * only once the check has ALREADY failed keeps the step live: the failure
     * is real, is recorded in `gate.steps`, and is what triggers this.
     *
     * `prettier --write .` is repo-wide, but its blast radius is bounded by
     * something already true: CI enforces `format:check` on every PR, so `main`
     * is always format-clean and a branch cut from it has no pre-existing
     * misformatted file to sweep in. Verified on this checkout.
     *
     * NOT a general "autofix the gate" seam, and it must not become one. Every
     * other step fails for a reason that needs judgement; this one fails for a
     * reason that needs a command.
     */
    async autofixFormat() {
      return run('npm', ['run', 'format'], { cwd, timeoutMs: stepTimeout });
    },
    async run({ changedPaths }) {
      const deterministic = await runDeterministic();
      if (!deterministic.passed) {
        return { ...deterministic, playgroundRan: false, liveSmokesRan: false };
      }
      if (!playgroundTriggered(changedPaths, config.gate)) {
        return { ...deterministic, playgroundRan: false, liveSmokesRan: false };
      }
      const playground = await runPlayground();
      return {
        passed: playground.passed,
        steps: [...deterministic.steps, ...playground.steps],
        failedStep: playground.failedStep,
        output: playground.output,
        playgroundRan: true,
        liveSmokesRan: Boolean(config.gate.liveSmokes),
      };
    },
  };
}

const tail = (r, lines = 80) =>
  `${r.stdout}\n${r.stderr}`.split('\n').slice(-lines).join('\n').trim();
