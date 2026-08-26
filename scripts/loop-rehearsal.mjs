#!/usr/bin/env node
/**
 * A REHEARSAL OF THE LOOP'S GREEN PATH, WHICH HAD NEVER RUN.
 *
 * Measured on `.loop/runs.jsonl` after ten real iterations of the autonomous
 * loop:
 *
 *     WATCH ever returned green : False
 *     LAND ever merged          : False
 *
 * Every recorded iteration ended `parked` or `dry_run`. So CI-green -> LAND ->
 * merge -> close the bead -> next bead from an advanced `main` was unexercised
 * code, and `Cebab-qd2.12` — a queued auto-merge recorded as a completed one —
 * was sitting inside it. That is the shape this whole loop keeps producing:
 * code that succeeds, reports success, and measures nothing.
 *
 * WHAT THIS RUNS: the REAL `scripts/loop.mjs`, the real stage machine, the real
 * git. `scripts/loop.mjs` and `scripts/lib/loop/` are COPIED into a scratch
 * repo, because the driver derives its repo root from its own path — running
 * the installed copy would drive this checkout.
 *
 * WHAT IT FAKES, and why each is honest:
 *
 *   gh      — a PATH shim. It is the whole point: nothing may touch GitHub.
 *   bd      — a PATH shim. The real one would write the operator's bead DB.
 *   npm     — a PATH shim. GATE has run for real ten times; the unproven
 *             stages are the target, and ten real `npm` steps per scenario
 *             would make this too slow to keep.
 *   claude  — a PATH shim emitting the CLI's own result-envelope shape. BUILD
 *             is likewise already proven against the real CLI.
 *
 * THE MERGE IS A FAST-FORWARD PUSH, NOT A SQUASH. `main` has not moved, so the
 * branch is a fast-forward of it and pushing `HEAD:main` into the bare origin
 * advances it exactly as a merge would. What this therefore proves is THE
 * DRIVER'S green path — not GitHub's merge semantics. Branch protection, a real
 * merge queue, and `gh pr merge --delete-branch` switching the operator's local
 * branch are explicitly NOT covered here and need one supervised real run.
 *
 * `scripts/predev-server.mjs` IS DELIBERATELY STUBBED. The real one kills any
 * `tsx watch … src/index.ts` process on the machine, and the driver's teardown
 * invokes it every iteration — so copying it in would let a rehearsal kill the
 * operator's live dev server. The stub keeps the call path exercised and the
 * side effect out.
 *
 * Usage:  node scripts/loop-rehearsal.mjs [scenario ...]     (default: all)
 *         KEEP=1 node scripts/loop-rehearsal.mjs green-merge  (keep the scratch)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ─── scenarios ─────────────────────────────────────────────────────────────
//
// `plan` is read by every shim. `build` is one entry per `claude` invocation.

const SCENARIOS = {
  'green-merge': {
    why: 'CI green, LAND merges, the bead closes, and bead 2 branches off the advanced main',
    args: ['--merge', '--until', '2'],
    plan: { beads: 2, ci: 'green', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [one, two] = ctx.records;
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(one.disposition, 'merged', 'iteration 1 merged');
      ctx.eq(one.land.merged, true, 'land.merged');
      ctx.eq(one.land.queued, false, 'land.queued is false');
      ctx.ok(one.land.sha, 'land.sha is a real commit, not null');
      ctx.eq(one.harvest.beadClosed, true, 'the bead was closed');
      ctx.eq(one.restore.pulled, true, 'the teardown pull advanced main');
      ctx.ok(
        ctx.calls.bd.some((c) => c[0] === 'close'),
        'bd close ran',
      );
      // The compounding failure qd2.12 describes: bead 2 must branch from a
      // main that CONTAINS bead 1, not from the main bead 1 started at.
      ctx.eq(two.disposition, 'merged', 'iteration 2 merged too');
      ctx.ok(ctx.mainContains(one.land.sha), 'origin/main contains iteration 1');
      ctx.ok(ctx.mainContains(two.land.sha), 'origin/main contains iteration 2');
      ctx.eq(ctx.parentOf(two.land.sha), one.land.sha, 'bead 2 branched off bead 1, not main@0');
      ctx.eq(two.land.sha, ctx.originSha(), 'and the last merge IS what origin/main now points at');
    },
  },

  queued: {
    why: 'a merge that only got QUEUED must not close the bead (Cebab-qd2.12)',
    args: ['--merge', '--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'queued', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(row.disposition, 'merge_queued', 'disposition is merge_queued, not merged');
      ctx.eq(row.land.merged, false, 'land.merged is FALSE');
      ctx.eq(row.land.queued, true, 'land.queued is true');
      ctx.eq(row.land.sha, null, 'no merge commit exists to record');
      // The consequence the bead is actually about.
      ctx.eq(row.harvest.beadClosed, false, 'the bead was NOT closed on a prediction');
      ctx.eq(ctx.calls.bd.filter((c) => c[0] === 'close').length, 0, 'bd close never ran');
      ctx.ok(
        ctx.calls.bd.some((c) => c.includes('--append-notes') && c.join(' ').includes('/pull/')),
        'the bead carries a note naming the PR',
      );
      ctx.eq(ctx.originSha(), ctx.baseSha, 'origin/main did NOT move');
    },
  },

  withheld: {
    why: 'the DEFAULT mode: no --merge, so each PR is left for a human — with a note',
    // TWO beads deliberately. With `--merge` the per-iteration restore is
    // unobservable — bead 1 is merged, so bead 2 branching off it looks
    // identical to branching off main. Nothing merges here, so a dropped
    // restore shows up immediately as bead 2's branch sitting on top of
    // bead 1: "bead 2's PR carried bead 1's commits", the defect git.mjs's
    // header describes.
    args: ['--until', '2'],
    plan: { beads: 2, ci: 'green', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(ctx.originSha(), ctx.baseSha, 'and main never moved');
      ctx.eq(
        ctx.parentOf(ctx.refSha('refs/heads/loop/Reh-2')),
        ctx.baseSha,
        'bead 2 branched from MAIN, not from bead 1',
      );
      ctx.eq(row.disposition, 'guard_withheld', 'guard_withheld');
      ctx.eq(row.reason, 'merge_disabled', 'because --merge was absent');
      ctx.eq(row.ci.conclusion, 'success', 'CI still went green');
      ctx.eq(ctx.calls.gh.filter((c) => c[1] === 'merge').length, 0, 'no merge was attempted');
      const note = ctx.calls.bd.find((c) => c.includes('--append-notes'));
      ctx.ok(note, 'the bead got a note (Cebab-qd2.10)');
      ctx.ok(note.join(' ').includes('/pull/'), 'and the note names the PR');
      ctx.eq(ctx.calls.bd.filter((c) => c[0] === 'close').length, 0, 'and was not closed');
    },
  },

  'stale-main': {
    why: 'something landed and main did not move — the run must STOP, not build on it',
    args: ['--merge', '--until', '2'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      breakRemoteAfterMerge: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 1, 'the run stopped after ONE iteration');
      ctx.eq(ctx.records[0].restore.pulled, false, 'the teardown pull failed');
      ctx.ok(ctx.stdout.includes('stale_main'), 'and it said stale_main out loud');
      ctx.eq(ctx.exitCode, 1, 'exiting HALTED, not OK');
    },
  },

  'capped-then-resume': {
    why: 'a turn cap that made progress is resumed once (Cebab-qd2.11)',
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: 'green',
      merge: 'direct',
      build: [
        { kind: 'max_turns', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 2, 'claude ran twice');
      ctx.ok(!ctx.calls.claude[0].includes('--resume'), 'the first attempt was fresh');
      ctx.ok(ctx.calls.claude[1].includes('--resume'), 'the second RESUMED the session');
      ctx.eq(row.build.attempts, 2, 'recorded as two attempts');
      ctx.eq(row.disposition, 'guard_withheld', 'and it got all the way to a green PR');
    },
  },

  'capped-no-progress': {
    why: 'a turn cap that edited nothing was spinning — park it, do not buy it more turns',
    args: ['--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'direct', build: [{ kind: 'max_turns', edit: false }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 1, 'claude ran ONCE — no resume');
      ctx.eq(row.disposition, 'parked', 'parked');
      ctx.eq(row.reason, 'max_turns', 'under its own reason');
      ctx.ok(
        ctx.calls.bd.some((c) => c.includes('loop-stuck')),
        'and the bead was labelled so the next run skips it',
      );
    },
  },
};

// ─── the scratch repo ──────────────────────────────────────────────────────

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function shim(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(file, 0o755);
}

const SHIM_PREAMBLE = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const DIR = process.env.REHEARSAL_DIR;
const argv = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(path.join(DIR, 'plan.json'), 'utf8'));
const statePath = path.join(DIR, 'shim-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const record = (tool) =>
  fs.appendFileSync(path.join(DIR, 'calls.jsonl'), JSON.stringify({ tool, argv }) + '\\n');
`;

function writeShims(dir) {
  shim(
    dir,
    'bd',
    `${SHIM_PREAMBLE}
record('bd');
if (argv[0] === 'ready') {
  const open = plan.beadRows.filter((b) => !state.claimed.includes(b.id));
  process.stdout.write(JSON.stringify(open));
} else if (argv[0] === 'show') {
  const hit = plan.beadRows.find((b) => b.id === argv[1]);
  // The real bd exits 0 on a miss and prints an OBJECT where a hit is an array.
  process.stdout.write(JSON.stringify(hit ? [hit] : { error: 'no issues found' }));
} else if (argv[0] === 'update' && argv.includes('--claim')) {
  state.claimed.push(argv[1]);
  save();
} else if (argv[0] === 'close') {
  state.claimed.push(argv[1]);
  save();
}
process.exit(0);
`,
  );

  shim(
    dir,
    'npm',
    `${SHIM_PREAMBLE}
record('npm');
process.exit(0);
`,
  );

  shim(
    dir,
    'claude',
    `${SHIM_PREAMBLE}
record('claude');
const step = plan.build[Math.min(state.builds, plan.build.length - 1)];
state.builds += 1;
save();
if (step.edit) {
  fs.writeFileSync(path.join(process.cwd(), 'src', 'feature-' + state.builds + '.js'),
    'export const answer = ' + (40 + state.builds) + ';\\n');
}
const sessionId = 'sess-' + (state.session ||= 'a1b2c3');
if (step.kind === 'max_turns') {
  process.stdout.write(JSON.stringify({
    type: 'result', session_id: sessionId, num_turns: 60, total_cost_usd: 0.5,
    terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (60)'],
  }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  type: 'result', session_id: sessionId, num_turns: 7, total_cost_usd: 0.2, is_error: false,
  structured_output: {
    outcome: 'implemented',
    summary: 'rehearsal change',
    commit_type: 'fix', commit_scope: 'rehearsal', commit_subject: 'a rehearsed change',
    files_changed: ['src/feature.js'],
    tests: { added: [], commands_run: ['npm run lint', 'npm test'] },
    risk: 'low', needs_human: false, follow_ups: [],
  },
}));
process.exit(0);
`,
  );

  shim(
    dir,
    'gh',
    `${SHIM_PREAMBLE}
record('gh');
const cwd = process.cwd();
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const runGit = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

if (argv[0] === 'auth') process.exit(0);

if (argv[0] === 'pr' && argv[1] === 'create') {
  state.pr += 1; save();
  out('https://github.invalid/o/r/pull/' + state.pr + '\\n');
  process.exit(0);
}

if (argv[0] === 'pr' && argv[1] === 'edit') process.exit(0);

if (argv[0] === 'api') {
  // The required check is gated behind the matrix, so the FIRST poll shows a
  // pending sibling and no required check at all — the exact shape that used
  // to be misread as "CI never started".
  state.polls += 1; save();
  const required = 'Lint, Typecheck, Test';
  const url = 'https://github.invalid/o/r/runs/900' + state.polls;
  if (state.polls < 2) {
    out({ check_runs: [{ name: 'quality', status: 'in_progress', conclusion: null, html_url: url }] });
    process.exit(0);
  }
  const conclusion = plan.ci === 'green' ? 'success' : 'failure';
  out({ check_runs: [
    { name: 'quality', status: 'completed', conclusion, html_url: url },
    { name: required, status: 'completed', conclusion, html_url: url },
  ] });
  process.exit(0);
}

if (argv[0] === 'run' && argv[1] === 'view') { out('a failing log\\n'); process.exit(0); }

if (argv[0] === 'pr' && argv[1] === 'merge') {
  const auto = argv.includes('--auto');
  if (plan.merge === 'refused') process.exit(1);
  if (plan.merge === 'queued' && !auto) process.exit(1);
  if (plan.merge === 'queued' && auto) { state.queued = true; save(); process.exit(0); }
  // A fast-forward push IS the merge here — main has not moved. See the header.
  runGit(['push', 'origin', 'HEAD:main']);
  state.merged = runGit(['rev-parse', 'HEAD']); save();
  if (plan.breakRemoteAfterMerge) {
    fs.renameSync(path.join(DIR, 'origin.git'), path.join(DIR, 'origin.git.gone'));
  }
  process.exit(0);
}

if (argv[0] === 'pr' && argv[1] === 'view') {
  if (state.merged) out({ state: 'MERGED', mergeCommit: { oid: state.merged }, mergedAt: 'now' });
  else out({ state: 'OPEN', mergeCommit: null, mergedAt: null });
  process.exit(0);
}
process.exit(0);
`,
  );
}

function buildScratch(name, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loop-rehearse-${name}-`));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // A bare origin, and a working clone of it.
  execFileSync('git', ['init', '--bare', '--quiet', path.join(dir, 'origin.git')]);
  git(path.join(dir, 'origin.git'), ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['init', '--quiet', repo]);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [k, v] of [
    ['user.email', 'rehearsal@example.invalid'],
    ['user.name', 'Loop Rehearsal'],
    ['commit.gpgsign', 'false'],
  ]) {
    git(repo, ['config', k, v]);
  }

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'seed.js'), 'export const seed = 1;\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify({ name: 'rehearsal', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
  // `.loop/` holds the lock, the config and the ledger, and preflight refuses a
  // dirty tree — so without this the run stops before SELECT. The real repo
  // gitignores it for the same reason; `clean -fd` also spares it, which is
  // what keeps the ledger alive across the per-iteration restore.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.loop/\n');
  // GATE step 1 is `git diff --exit-code package-lock.json`, which exits 128 —
  // not 1 — when the path does not exist at all. The real repo always has one;
  // a scratch repo without it fails the very first gate step for a reason that
  // has nothing to do with the diff under test.
  fs.writeFileSync(
    path.join(repo, 'package-lock.json'),
    `${JSON.stringify({ name: 'rehearsal', lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );

  // The driver, verbatim. Its repo root is its own directory's parent, which is
  // why it has to be copied rather than invoked in place.
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.cpSync(path.join(REPO, 'scripts', 'lib', 'loop'), path.join(repo, 'scripts', 'lib', 'loop'), {
    recursive: true,
  });
  fs.copyFileSync(path.join(REPO, 'scripts', 'loop.mjs'), path.join(repo, 'scripts', 'loop.mjs'));
  // See the header: the real one kills tsx watch processes on this machine.
  fs.writeFileSync(
    path.join(repo, 'scripts', 'predev-server.mjs'),
    '// rehearsal stub — the real sweep would kill the operator’s dev server\n',
  );

  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  git(repo, ['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);

  const beadRows = Array.from({ length: scenario.plan.beads }, (_, i) => ({
    id: `Reh-${i + 1}`,
    title: `rehearsal bead ${i + 1}`,
    description: 'A bead the rehearsal invents so the driver has something to work.',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  }));
  fs.writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ ...scenario.plan, beadRows }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'shim-state.json'),
    JSON.stringify({ claimed: [], builds: 0, polls: 0, pr: 0, merged: null, queued: false }),
  );
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  writeShims(bin);

  fs.mkdirSync(path.join(repo, '.loop'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.loop', 'config.json'),
    JSON.stringify(
      {
        gate: { playgroundTier: 'never', auditGate: false, stepTimeoutMs: 60000 },
        ci: { pollIntervalMs: 10, appearTimeoutMs: 60000, completeTimeoutMs: 60000 },
        build: { timeoutMs: 60000 },
      },
      null,
      2,
    ),
  );
  return { dir, repo, bin, baseSha: git(repo, ['rev-parse', 'HEAD']) };
}

// ─── running one scenario ──────────────────────────────────────────────────

function runScenario(name, scenario) {
  const scratch = buildScratch(name, scenario);
  const result = spawnSync(process.execPath, ['scripts/loop.mjs', ...scenario.args], {
    cwd: scratch.repo,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      PATH: `${scratch.bin}${path.delimiter}${process.env.PATH}`,
      REHEARSAL_DIR: scratch.dir,
    },
  });

  const ledger = path.join(scratch.repo, '.loop', 'runs.jsonl');
  const records = fs.existsSync(ledger)
    ? fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const calls = { bd: [], gh: [], npm: [], claude: [] };
  for (const line of fs.readFileSync(path.join(scratch.dir, 'calls.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const { tool, argv } = JSON.parse(line);
    calls[tool]?.push(argv);
  }

  const failures = [];
  const ctx = {
    records,
    calls,
    scratch,
    baseSha: scratch.baseSha,
    stdout: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    exitCode: result.status,
    ok: (value, what) => {
      if (!value) failures.push(what);
    },
    eq: (actual, expected, what) => {
      if (actual !== expected) failures.push(`${what} (got ${JSON.stringify(actual)})`);
    },
    originSha: () => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare)) return null;
      return git(bare, ['rev-parse', 'main']);
    },
    mainContains: (sha) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare) || !sha) return false;
      return (
        spawnSync('git', ['merge-base', '--is-ancestor', sha, 'main'], { cwd: bare }).status === 0
      );
    },
    refSha: (ref) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare)) return null;
      const r = spawnSync('git', ['rev-parse', ref], { cwd: bare, encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    },
    parentOf: (sha) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare) || !sha) return null;
      return git(bare, ['rev-parse', `${sha}^`]);
    },
  };

  try {
    scenario.check(ctx);
  } catch (error) {
    failures.push(`check threw: ${error?.message ?? error}`);
  }

  if (!process.env.KEEP) fs.rmSync(scratch.dir, { recursive: true, force: true });
  else process.stdout.write(`  kept: ${scratch.dir}\n`);
  return { failures, ctx, result };
}

export function rehearse(names = Object.keys(SCENARIOS)) {
  const results = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    results.push({ name, why: scenario.why, ...runScenario(name, scenario) });
  }
  return results;
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const results = rehearse(wanted.length > 0 ? wanted : undefined);
  let bad = 0;
  for (const r of results) {
    const mark = r.failures.length === 0 ? 'PASS' : 'FAIL';
    process.stdout.write(`${mark}  ${r.name.padEnd(20)} ${r.why}\n`);
    for (const f of r.failures) process.stdout.write(`        - ${f}\n`);
    if (r.failures.length > 0) {
      bad += 1;
      process.stdout.write(`${r.ctx.stdout.split('\n').slice(-25).join('\n        | ')}\n`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}
