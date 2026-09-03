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
/**
 * Every alternative is a marker someone writes ON PURPOSE to say "this
 * describes the test-only branch or the superseded claim" — the principle
 * `PAUSE_QUALIFIER` below already states, and which this list did not follow
 * until 2026-08-14.
 *
 * It used to read `\btests?\b|\bused to\b|\bnot\b|ask-gate|skip|in effect|…`,
 * and CLAUDE.md's inverted claim proved what that cost. The sentence
 *
 *     "with no ask-gate hook wired (chain participants, tests — the
 *      pure-headless path) they run `permissionMode: 'bypassPermissions'` +
 *      `allowDangerouslySkipPermissions`"
 *
 * is the exact claim this gate exists to forbid, and it was exempted THREE
 * times over: by `ask-gate` (which it uses to assert that hook's ABSENCE), by
 * `tests` (which it names as one of the two things on the bypass path — the
 * false pairing itself), and by `skip`, which matches inside
 * `allowDangerouslySkipPermissions`. That last one is the worst: the qualifier
 * matched a substring of the very API name that constitutes the claim, so no
 * sentence naming that option could ever be flagged.
 *
 * `\.not\.toContain\(` is here because a test asserting the string's ABSENCE
 * is a legitimate mention. It replaces the bare `\bnot\b` that used to exempt
 * it by accident — measured: tightening without it flagged exactly one site,
 * `web/src/components/MultiAgentTab.busGates.test.tsx`, and that site is
 * right. One legitimate hit is a reason to change the predicate, not to add an
 * allowlist entry.
 */
