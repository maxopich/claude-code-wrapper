/**
 * [security] The bus safety model must be described as the one that ships.
 *
 * WHAT WENT WRONG, so the gate's shape makes sense. Three facts about the
 * multi-agent bus changed, and sixteen artifacts kept describing the version
 * before the change:
 *
 *   A. "Bus participants run under `bypassPermissions`." Both routers wire
 *      `onAskUserQuestion`, so every production turn runs
 *      `permissionMode: 'default'` with a live `canUseTool` that allows every
 *      tool except `AskUserQuestion`. The bypass branch is reached only by
 *      callers that skip the hook — i.e. tests. `bus/guardrail.ts` says this
 *      correctly and was the ONLY artifact that did.
 *   B. "The pause fires on the first / any mutation." It fires on the
 *      `dangerous` category only (PR #200, migration 027) and re-arms per
 *      command (migration 031). Ordinary edits and MCP calls run free.
 *   C. "A broken audit chain halts further safety emissions." Not
 *      implemented; `server/src/index.ts` says so at the boot walk.
 *
 * The operator-facing CONSEQUENCE of A never changed — tool calls are
 * auto-approved either way — which is exactly why it survived so long, and
 * why two tests were shipped asserting the false mechanism verbatim.
 *
 * WHY A PROSE GATE AND NOT A BEHAVIOURAL ONE. Nothing about a stale sentence
 * breaks a test. The corrections that landed before this PR were applied one
 * file at a time with no sweep: `.npmrc` (#298) and `CONTRIBUTING.md` (#302)
 * were fixed while `README.md`, `scripts/audit-gate.mjs` and
 * `.github/workflows/workflow-lint.yml` kept the identical sentence — and
 * `audit-gate.mjs` closed its version with "see .npmrc", pointing at a file
 * that by then said the opposite. A gate is the only thing that makes the
 * next copy fail instead of accumulating.
 *
 * TWO HALVES, DELIBERATELY.
 *
 *   1. GROUND TRUTH from the code. If someone removes an ask-gate hook, claim
 *      A becomes true again and this file is where they are told to re-check
 *      the prose — otherwise a real posture change would silently invert every
 *      sentence below into a lie in the other direction.
 *   2. CLAIM SCAN over tracked artifacts, with a FILE ALLOWLIST. A file
 *      outside the allowlist that names `bypassPermissions` fails: the gate
 *      cannot tell an SDK type union from a claim about the bus, so it makes
 *      a human decide once and write down which it is. Same posture as the
 *      `nosemgrep` waivers in `scripts/predev-server.mjs` (#302), for the
 *      same reason.
 *
 * ANTI-VACUITY. A scan of a tree that has already been corrected passes
 * whether or not the checker works — the exact failure of
 * `project_gates_pass_vacuously`. So the checker is fed the VERBATIM
 * pre-correction sentences from this PR as fixtures and must flag every one,
 * and the corrected replacements as fixtures it must not flag. Those run
 * independently of what the tree currently says.
 *
 * Parsing is line-oriented with no YAML/TS parser on purpose, matching
 * `scripts/semgrepRules.test.mjs` and `scripts/osvAllowlist.test.mjs`: those
 * dependencies resolve as unhoisted transitives here and break on a clean
 * `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * This file is excluded from its own claim scans. Its anti-vacuity fixtures
 * are verbatim copies of the sentences it exists to forbid, so scanning itself
 * reports them all — the same reason `.semgrep/cebab-bus.ts` is `--exclude`d
 * from the semgrep scan step while being the input to `semgrep --test`.
 */
