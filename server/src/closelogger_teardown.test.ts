import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './test_support/strip_comments.js';

/**
 * Cebab-yp07: a hand-rolled temp-data-dir teardown must await `closeLogger()`
 * before it removes its temp root.
 *
 * WHAT THIS GUARDS, and why it is the CLASS not the instance. A DB-touching test
 * points `config.dataDir` at a throwaway `mkdtempSync` root and `fs.rmSync`s it
 * on the way out. If the test's subject reached the transcript logger, that
 * logger holds a module-level write stream whose fd opens on a LATER tick
 * (`runner/logger.ts`, Cebab-kji): remove the directory first and the open
 * races, the stream's `'error'` handler logs AFTER the test has finished, and
 * vitest reports it as `EnvironmentTeardownError: Closing rpc while
 * "onUserConsoleLog" was pending` — which fails the WHOLE run with every test
 * green and NAMES a file that did nothing wrong. `withTempDataDir` in
 * `test_support/` already awaits `closeLogger()` for exactly this reason, but it
 * only helps a file that CALLS it; ~114 files hand-roll the preamble instead.
 * The fix is one awaited line per teardown; this gate is what stops the 115th
 * hand-rolled preamble from shipping without it.
 *
 * NECESSARY, NOT SUFFICIENT (`Cebab-ndd7`). PR #626 measured zero logger
 * write lines with and without the ordering on the file that failed CI and
 * concluded the race could not be reproduced on demand. It can: any test that
 * drives a turn (`runOneTurn` closes its session's stream fire-and-forget) left
 * a late `[logger] … ENOENT` on EVERY turn, with a teardown this gate accepts,
 * until the all-sessions `closeLogger()` also awaited closes already in flight.
 * `runner/logger.test.ts` now pins that half with a real stream. The gate itself
 * IS behaviourally revert-checkable — delete the `await closeLogger()` from any
 * migrated file and the real-tree scan below reddens naming that `file:line`.
 *
 * HOW IT READS THE TREE, each choice the opposite of the obvious one:
 *
 *  - It scans TEST files, inverting every other server source-gate's filter.
 *    `bounded_reads.test.ts`, `system_prompt_writers.test.ts` and
 *    `safety_emit_result.test.ts` all skip `.test.ts`; copying one of those
 *    walkers would scan zero files and pass vacuously. The precedent for a gate
 *    that safely scans test files (and itself) is `mcp_status_single_definition`
 *    and `return_shape_result_suffix`.
 *
 *  - It EXCLUDES ITS OWN FILE by name (see `GATE_BASENAME`). This file is a
 *    `.test.ts` in the directory it walks and its fixtures assemble a textbook
 *    offending preamble; without the exclusion it would flag itself. The
 *    exclusion is deliberate, not incidental — `readTestSources omits its own
 *    file` and `scan has no self-knowledge` below pin that it is by filename.
 *
 *  - Comments are stripped FIRST. A `.test.ts` may name `withTempDataDir` only
 *    in prose (the very file this bead was filed over, `ws/ask_user_question`,
 *    does at :146) — raw text would exempt it. And a doc comment reproducing the
 *    preamble must not read as a violation. One fixture case each way.
 *
 *  - The teardown "block" is the brace-matched immediate enclosure of the
 *    `fs.rmSync`, found by counting braces, NOT an N-line window — so the shape
 *    is caught in an `afterEach`, an `afterAll` and a test-body `try/finally`
 *    alike, and the reported line is the `rmSync` a reader would open the file
 *    to.
 *
 *  - Only a RECURSIVE removal counts. A temp-root teardown is always
 *    `fs.rmSync(root, { recursive: true, … })`; an in-test `fs.rmSync` of a
 *    single file (a `.gitignore` negative control in `data_perms.security`) is
 *    not a teardown and must not be demanded to await the logger.
 */

const SERVER_SRC = fileURLToPath(new URL('./', import.meta.url));
const GATE_BASENAME = path.basename(fileURLToPath(import.meta.url));

type Violation = { file: string; line: number };
type ScanResult = { violations: Violation[]; qualifying: number };

