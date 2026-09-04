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
 * wrong direction: no bus tool call is gated on a human, so auto-approve is
 * bypass in effect and a poisoned dev dependency is squarely in the threat
 * model — see .npmrc, which carries the full wording). So the only
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
 *     most of the allowlist. And until 2026-09-04 it was false for every
 *     entry `npm audit` did not report this run — including, by
 *     construction, every OSV-only hold. See `evaluate`.
 *   - an ignore entry missing `id` or `ignoreUntil`      → exit 1
 *   - any high/critical advisory not on the list         → exit 1
 *
 * Deliberately NOT fail-closed on one thing: an ignore entry that matched
 * nothing this run is reported as a warning, not an error.
 *
 * The reason used to be "OSV-Scanner already hard-fails on unused ignores, so
 * two gates enforcing it just doubles the blast radius of a routine Dependabot
 * bump". Measured 2026-08-08: it does not. osv-scanner 2.4.0 prints
 * `osv-scanner.toml has unused ignores:` and then exits 0, upstream documents
 * no such failure mode, and the CI runs cited as proof were failing on real
 * unfiltered vulnerabilities in the same log. See osv-scanner.toml's header
 * for the full measurement.
 *
 * Re-run 2026-09-04 on 2.4.0 and it still holds — same message, same exit 0.
 * But CI pins `osv-scanner-action` at v2.5.1 (`.github/workflows/osv-scanner.yml`),
 * and the claim is UNMEASURED there. One command settles it on a machine with
 * 2.5.1 installed: append an `[[IgnoredVulns]]` entry with an id matching
 * nothing to a copy of the config, then
 * `osv-scanner scan source --lockfile=package-lock.json --config=<copy>; echo $?`.
 *
 * The warning stays a warning anyway, for a reason that survives scrutiny: the
 * two gates read DIFFERENT advisory databases. `npm audit` sees the npm
 * registry; OSV-Scanner sees OSV, the GitHub Advisory Database, Snyk and more
 * (GHSA-frvp-7c67-39w9 was an OSV-only finding here). So an entry can be
 * unused as far as THIS gate can tell while still filtering a real OSV finding
 * — and hard-failing would demand deleting exactly the entries doing the work.
 * A gate may only block on what it can see.
 *
 * What compensates: the pass-path summary counts stale entries and names the
 * nearest expiry, so an allowlist drifting out of date is visible on a green
 * run instead of only on the day it goes red.
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
 * reader THROWS on a block missing any of the three fields rather than
 * skipping it, which turns a typo into a red CI run instead of a
 * silently-dropped excuse. osv-scanner is the authority on this file's schema.
 *
 * `reason` used to be "required by convention but not parsed". The whole
 * review model for this file rests on every excuse carrying a written
 * justification — an entry without one is an unexplained hole in two required
 * security checks — so it is now read and required like the other two, and
 * `scripts/osvAllowlist.test.mjs` checks what a reason must contain.
 *
 * Known limit of `[^"]*`: a reason containing an escaped `\"` truncates at
 * the backslash rather than throwing. No entry has ever needed one (they use
 * typographic quotes), and the failure is a short reason rather than a
 * dropped entry, so the narrow reader stays narrow.
 */
