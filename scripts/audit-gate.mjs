/**
 * CI dependency-audit gate — `npm audit` with a per-advisory allowlist.
 *
 *   node scripts/audit-gate.mjs            # CI: fail on unexcused high/critical
 *   node scripts/audit-gate.mjs --json     # print the parsed decision, exit the same
 *
 * Replaces the bare `npm audit --audit-level=high` step in ci.yml.
 *
 * WHY THIS EXISTS. `npm audit` has no per-advisory ignore: the only knobs
 * are `--audit-level` (blunt — drops a whole severity band) and `--omit=dev`
 * (blunter — stops looking at dev deps entirely, which in this repo is the
 * wrong direction: bus agents run under bypassPermissions, so a poisoned
 * dev dependency is squarely in the threat model — see .npmrc). So the only
 * previously available response to one unfixable advisory was to disable the
 * gate for ALL of them, which is what ci.yml's old "temporarily set
 * continue-on-error" comment resorted to.
 *
 * Meanwhile the OSV gate already had exactly the right mechanism —
 * `osv-scanner.toml`'s `[[IgnoredVulns]]`, each entry carrying an
 * `ignoreUntil` date and a written reason. This script points `npm audit`
 * at that SAME file, so the two required security checks share one
 * allowlist instead of one having a scalpel and the other a switch.
 * Excusing an advisory is a single reviewable diff that both gates honour.
 *
 * FAIL-CLOSED, in every direction that matters:
 *   - unreadable/unparseable `osv-scanner.toml`         → exit 1
 *   - `npm audit` output that isn't JSON                 → exit 1
 *   - an ignore entry whose `ignoreUntil` has lapsed     → exit 1 (the date
 *     is a real deadline, not decoration — this is the whole point of
 *     writing one down). At ANY severity: the entry's existence is what
 *     makes the date binding, not the severity of what it covers. Until
 *     register C17 this line was false for moderate and low, which was
 *     most of the allowlist.
 *   - an ignore entry missing `id` or `ignoreUntil`      → exit 1
 *   - any high/critical advisory not on the list         → exit 1
 *
 * Deliberately NOT fail-closed on one thing: an ignore entry that matched
 * nothing this run is reported as a warning, not an error. OSV-Scanner
 * already hard-fails on unused ignores (that behaviour is what silently
 * broke CI on 2026-07-28 — seven entries went stale at once and the scan
 * failed with no vulnerability present). One gate enforcing that is a
 * useful prod; two gates enforcing it just doubles the blast radius of a
 * routine Dependabot bump.
 *
 * Severity policy is unchanged from the step it replaces: high + critical
 * block, moderate/low are reported and don't. Dependabot handles the rest
 * on its weekly cadence.
 *
 * Note the two are separate questions, and conflating them is what C17 was:
 * SEVERITY decides whether an unexcused advisory blocks; the ENTRY decides
 * whether a date is binding. A moderate advisory with no entry still sails
 * through. A moderate advisory whose entry expired does not.
 *
 * Cross-platform: no deps, runs on ubuntu-latest and windows-2022. Windows
 * needs `shell: true` to spawn `npm.cmd` at all (see `runNpmAudit`) — this
 * file used to claim "no shell, runs identically", which was never true: it
 * threw `spawnSync npm.cmd EINVAL` on Windows and nobody could tell, because
 * the entry guard (register C01) meant the script never ran on CI in the
 * first place. `npm audit` exits non-zero whenever it finds anything at all,
 * so its exit code is ignored on purpose — stdout is the signal.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BLOCKING = new Set(['high', 'critical']);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORE_FILE = join(REPO_ROOT, 'osv-scanner.toml');

/**
 * Extract `[[IgnoredVulns]]` entries from osv-scanner.toml.
 *
 * A narrow reader rather than a real TOML parser: the file is written and
 * reviewed by us, holds exactly one table array, and pulling in a TOML dep
 * for it would itself have to clear `.npmrc`'s min-release-age cooldown.
 * The trade is that anything outside the shape below is invisible — so the
 * reader THROWS on a block missing either field rather than skipping it,
 * which turns a typo into a red CI run instead of a silently-dropped
 * excuse. `reason` is required by convention but not parsed; osv-scanner
 * is the authority on this file's schema.
 */