const ASSIGN_RE = /config\.dataDir\s*=[^=]/;
const AWAITED_CLOSE_RE = /await\s+closeLogger\(/;

/** Index of the `{` that immediately encloses `pos`, or -1. */
function immediateBlockOpen(s: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = s[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Index of the `}` matching the `{` at `open`, or the string end. */
function blockClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

/**
 * The scan takes a CONTENT MAP rather than reading files itself, so the fixture
 * cases below can feed it text directly — the seam that lets both directions of
 * the comment rule, and all three orderings, be asserted without trusting the
 * tree. It performs NO self-exclusion: that lives only in the walker, by
 * filename, which is what `scan has no self-knowledge` proves.
 */
function scan(sources: Record<string, string>): ScanResult {
  const violations: Violation[] = [];
  let qualifying = 0;
  for (const [file, source] of Object.entries(sources)) {
    // Split on \r?\n first: without a .gitattributes these check out CRLF on
    // Windows CI, where an embedded \r would break the brace/line arithmetic.
    const stripped = stripComments(source.split(/\r?\n/).join('\n'));
    // A file that CALLS the helper is compliant by construction. Checked on
    // stripped text so a mere prose mention does not exempt it.
    if (/withTempDataDir\(/.test(stripped)) continue;

    const re = /fs\.rmSync\(/g;
    const handled = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const pos = m.index;
      // Only a recursive removal is a temp-root teardown.
      const callHead = stripped.slice(pos, pos + 200).split(');')[0];
      if (!callHead.includes('recursive')) continue;

      const open = immediateBlockOpen(stripped, pos);
      if (open === -1) continue;
      const close = blockClose(stripped, open);
      const block = stripped.slice(open, close);
      if (!ASSIGN_RE.test(block)) continue;
      if (handled.has(open)) continue;
      handled.add(open);

      qualifying++;
      const before = stripped.slice(open, pos);
      if (!AWAITED_CLOSE_RE.test(before)) {
        const line = (stripped.slice(0, pos).match(/\n/g) ?? []).length + 1;
        violations.push({ file, line });
      }
    }
  }
  return { violations, qualifying };
}

function listTestFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTestFiles(path.join(dir, entry.name), childRel));
      continue;
    }
    if (!entry.name.endsWith('.test.ts')) continue;
    if (entry.name === GATE_BASENAME) continue; // self-exclusion, by filename
    out.push(childRel);
  }
  return out;
}

function readTestSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of listTestFiles(SERVER_SRC)) {
    out[file] = fs.readFileSync(path.join(SERVER_SRC, file), 'utf8');
  }
  return out;
}

// Fixtures are assembled from fragments so no literal offending preamble exists
// in this file's own source, and so the assertions read as data rather than as
// something a future refactor silently changes.
const RM = `fs.${'rmSync'}(tmpRoot, { recursive: true, force: true });`;
const ASSIGN = `config.${'dataDir'} = originalDataDir;`;
const CLOSE = `await ${'closeLogger'}();`;