const SELF = 'scripts/busSafetyClaims.test.mjs';

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a test that scans files as text
 * should not assume its input: a contributor with a global `core.autocrlf=true`
 * still reads `\r` at every line end, and this repo has lost CI round-trips to
 * that (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ===========================================================================
// 1. Ground truth: what the code actually does.
// ===========================================================================

describe('[security] the bus permission posture the prose must match', () => {
  test('runner.ts sets bypassPermissions in exactly one place: the no-ask-gate arm', () => {
    const src = read('server/src/bus/runner.ts');
    const assignments = src.match(/permissionMode:\s*'bypassPermissions'/g) ?? [];
    expect(assignments).toHaveLength(1);

    // It must be the ELSE arm of the hook ternary. Anchored on the three
    // consecutive lines rather than on line numbers, which drift (register
    // X20 — a comment pointed at ws/server.ts:96 for code that had moved to
    // 1625).
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => /permissionMode:\s*'bypassPermissions'/.test(l));
    expect(idx).toBeGreaterThan(1);
    expect(lines[idx]).toMatch(/^\s*:/); // false branch of a ternary
    expect(lines[idx - 1]).toMatch(/^\s*\?.*permissionMode:\s*'default'/);
    expect(lines[idx - 2]).toMatch(/this\.deps\.onAskUserQuestion/);
  });

  // The premise of every correction in this file. If this goes red, the docs
  // are not what needs fixing — the posture changed, and the prose below has
  // to be re-derived from the new one.
  test('both routers wire the ask-gate hook, so production never takes that arm', () => {
    for (const rel of ['server/src/bus/chain.ts', 'server/src/bus/orchestrator.ts']) {
      expect(read(rel)).toMatch(/^\s*onAskUserQuestion:\s*\w+,\s*$/m);
    }
  });

  test('the pause gate is dangerous-only and re-arms per mutation', () => {
    const gate = read('server/src/bus/pause_gate.ts');
    expect(gate).toMatch(/fires ONLY on `dangerous`/);
    // Migration 031's per-command grant. `consume-approval` existing at all is
    // what makes "every dangerous command needs its own Continue" true.
    expect(gate).toMatch(/'consume-approval'/);
  });

  test('the audit-chain tamper RESPONSE is still unimplemented at boot', () => {
    // Claim C's ground truth. When this stops being true, migration 015's
    // "PLANNED, NOT SHIPPED" note is the thing to delete.
    expect(read('server/src/index.ts')).toMatch(/still unimplemented/);
  });
});

// ===========================================================================
// 2. The claim checkers.
// ===========================================================================

/**
 * Both checkers read a NORMALISED WINDOW, not a single line, and that is not
 * incidental polish — a line-oriented first draft of this file missed the real
 * `orchestrator.ts` claim, because the sentence wrapped:
 *
 *     * mutation tap fires `awaiting_continue` + a banner before the first
 *     * non-`read` tool call from any worker.
 *
 * Neither line contains the phrase. Its own anti-vacuity fixture caught that,
 * which is the whole reason those fixtures are verbatim.
 *
 * `windowAt` joins a span of lines, strips each one's comment prefix (`--`,
 * `//`, `*`, `#`) and collapses whitespace, so a claim reads the same however
 * the author wrapped or indented it.
 */