const POSTURE_QUALIFIER =
  /\btest-only\b|only by callers|reached only by|\bused to\b|superseded|no longer|corrected|\bregister\b|as shipped|in effect|\.not\.toContain\(/i;
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
    // Register X01, verbatim from CLAUDE.md before this PR. It is here because
    // it is the one claim in the corpus the ORIGINAL qualifier could not flag
    // (see POSTURE_QUALIFIER's header), so without it the tightening above
    // could be reverted and every case would still pass.
    "Bus agents run one of **two permission postures** (`server/src/bus/runner.ts`): with no ask-gate hook wired (chain participants, tests — the pure-headless path) they run `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions`;",
    // Register X31, verbatim from `.github/CODEOWNERS` before 2026-08-15. It
    // survived the correction of every other copy because the walk cannot
    // reach an extensionless file beside the `workflows` root — the claim was
    // fine, the gate's REACH was not. It was kept as a fixture against the day
    // `.github/CODEOWNERS` left `collectFiles`, so the wording that hid there
    // would still be provably detectable.
    //
    // THAT DAY CAME: the file went with the repo-workflow automation, and this
    // line is now the only place the phrasing exists. Which is the argument for
    // the practice — a corpus can lose a file for reasons that have nothing to
    // do with the claim it carried, and a fixture is what survives that.
    '# Worker / orchestrator both run with --permission-mode bypassPermissions.',
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
 * `CLAUDE.md` was absent from the SCAN ITSELF until 2026-08-14, on the reason
 * "it carries claims A and B, and project convention keeps it out of PRs".
 * That convention is gone, and the exemption it justified is why the file kept
 * an inverted posture claim through four releases: an exemption whose premise
 * expires does not announce itself. It is now collected and listed below.
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
  ['CLAUDE.md', 'names the branch to say it is test-only, not the chain path'],
  // Cebab-ws0.4 — all five name the mode to say Cebab NEVER exposes it. They
  // are single-agent permission narrowing, not claims about how the bus runs.
  [
    'server/src/repo/projects.ts',
    'the read-side guard: names the wider SDK modes it filters out of a single-agent seed',
  ],
  [
    'server/src/migrations/036_project_start_permission_mode.sql',
    'explains why the column has no CHECK and is filtered at the read site instead',
  ],
  [
    'server/src/migrations/036_project_start_permission_mode.schema.test.ts',
    'asserts a hand-edited row carrying it is rejected',
  ],
  ['server/src/ws/validate_client_msg.test.ts', 'asserts the wire rejects it'],
  [
    'server/src/ws/single_agent_model_wiring.test.ts',
    'names it as the value the read-side guard exists to stop',
  ],
  // Cebab-vie.16: the smoke that MEASURES this seam. It names the branch to
  // explain why omitting `onAskUserQuestion` measured the wrong posture — the
  // SDK's own `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is quoted there. A
  // record of the mistake, not a claim about how the bus runs.
  [
    'server/src/bus_pause_gate_smoke.ts',
    'names the test-only branch to explain a mis-measurement it corrects',
  ],
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

  test('the docs/ split is in range, both files, with claim-bearing content', () => {
    // CLAUDE.md was split behind an index on 2026-08-15 and the deep bus and
    // safety reference moved here. If `docs` is dropped from the roots, the
    // scans below still pass — on a corpus that no longer contains the
    // material they exist to check. That is the same failure the CLAUDE.md
    // exemption was: green because nothing looked.
    expect(files).toContain('docs/bus-architecture.md');
    expect(files).toContain('docs/safety-and-security.md');
    expect(read('docs/safety-and-security.md')).toContain('pause');
  });

  test('the single-agent permission posture is in the PUBLIC corpus', () => {
    // The posture claims — Trust's two effects, `shouldAutoAllow`, the
    // `seedPermissionMode` order, the auth-precedence scrub — lived only in
    // CLAUDE.md, which is not a file every reader of this repo has. They now
    // live here, and this is what stops them being deleted as duplication:
    // each string is the SUBJECT of a scan above, so losing one silently
    // shrinks what the gate is checking rather than failing anything.
    const doc = read('docs/safety-and-security.md');
    for (const claim of [
      'settingSources',
      'shouldAutoAllow',
      'seedPermissionMode',
      'SCRUBBED_ENV_VAR_NAMES',
      'consultant',
    ]) {
      expect(doc, `docs/safety-and-security.md no longer covers ${claim}`).toContain(claim);
    }
  });

  test('SECURITY.md is in range, and still states the runtime posture', () => {
    // Listed in `collectFiles` since this gate was written and never given a
    // coverage case of its own — so a dropped entry would have gone unnoticed
    // exactly the way CLAUDE.md's did. It is also the one artifact here aimed
    // at people outside this repo, which makes a stale posture sentence in it
    // the most expensive kind.
    expect(files).toContain('SECURITY.md');
    const sec = read('SECURITY.md');
    expect(sec).toContain('permissionMode');
    expect(sec).toContain('canUseTool');
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
  // `docs` joined the roots when CLAUDE.md was split behind an index: the deep
  // bus and safety reference moved there, and content does not stop being a
  // claim by changing files. A scan whose roots do not follow its subject
  // matter goes green by looking away.
  const roots = ['server/src', 'shared/src', 'web/src', 'scripts', 'docs', '.github/workflows'];
  const exts = new Set(['.ts', '.tsx', '.sql', '.mjs', '.yml', '.md']);
  const out = [];
  for (const root of roots) walk(root, out, exts);
  // `CLAUDE.md` and `CONTRIBUTING.md` were in this list until they became
  // local-only. Losing them is not a weakening, because the claims they
  // carried moved into `docs/safety-and-security.md` and `SECURITY.md` FIRST
  // (#508) and are asserted there individually — a scan whose corpus shrinks
  // silently is the exact failure this gate exists to prevent, so the two
  // steps were deliberately separate commits.
  //
  // `.github/CODEOWNERS` was listed here for the same reason, and left with the
  // repo-workflow automation. It had held a fourth copy of the superseded
  // posture claim until 2026-08-15 — found only because arming this gate on
  // CLAUDE.md prompted a sweep for the places the walk cannot reach. That is
  // the lesson worth keeping: the files this scan misses are the extensionless
  // ones beside a root rather than inside it.
  for (const top of ['README.md', 'SECURITY.md', '.npmrc']) {
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