describe('the teardown gate reads code, not the prose about it', () => {
  test('a hand-rolled teardown with no closeLogger is reported at its rmSync', () => {
    const src = ['afterEach(async () => {', '  closeDb();', `  ${ASSIGN}`, `  ${RM}`, '});'].join(
      '\n',
    );
    expect(scan({ 'x.test.ts': src }).violations).toEqual([{ file: 'x.test.ts', line: 4 }]);
  });

  test('closeLogger AFTER the rmSync is still reported — the defect is ORDER', () => {
    // The case the original acceptance omitted. Presence is not enough; it must
    // precede the removal, or the fd still races the rm.
    const src = ['afterEach(async () => {', `  ${ASSIGN}`, `  ${RM}`, `  ${CLOSE}`, '});'].join(
      '\n',
    );
    expect(scan({ 'x.test.ts': src }).violations).toEqual([{ file: 'x.test.ts', line: 3 }]);
  });

  test('closeLogger BEFORE the rmSync is not reported', () => {
    const src = ['afterEach(async () => {', `  ${ASSIGN}`, `  ${CLOSE}`, `  ${RM}`, '});'].join(
      '\n',
    );
    expect(scan({ 'x.test.ts': src }).violations).toEqual([]);
  });

  test('the shape is caught in an afterAll too, not only afterEach', () => {
    const src = ['afterAll(async () => {', '  closeDb();', `  ${ASSIGN}`, `  ${RM}`, '});'].join(
      '\n',
    );
    expect(scan({ 'x.test.ts': src }).violations).toEqual([{ file: 'x.test.ts', line: 4 }]);
  });

  test('the shape is caught in a test-body try/finally too', () => {
    // config.dataDir is assigned in the try; the rmSync lives in the finally.
    // The brace-matched finally block is the immediate enclosure and carries the
    // restoring assignment, so it qualifies.
    const src = [
      "test('boots', async () => {",
      '  const tmpRoot = mk();',
      '  try {',
      '    config.dataDir = path.join(tmpRoot, ".cebab");',
      '    boot();',
      '  } finally {',
      `    ${ASSIGN}`,
      `    ${RM}`,
      '  }',
      '});',
    ].join('\n');
    expect(scan({ 'x.test.ts': src }).violations).toEqual([{ file: 'x.test.ts', line: 8 }]);
  });

  test('a non-recursive rmSync of a single file is not a teardown', () => {
    // The `data_perms.security` .gitignore negative control: an in-test removal
    // in a block that also assigns config.dataDir, but not of the temp root.
    const src = [
      "test('git', () => {", // eslint wants async only where awaited
      '  config.dataDir = path.join(tmpRoot, "data");',
      '  fs.rmSync(path.join(config.dataDir, ".gitignore"));',
      '});',
    ].join('\n');
    const r = scan({ 'x.test.ts': src });
    expect(r.violations).toEqual([]);
    expect(r.qualifying).toBe(0);
  });

  test('a file that calls withTempDataDir in code is skipped', () => {
    const src = [
      "const dir = withTempDataDir('cebab-x-');",
      'afterEach(async () => {',
      `  ${ASSIGN}`,
      `  ${RM}`,
      '});',
    ].join('\n');
    expect(scan({ 'x.test.ts': src }).violations).toEqual([]);
  });

  test('naming withTempDataDir only in a comment does NOT exempt a file', () => {
    // The exact trap `ws/ask_user_question` sits on: a prose mention of the
    // helper next to a hand-rolled preamble. Stripped first, so it still fails.
    const src = [
      '// withTempDataDir does this for you; here it is by hand.',
      'afterEach(async () => {',
      `  ${ASSIGN}`,
      `  ${RM}`,
      '});',
    ].join('\n');
    expect(scan({ 'x.test.ts': src }).violations).toEqual([{ file: 'x.test.ts', line: 4 }]);
  });

  test('a preamble living entirely inside a block comment is not a violation', () => {
    const src = [
      '/*',
      ' * afterEach(async () => {',
      ` *   ${ASSIGN}`,
      ` *   ${RM}`,
      ' * });',
      ' */',
      'const noop = 1;',
    ].join('\n');
    expect(scan({ 'x.test.ts': src }).violations).toEqual([]);
  });
});

describe('the self-exclusion is deliberate and by filename', () => {
  test('readTestSources omits its own file', () => {
    expect(Object.keys(readTestSources())).not.toContain(GATE_BASENAME);
  });

  test('scan has no self-knowledge — fed its own name, it still reports', () => {
    // Proves the ONLY thing keeping this file out of the real-tree scan is the
    // walker's filename skip. If scan self-excluded instead, removing the
    // walker skip would silently stop protecting this file.
    const src = ['afterEach(async () => {', `  ${ASSIGN}`, `  ${RM}`, '});'].join('\n');
    expect(scan({ [GATE_BASENAME]: src }).violations).toEqual([{ file: GATE_BASENAME, line: 3 }]);
  });
});

describe('every hand-rolled temp-dir teardown in server/src awaits closeLogger', () => {
  const result = scan(readTestSources());

  test('the scan actually found the teardowns (anti-vacuity floor)', () => {
    // If config.dataDir is renamed, the temp root moves, or the walker stops
    // recursing, this collapses toward zero and the emptiness below becomes
    // meaningless. The floor is well under the real count (~116 today) so
    // ordinary churn does not trip it, and far above zero so a broken scan
    // cannot look clean.
    expect(result.qualifying).toBeGreaterThanOrEqual(100);
  });

  test('none of them removes its temp root before awaiting closeLogger', () => {
    expect(
      result.violations.map((v) => `${v.file}:${v.line}`),
      `these teardowns fs.rmSync their temp root without first awaiting closeLogger(). ` +
        `The transcript logger opens its fd on a later tick, so the removal can race the open ` +
        `and fail the whole run green (Cebab-kji). Add "await closeLogger();" immediately before ` +
        `the fs.rmSync, and make the enclosing callback async.`,
    ).toEqual([]);
  });
});