function windowAt(lines, i, before, after) {
  return lines
    .slice(Math.max(0, i - before), i + after + 1)
    .map((l) => l.replace(/^\s*(?:--|\/\/|\*|#)+\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Names `bypassPermissions` alongside a bus-participant noun, with no
 * qualifier marking it as the test-only branch or as an effect-not-mechanism
 * restatement.
 */
const POSTURE_QUALIFIER =
  /\btests?\b|\bused to\b|\bnot\b|ask-gate|skip|in effect|only by callers|test-only/i;
const PARTICIPANT = /\b(participants?|workers?|agents?|bus)\b/i;

function findPostureClaims(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!/bypassPermissions/.test(line)) return;
    const context = windowAt(lines, i, 1, 1);
    if (!PARTICIPANT.test(context)) return;
    if (POSTURE_QUALIFIER.test(context)) return;
    hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

/**
 * States the superseded pause TRIGGER — the gate firing on the first or any
 * non-`read` call rather than on `dangerous` only, or one Continue covering
 * the rest of the session.
 *
 * The phrase list is deliberately literal rather than a general
 * "(first|any|every) mutation" pattern: `every mutation` is ordinary English
 * for "every logged row" and appears correctly in `repo/multi_agent.ts` and
 * migration 031. A pattern that flags those trains the reader to add
 * exceptions, which is how a gate stops being read.
 */
const PAUSE_TRIGGER =
  /(?:before|on) the first (?:non-`?read`?|mutation)|first non-`?read`? tool call|before the first mutation|subsequent mutations auto-allow|pauses? on any mutation/i;
const PAUSE_CONTEXT = /paus|awaiting_continue|Continue/i;
// Deliberately narrower than the posture qualifier. A first draft used a bare
// `\bnot\b`, which exempted any paragraph containing the word anywhere in a
// five-line window — broad enough that a genuinely reverted claim sitting next
// to an unrelated "not" went unflagged. Caught by the revert-check, not by
// review. Each alternative below is a marker someone writes ON PURPOSE to say
// "this describes the old behaviour".
const PAUSE_QUALIFIER =
  /\bused to\b|superseded|no longer|\bnot before\b|not on the|register|corrected|\bwas\b|as shipped/i;

function findPauseClaims(text) {
  const lines = text.split('\n');
  const hits = [];
  let lastHit = -2;
  lines.forEach((line, i) => {
    // Look forward one line so a wrapped phrase is caught at its first line;
    // the qualifier window reaches further back, since a "SUPERSEDED" or
    // "CORRECTED" marker introduces the paragraph it applies to.
    if (!PAUSE_TRIGGER.test(windowAt(lines, i, 0, 1))) return;
    const context = windowAt(lines, i, 3, 1);
    if (!PAUSE_CONTEXT.test(context)) return;
    if (PAUSE_QUALIFIER.test(context)) return;
    if (i === lastHit + 1) return; // a wrapped phrase matches twice; report once
    lastHit = i;
    hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

// ===========================================================================
// 3. Anti-vacuity: prove the checkers fire, independent of the tree.
// ===========================================================================

describe('[security] the claim checkers actually catch the claims', () => {
  // Verbatim from `git show fdaa82a` — every sentence this PR corrected. If a
  // checker stops flagging one of these it has gone blind, and the scans below
  // would pass by measuring nothing.
  const REAL_POSTURE_CLAIMS = [
    '-- sessions. Bus participants run with `bypassPermissions`, so without this',
    '-- The detection is post-hoc — bus workers run with bypassPermissions, so',
    '-- safety_audit log (workers run bypassPermissions, so this boundary is advisory',
    // Two of these are two-line snippets on purpose: in the real files the
    // participant noun sits on the line ABOVE the one naming the mode. A
    // single-line fixture would pass while the checker missed the real text.
    '# permissions, and secret-injection sinks. Cebab runs bus workers under\n# bypassPermissions; a CI workflow that leaks the GITHUB_TOKEN or executes',
    ' * wrong direction: bus agents run under bypassPermissions, so a poisoned',
    '      // F4: per-launch auth token. Workers under bypassPermissions can',
    '`ignore-scripts=true` (a supply-chain guard — bus agents run under\n`bypassPermissions`, so a malicious transitive `postinstall` would be direct',
    " * project's `trusted` flag. Bus workers always run with bypassPermissions, so",
    '    ? `x: trusted. Bus workers always run with bypassPermissions, so this is informational.`',
    '// Without these checks, a worker under bypassPermissions could write',
  ];

  test.each(REAL_POSTURE_CLAIMS)('flags: %s', (line) => {
    expect(findPostureClaims(line)).toHaveLength(1);
  });

  const REAL_PAUSE_CLAIMS = [
    '--     start (UI: checkbox next to Lifecycle). When 1, the FIRST non-`read`\n--     tool call from any worker triggers an awaiting_continue-style overlay;',
    '   * mutation tap fires `awaiting_continue` + a banner before the first\n   * non-`read` tool call from any worker.',
    ' *     before the first mutation when `pause_on_dangerous=1`.\n *   Consumed by the pause gate.',
  ];

  test.each(REAL_PAUSE_CLAIMS)('flags a superseded pause trigger: %#', (snippet) => {
    expect(findPauseClaims(snippet).length).toBeGreaterThan(0);
  });

  // Must-not-flag controls. Without these the checkers could be trivially
  // "correct" by flagging every line, and the scans would be unfixable.
  test.each([
    ' * `bypassPermissions` branch in `runner.ts` is reached only by tests.',
    " *     'bypassPermissions'`; that branch is reached only by callers which skip",
    "    expect(text).not.toContain('bypassPermissions');",
    "      : { permissionMode: 'bypassPermissions' as const },",
  ])('does not flag: %s', (line) => {
    expect(findPostureClaims(line)).toHaveLength(0);
  });

  test('does not flag a pause trigger that marks itself superseded', () => {
    const corrected =
      '-- │  * 027 — the gate fires on the `dangerous` category ONLY, not on the   │\n' +
      '-- │    first non-`read` call. Ordinary edits and MCP tool calls run free.  │';
    expect(findPauseClaims(corrected)).toHaveLength(0);
  });
});

// ===========================================================================
// 4. The scans.
// ===========================================================================

/**
 * Files permitted to name `bypassPermissions` at all, each with the reason.
 * A file NOT on this list that names it fails — the gate cannot distinguish an
 * SDK type union from a claim about the bus, so the decision is a human's, made
 * once, in writing.
 *
 * `CLAUDE.md` is absent deliberately: it carries claims A and B, and project
 * convention keeps it out of PRs. Register X01/X05 track that.
 */
const POSTURE_ALLOWLIST = new Map([
  ['server/src/bus/runner.ts', 'the branch itself'],
  ['server/src/bus/guardrail.ts', 'the authoritative explanation of why it is test-only'],
  ['server/src/bus/runner.test.ts', 'exercises the no-hook branch'],
  ['server/src/bus/orchestrator.security.test.ts', 'names the corrected history'],
  ['server/src/runner/claude.ts', 'SDK option docs — single-agent runner, not a bus claim'],
  ['server/src/ws/translate.ts', 'SDK permission_mode type union'],
  ['server/src/ws/permission.test.ts', 'single-agent acceptEdits vs bypass semantics'],
  ['shared/src/protocol.ts', 'wire type union'],
  ['server/src/migrations/021_guardrail_violation_fields.sql', 'quotes the corrected claim'],
  ['web/src/components/authority/ModelIdentityCard.tsx', 'renders the SDK mode a session reports'],
  ['web/src/components/authority/ModelIdentityCard.test.tsx', 'ditto'],
  ['web/src/components/templatePreview/TemplatePreviewBanners.tsx', 'quotes the corrected claim'],
  ['web/src/components/templatePreview/TemplatePreviewBanners.test.tsx', 'asserts its absence'],
  ['web/src/components/MultiAgentTab.busGates.test.tsx', 'asserts its absence'],
  ['.npmrc', 'carries the canonical corrected wording'],
  [SELF, 'this gate'],
]);

describe('[security] no artifact may claim the superseded bus safety model', () => {
  const files = collectFiles();
  const scanned = files.filter((rel) => rel !== SELF);

  // If the walk ever stops finding the tree, all three scans below go green
  // while measuring nothing — `project_gates_pass_vacuously`. Pin a floor and
  // two files that must be in range.
  test('the scan actually reaches the tree', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('server/src/bus/runner.ts');
    expect(files).toContain('README.md');
  });

  test('every file naming bypassPermissions is on the allowlist', () => {
    const unlisted = scanned.filter(
      (rel) => /bypassPermissions/.test(read(rel)) && !POSTURE_ALLOWLIST.has(rel),
    );
    expect(
      unlisted,
      'A new file names `bypassPermissions`. Bus turns run `permissionMode: ' +
        "'default'` with a live `canUseTool`; that branch is test-only. If this " +
        'is an SDK type union or a corrected quotation, add it to ' +
        'POSTURE_ALLOWLIST with the reason. If it is a claim about how the bus ' +
        'runs, it is wrong — see server/src/bus/guardrail.ts.',
    ).toEqual([]);
  });

  test('no artifact states that bus participants run under bypassPermissions', () => {
    const hits = scanned.flatMap((rel) =>
      findPostureClaims(read(rel)).map((h) => `${rel}:${h.line}  ${h.text}`),
    );
    expect(hits).toEqual([]);
  });

  test('no artifact states the pause fires on the first or any mutation', () => {
    const hits = scanned.flatMap((rel) =>
      findPauseClaims(read(rel)).map((h) => `${rel}:${h.line}  ${h.text}`),
    );
    expect(hits).toEqual([]);
  });
});

/**
 * Walk the source tree for the file types these claims live in. Done with a
 * directory walk rather than `git ls-files` so the gate runs identically on
 * both CI runners and needs no subprocess.
 */
function collectFiles() {
  const roots = ['server/src', 'shared/src', 'web/src', 'scripts', '.github/workflows'];
  const exts = new Set(['.ts', '.tsx', '.sql', '.mjs', '.yml', '.md']);
  const out = [];
  for (const root of roots) walk(root, out, exts);
  for (const top of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.npmrc']) {
    if (fs.existsSync(path.join(repoRoot, top))) out.push(top);
  }
  return out;
}

function walk(rel, out, exts) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(child, out, exts);
    } else if (exts.has(path.extname(entry.name)) || entry.name === '.npmrc') {
      out.push(child);
    }
  }
}