export function parseIgnoreFile(toml) {
  const blocks = toml.split(/^\s*\[\[IgnoredVulns\]\]\s*$/m).slice(1);
  return blocks.map((block, i) => {
    // Stop at the next table header so a trailing `[[Other]]` section
    // can't leak its keys into the last entry.
    const body = block.split(/^\s*\[/m)[0];
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const until = /^\s*ignoreUntil\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (!id) throw new Error(`osv-scanner.toml: [[IgnoredVulns]] #${i + 1} has no \`id\``);
    if (!until) throw new Error(`osv-scanner.toml: ignore for ${id} has no \`ignoreUntil\``);
    const expiry = new Date(until);
    if (Number.isNaN(expiry.getTime())) {
      throw new Error(
        `osv-scanner.toml: ignore for ${id} has an unparseable ignoreUntil "${until}"`,
      );
    }
    return { id, until, expiry };
  });
}

/**
 * Flatten `npm audit --json` into one row per (advisory, package).
 *
 * The `vulnerabilities` map is keyed by package and its `via` array mixes
 * advisory objects with plain strings — a string means "vulnerable only
 * because a dependency is", which is already represented by the row for
 * that dependency, so only the objects carry an advisory to judge.
 */
export function collectAdvisories(auditJson) {
  const out = [];
  for (const [pkg, entry] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const id =
        /\/advisories\/(GHSA-[\w-]+)/.exec(via.url ?? '')?.[1] ?? via.url ?? String(via.source);
      out.push({
        id,
        pkg,
        severity: via.severity ?? entry.severity,
        title: via.title ?? '',
        range: via.range ?? entry.range ?? '',
      });
    }
  }
  return out;
}

/**
 * Decide the run. Pure — `now` is injected so the expiry branch is testable
 * without touching the clock.
 */
export function evaluate(advisories, ignores, now) {
  const byId = new Map(ignores.map((ig) => [ig.id, ig]));
  const blocked = [];
  const excused = [];
  const expired = [];

  for (const adv of advisories) {
    const ig = byId.get(adv.id);

    // No entry: the severity policy decides, unchanged. Moderate and low are
    // reported by `npm audit` but do not block here.
    if (!ig) {
      if (BLOCKING.has(adv.severity)) blocked.push(adv);
      continue;
    }

    // An entry EXISTS, so its date is consulted regardless of severity.
    //
    // Register C17: the severity filter used to sit above this whole block, so
    // a lapsed `ignoreUntil` on a moderate or low advisory was never even
    // looked at — while this file's own header promises "the date is a real
    // deadline, not decoration". Four of the seven entries in
    // `osv-scanner.toml` are moderate or low today, so most of the allowlist's
    // expiry dates meant nothing.
    //
    // The reasoning was already here, eleven lines down, for `unused`: an
    // entry covering a moderate advisory is doing real work because OSV blocks
    // on it even though this gate doesn't. An entry doing real work has a real
    // deadline. Expiry now follows the entry, and blocking still follows the
    // severity — they are separate questions and were conflated.
    if (now >= ig.expiry) expired.push({ ...adv, until: ig.until });
    else excused.push({ ...adv, until: ig.until });
  }

  // "Unused" is keyed on the advisory appearing AT ALL, not on it having
  // reached this gate. An entry covering a moderate advisory is doing real
  // work — OSV blocks on it even though this gate doesn't — so judging
  // usage by the blocking set would nag reviewers to retire entries that
  // are load-bearing for the other gate.
  const present = new Set(advisories.map((adv) => adv.id));
  const unused = ignores.filter((ig) => !present.has(ig.id));

  return { blocked, excused, expired, unused, ok: blocked.length === 0 && expired.length === 0 };
}

function runNpmAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let stdout;
  try {
    stdout = execFileSync(npm, ['audit', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Windows: `npm` is `npm.cmd`, and since the CVE-2024-27980 fix
      // (Node >=18.20.2 / 20.12.2 / 21.7.3, and all 22/24) Node REFUSES to
      // spawn a .cmd/.bat without `shell: true`, throwing a synchronous
      // `spawnSync npm.cmd EINVAL`. scripts/bootstrap.mjs has carried this
      // workaround for a while; this file never got it because — per
      // register C01 — the gate had never actually executed on CI, so the
      // Windows path had no way to fail loudly. Arming the entry guard in
      // this same PR is what surfaced it: windows-2022 went red on the very
      // first run with exactly that EINVAL.
      //
      // The POSIX path keeps its exact no-shell behaviour. Args here are two
      // fixed literals with no spaces or shell metacharacters, so the shell
      // adds no injection surface.
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // Non-zero exit is the NORMAL path — `npm audit` returns 1 whenever it
    // finds anything. The report is still on stdout; only a genuinely empty
    // stdout means the command itself failed.
    stdout = err.stdout;
    if (!stdout) {
      throw new Error(`npm audit produced no output: ${err.stderr || err.message}`, { cause: err });
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('npm audit did not return JSON (is the lockfile present?)');
  }
}

function main() {
  const ignores = parseIgnoreFile(readFileSync(IGNORE_FILE, 'utf8'));
  const advisories = collectAdvisories(runNpmAudit());
  const result = evaluate(advisories, ignores, new Date());

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  }

  for (const ig of result.unused) {
    console.log(`note: ignore ${ig.id} matched no advisory — retire it from osv-scanner.toml`);
  }
  for (const adv of result.excused) {
    console.log(`excused: ${adv.id} (${adv.pkg}, ${adv.severity}) until ${adv.until}`);
  }
  for (const adv of result.expired) {
    console.error(
      `EXPIRED: ${adv.id} (${adv.pkg}, ${adv.severity}) — ignoreUntil ${adv.until} has passed. ` +
        `Fix it, or re-date the entry with a reason.`,
    );
  }
  for (const adv of result.blocked) {
    console.error(`BLOCKED: ${adv.id} (${adv.pkg}, ${adv.severity}) ${adv.title}`);
  }

  if (!result.ok) {
    console.error(
      `\nAudit gate failed: ${result.blocked.length} unexcused, ${result.expired.length} expired.\n` +
        `To excuse one, add an [[IgnoredVulns]] entry to osv-scanner.toml with an\n` +
        `id, a dated ignoreUntil, and a reason. Both this gate and OSV scan read it.`,
    );
    process.exit(1);
  }
  console.log(
    `Audit gate passed: no unexcused high/critical advisories ` +
      `(${result.excused.length} excused, ${advisories.length} total reported).`,
  );
}

/**
 * Register C01: is this module the process entry point, or was it imported?
 *
 * This used to be `import.meta.main`, which landed in Node 22.18 and is
 * `undefined` on older runtimes. ci.yml pins Node 20 — so on CI the guard was
 * always falsy, `main()` never ran, and the `Audit dependencies` step printed
 * nothing and exited 0. The gate had never once run in the environment it was
 * written for; it only ever worked on a maintainer's newer local Node.
 *
 * `pathToFileURL` rather than a string compare so a Windows `C:\…` argv and
 * `import.meta.url`'s `file:///C:/…` form still match.
 *
 * The guard still has to hold when imported: audit-gate.test.mjs imports this
 * module, and under vitest `process.argv[1]` is vitest's own entry, so the
 * comparison fails and `main()` stays inert — which is the whole point of
 * having a guard rather than a bare call.
 */
export function isDirectInvocation(moduleUrl, argv1) {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

if (isDirectInvocation(import.meta.url, process.argv[1])) main();
