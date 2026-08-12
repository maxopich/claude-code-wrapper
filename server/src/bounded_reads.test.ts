/**
 * [security] Cebab-x1n.6.21 — no sixth hand-rolled bounded reader.
 *
 * `safe_fs.ts` exists because reading a path a PROJECT supplies has three
 * hazards at once (a FIFO parks the event loop, a huge file exhausts memory, a
 * stat-then-read re-resolves the name). When that module landed it took over
 * two call sites and left four alone, with a header certifying that those four
 * "work". Three of them did not: `bus/runtime.ts` (twice) read whole files and
 * capped the resulting string, and `repo/hook_trust.ts` had neither the
 * non-blocking open nor a cap.
 *
 * The lesson is not "five copies were untidy". It is that a security-critical
 * shape was vouched for by prose, and prose does not get re-checked. So this
 * file re-checks it on every run: every raw filesystem read under `server/src`
 * must either live in `safe_fs.ts` or be listed below with the Cebab-OWNED
 * path it reads.
 *
 * Two things keep the gate honest, both learned from gates that passed while
 * measuring nothing:
 *
 *   - comment lines are stripped BEFORE the scan, so the paragraph you are
 *     reading cannot count itself as a violation;
 *   - a stale allowlist entry FAILS. An entry that no longer matches any site
 *     is an exemption nobody is using, and leaving it there is how a list
 *     stops describing the code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC = path.join(import.meta.dirname, '.');

/** The raw reads this gate is about. Each takes a path and hands back bytes. */
const READ_CALLS = [
  'fs.openSync(',
  'fs.readFileSync(',
  'fs.readFile(',
  'fs.createReadStream(',
  'fs.promises.readFile(',
];

/** The one place the shape is allowed to be written out. */
const SHARED_READER = 'safe_fs.ts';

/**
 * Reads of paths CEBAB owns — its own database, its own logs, its own
 * migrations, its own fixtures. These are not the threat `safe_fs` addresses:
 * an attacker who can plant a FIFO in `~/.cebab` already owns the install.
 *
 * Keys are repo-relative POSIX paths. Every entry must still match a real
 * call site (see the stale-entry test below), so this list cannot quietly
 * outlive the code it excuses.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['db.ts', 'migration SQL shipped inside the repo'],
  ['data_perms.ts', "touches Cebab's own SQLite path to create it with a mode; reads nothing"],
  ['session_log_export.ts', "streams Cebab's own ~/.cebab/logs/<sid>.jsonl to the operator"],
  ['notifications/audit_tip.ts', "Cebab's own audit-tip mirror under ~/.cebab"],
  ['runner/mock.ts', 'mock-mode fixtures shipped inside the repo'],
  ['live_smoke.ts', "dev smoke script reading Cebab's own auth-token file"],
  ['ws_smoke.ts', "dev smoke script reading Cebab's own auth-token file"],
]);

/**
 * Blank out comments while preserving line numbering.
 *
 * This is the step two previous source-derived gates in this repo skipped, and
 * both then counted their own explanatory comments as matches. `://` is
 * excluded so a URL in a string is not mistaken for a line comment.
 */
function stripComments(source: string): string[] {
  let inBlock = false;
  return source.split('\n').map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return '';
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lc = line.search(/(^|[^:])\/\//);
    if (lc !== -1) line = line.slice(0, line.indexOf('//', lc));
    return line;
  });
}

type Site = { file: string; line: number; call: string };

function listSourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'test_support' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(path.join(dir, entry.name), childRel));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(childRel);
  }
  return out;
}

function findReadSites(): Site[] {
  const sites: Site[] = [];
  for (const file of listSourceFiles(SERVER_SRC)) {
    const lines = stripComments(fs.readFileSync(path.join(SERVER_SRC, file), 'utf8'));
    lines.forEach((line, i) => {
      for (const call of READ_CALLS) {
        if (line.includes(call)) sites.push({ file, line: i + 1, call });
      }
    });
  }
  return sites;
}

describe('[security] every raw filesystem read is accounted for', () => {
  test('the scanner actually finds call sites', () => {
    // Anti-vacuity. A scan that matches nothing reports a clean codebase, and
    // this gate's whole value is that it keeps matching after someone renames
    // a helper or reformats a call across lines.
    const sites = findReadSites();
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.some((s) => s.file === SHARED_READER)).toBe(true);
  });

  test('no read outside safe_fs.ts is unaccounted for', () => {
    const offenders = findReadSites()
      .filter((s) => s.file !== SHARED_READER)
      .filter((s) => !ALLOWED.has(s.file));

    // The message is the point: a future author sees exactly which line and
    // what the two ways forward are.
    expect(
      offenders.map((s) => `${s.file}:${s.line} — ${s.call}`),
      'A raw filesystem read appeared outside safe_fs.ts. Route it through ' +
        'readFileBounded / readFilePrefixBounded, or — if it reads a path CEBAB ' +
        'owns — add it to ALLOWED in this file with the path it reads.',
    ).toEqual([]);
  });

  test('no allowlist entry has gone stale', () => {
    // An exemption for a call site that no longer exists is an exemption
    // nobody re-reads. Failing on it is what forces the list to keep
    // describing the code rather than the code's history.
    const filesWithReads = new Set(findReadSites().map((s) => s.file));
    const stale = [...ALLOWED.keys()].filter((f) => !filesWithReads.has(f));
    expect(stale).toEqual([]);
  });

  test('the readers that a project can aim are NOT allowlisted', () => {
    // The three that were wrong, named explicitly. If one of them reappears in
    // ALLOWED, this gate would go green while the hole reopened — so pin the
    // exclusion rather than trusting the list to stay short.
    for (const projectFacing of [
      'bus/runtime.ts',
      'repo/hook_trust.ts',
      'repo/artifact_content.ts',
      'repo/mcp_trust.ts',
      'repo/project_authority.ts',
    ]) {
      expect(ALLOWED.has(projectFacing)).toBe(false);
    }
  });
});
