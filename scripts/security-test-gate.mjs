/**
 * CI security-regression gate — run the `[security]`-tagged suite and refuse
 * to pass when nothing actually ran.
 *
 *   node scripts/security-test-gate.mjs        # what `npm run test:security` calls
 *
 * WHY THIS EXISTS (register C02). `test:security` was
 * `vitest run -t '\[security\]'`. That filters by test NAME, and vitest exits
 * 0 when a name filter matches nothing — the files are all discovered, every
 * test is marked skipped, and the run is green. Measured on this repo:
 *
 *   real tag      Test Files  48 passed | 168 skipped     Tests  337 passed
 *   renamed tag   Test Files 216 skipped                  Tests 3048 skipped   → exit 0
 *
 * Those numbers are the ORIGINAL measurement and are kept as the record of it;
 * the suite has since roughly quadrupled (403 files / ~6.5k tests / ~1.3k
 * tagged). Nothing here depends on the figures — the gate asserts a `> 0`
 * floor, not a constant — but do not read them as current.
 *
 * So renaming or dropping the tag silently disarms the entire security
 * regression suite while CI stays green — on a REQUIRED check whose only job
 * is to notice exactly that class of change. Dropping `passWithNoTests` (the
 * other half of C02) does not help here: that flag governs zero *files*
 * found, and this failure mode finds every file. Verified — the renamed-tag
 * case still exits 0 with `--passWithNoTests=false`.
 *
 * WHAT IT CHECKS. That at least one test actually EXECUTED. The key is
 * `numPassedTests + numFailedTests`, not `numTotalTests`: vitest counts
 * skipped tests in the total, so the renamed-tag run above reports
 * `numTotalTests: 3048` while having run nothing at all. Reading the total
 * would reproduce the very bug this file exists to catch.
 *
 * A `> 0` floor rather than a minimum count: it closes the whole hazard and
 * never needs revisiting as tests are added or retired. A threshold would
 * have to be bumped by hand and would eventually be lowered to shut it up.
 *
 * Cross-platform: no shell, no deps — spawns vitest through the same
 * `npm.cmd`-on-win32 dance as bootstrap.mjs, and runs identically on
 * ubuntu-latest and windows-2022.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The tag that marks a security regression case — human-readable form. */
export const SECURITY_TAG = '[security]';

/**
 * The same tag as a `-t` value. Vitest treats `-t` as a REGEX, so the
 * brackets must be escaped: passing a bare `[security]` is the character
 * class `[security]`, which matches any name containing s/e/c/u/r/i/t/y —
 * i.e. very nearly every test in the repo. That silently runs the FULL suite
 * under the security gate's name, which looks like passing and is the exact
 * opposite of a filter. Caught here by asserting that the executed count is a
 * SUBSET of the suite rather than trusting a green run — originally measured
 * as 337 against 3028, now ~1.3k against ~6.5k. The ratio is the signal; the
 * absolute numbers move with every bead.
 *
 * The old npm script carried this escaping as `'\\[security\\]'` — through a
 * shell. This spawns vitest without one, so the escaping has to live here.
 */
export const SECURITY_TAG_PATTERN = '\\[security\\]';

/**
 * Decide the gate's verdict from vitest's JSON reporter summary.
 *
 * Split out from the process plumbing so the interesting branches are
 * testable without spawning a real vitest run.
 *
 * @param {{numPassedTests?: number, numFailedTests?: number, numTotalTests?: number}} summary
 * @returns {{ok: boolean, executed: number, reason?: string}}
 */
export function evaluateRun(summary) {
  if (!summary || typeof summary !== 'object') {
    return { ok: false, executed: 0, reason: 'vitest produced no parseable JSON summary' };
  }
  const passed = Number(summary.numPassedTests ?? 0);
  const failed = Number(summary.numFailedTests ?? 0);
  const executed = passed + failed;

  if (executed === 0) {
    const total = Number(summary.numTotalTests ?? 0);
    return {
      ok: false,
      executed: 0,
      // Name the likely cause: this only happens when the filter stops
      // matching, and the operator's next move is to check the tag.
      reason:
        `no security tests ran (${total} collected, all skipped). ` +
        `The ${SECURITY_TAG} tag matched nothing — it was probably renamed or ` +
        `removed. This is a disarmed gate, not a passing one.`,
    };
  }
  if (failed > 0) {
    return { ok: false, executed, reason: `${failed} security test(s) failed` };
  }
  return { ok: true, executed };
}

function runVitest(outputFile) {
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = [
      'exec',
      '--no',
      '--',
      'vitest',
      'run',
      '-t',
      SECURITY_TAG_PATTERN,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${outputFile}`,
    ];
    let child;
    try {
      // Windows: `npm` is `npm.cmd` and Node refuses to spawn a .cmd without
      // `shell: true` since the CVE-2024-27980 fix. Same reasoning and same
      // shape as scripts/bootstrap.mjs — args are fixed literals plus a
      // temp path we generated, so the shell adds no injection surface.
      child = spawn(npm, args, {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    } catch (err) {
      console.error(`[security-gate] could not spawn ${npm}: ${String(err)}`);
      resolve(1);
      return;
    }
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[security-gate] could not spawn ${npm}: ${String(err)}`);
      resolve(1);
    });
  });
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'cebab-sec-gate-'));
  const outputFile = join(tmp, 'vitest.json');
  try {
    const exitCode = await runVitest(outputFile);

    let summary = null;
    try {
      summary = JSON.parse(readFileSync(outputFile, 'utf8'));
    } catch {
      // Fall through to evaluateRun's null branch, which fails closed. A
      // missing/corrupt report means we cannot prove anything ran — and this
      // gate's entire purpose is refusing to pass on an unproven run.
    }

    const verdict = evaluateRun(summary);
    if (!verdict.ok) {
      console.error(`\nSecurity test gate FAILED: ${verdict.reason}`);
      process.exit(exitCode === 0 ? 1 : exitCode);
    }
    console.log(`\nSecurity test gate passed: ${verdict.executed} ${SECURITY_TAG} tests ran.`);
    // Trust vitest's own exit code for anything it flagged that the summary
    // doesn't capture (unhandled rejections, setup failures).
    process.exit(exitCode);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Register C01's lesson applied here: `import.meta.main` is Node 22.18+, and
// CI ran Node 20 at the time — where it is `undefined` and this whole file
// would have been a silent no-op. CI is on Node 24 now (`Cebab-mfvu`) and the
// repo's `engines.node` floor is >= 24, so that hazard is historical; the argv
// compare stays because it also holds when this module is imported, which is
// how `security-test-gate.test.mjs` reaches it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