export function parseIgnoreFile(toml) {
  const blocks = toml.split(/^\s*\[\[IgnoredVulns\]\]\s*$/m).slice(1);
  return blocks.map((block, i) => {
    // Stop at the next table header so a trailing `[[Other]]` section
    // can't leak its keys into the last entry.
    const body = block.split(/^\s*\[/m)[0];
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const until = /^\s*ignoreUntil\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const reason = /^\s*reason\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (!id) throw new Error(`osv-scanner.toml: [[IgnoredVulns]] #${i + 1} has no \`id\``);
    if (!until) throw new Error(`osv-scanner.toml: ignore for ${id} has no \`ignoreUntil\``);
    const expiry = new Date(until);
    if (Number.isNaN(expiry.getTime())) {
      throw new Error(
        `osv-scanner.toml: ignore for ${id} has an unparseable ignoreUntil "${until}"`,
      );
    }
    // Checked last so the existing error precedence is unchanged: a block
    // missing several fields still names the most structural one first.
    if (!reason) throw new Error(`osv-scanner.toml: ignore for ${id} has no \`reason\``);
    return { id, until, expiry, reason };
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
    // deadline, not decoration". When C17 was written, four of the seven live
    // entries were moderate or low, so most of the allowlist's expiry dates
    // meant nothing. The allowlist is EMPTY today, which is its intended
    // resting state — the count is history, and the branch below is what makes
    // the next moderate hold's date binding rather than decorative.
    //
    // The reasoning was already here, eleven lines down, for `unused`: an
    // entry covering a moderate advisory is doing real work because OSV blocks
    // on it even though this gate doesn't. An entry doing real work has a real
    // deadline. Expiry now follows the entry, and blocking still follows the
    // severity — they are separate questions and were conflated.
    if (now >= ig.expiry) expired.push({ ...adv, until: ig.until, matched: true });
    else excused.push({ ...adv, until: ig.until });
  }

  // "Unused" is keyed on the advisory appearing AT ALL, not on it having
  // reached this gate. An entry covering a moderate advisory is doing real
  // work — OSV blocks on it even though this gate doesn't — so judging
  // usage by the blocking set would nag reviewers to retire entries that
  // are load-bearing for the other gate.
  const present = new Set(advisories.map((adv) => adv.id));
  const unmatched = ignores.filter((ig) => !present.has(ig.id));

  // AN UNMATCHED ENTRY STILL HAS A DEADLINE. The loop above can only expire an
  // entry whose advisory `npm audit` reported THIS run, so until now a lapsed
  // date on an entry npm cannot see was never checked at all — it landed in
  // the warning list beside the entries that are merely stale. That is the
  // case the header's "the date is a real deadline, not decoration" was most
  // wrong about, and it is not a rare corner: this file's own header records
  // that the two gates read different databases, and that GHSA-frvp-7c67-39w9
  // was an OSV-only finding here. An OSV-only hold is invisible to npm audit
  // by construction, so its date could never lapse.
  //
  // This does NOT break "a gate may only block on what it can see". The date
  // is not the advisory: it is a commitment the operator wrote down, in this
  // file's own format, fully visible from here. A lapsed one means either
  // retire the entry or re-date it with a fresh reason — both actions someone
  // has to take, and neither requires knowing what the advisory says.
  const lapsed = unmatched.filter((ig) => now >= ig.expiry);
  const unused = unmatched.filter((ig) => now < ig.expiry);
  for (const ig of lapsed) {
    expired.push({ id: ig.id, pkg: null, severity: null, until: ig.until, matched: false });
  }

  return { blocked, excused, expired, unused, ok: blocked.length === 0 && expired.length === 0 };
}

/**
 * The soonest `ignoreUntil` still ahead of `now`, or null when none is.
 *
 * Register C17 made these dates binding at every severity. This makes them
 * VISIBLE before they bite: without it, the first anyone hears of a lapsed
 * allowlist is a red required check on an unrelated PR, because the entry sat
 * in a passing log for weeks saying nothing about how long it had left.
 *
 * Entries already past their date are excluded — they are the `expired` list's
 * business, and "next deadline" that points backwards is not a deadline. Pure,
 * with `now` injected, for the same reason `evaluate` is.
 */
export function nearestExpiry(ignores, now) {
  const ahead = ignores.filter((ig) => ig.expiry > now);
  if (ahead.length === 0) return null;
  const soonest = ahead.reduce((a, b) => (a.expiry <= b.expiry ? a : b));
  const days = Math.ceil((soonest.expiry.getTime() - now.getTime()) / 86_400_000);
  return { id: soonest.id, until: soonest.until, days };
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
  const now = new Date();
  const ignores = parseIgnoreFile(readFileSync(IGNORE_FILE, 'utf8'));
  const advisories = collectAdvisories(runNpmAudit());
  const result = evaluate(advisories, ignores, now);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  }

  for (const ig of result.unused) {
    console.log(
      `note: ignore ${ig.id} matched no npm advisory — retire it from osv-scanner.toml ` +
        `unless it still filters an OSV-only finding`,
    );
  }
  for (const adv of result.excused) {
    console.log(`excused: ${adv.id} (${adv.pkg}, ${adv.severity}) until ${adv.until}`);
  }
  for (const adv of result.expired) {
    // An unmatched entry has no package or severity to name — npm audit never
    // reported the advisory. Saying `(null, null)` would read as a bug in the
    // gate rather than as the thing it is.
    const what = adv.matched
      ? `${adv.id} (${adv.pkg}, ${adv.severity})`
      : `${adv.id} (no npm advisory this run — an OSV-only hold, or already fixed)`;
    console.error(
      `EXPIRED: ${what} — ignoreUntil ${adv.until} has passed. ` +
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
      `(${result.excused.length} excused, ${advisories.length} total reported, ` +
      `${result.unused.length} stale).`,
  );
  const next = nearestExpiry(ignores, now);
  if (next) {
    console.log(
      `Next hold expires ${next.until} — ` +
        `${next.days === 1 ? '1 day' : `${next.days} days`} away (${next.id}).`,
    );
  }
}

/**
 * Register C01: is this module the process entry point, or was it imported?
 *
 * This used to be `import.meta.main`, which landed in Node 22.18 and is
 * `undefined` on older runtimes. CI ran Node 20 at the time — so the guard was
 * always falsy there, `main()` never ran, and the `Audit dependencies` step
 * printed nothing and exited 0. The gate had never once run in the environment
 * it was written for; it only ever worked on a maintainer's newer local Node.
 *
 * THAT PREMISE HAS EXPIRED and the guard stays anyway. CI moved to Node 24 in
 * `Cebab-mfvu`, and `package.json` now declares `engines.node >= 24` with
 * `.npmrc engine-strict=true` refusing an older install outright, so
 * `import.meta.main` would work today. The reason to keep this form is the
 * paragraph below, which was always the stronger one: the guard must also hold
 * when the module is IMPORTED. Written down because a reader who checks only
 * the first reason will find it dead and delete a guard that a test depends
 * on.
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
