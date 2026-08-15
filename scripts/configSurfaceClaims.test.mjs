/**
 * The artifacts that tell an operator how to configure Cebab must name things
 * that exist.
 *
 * WHAT WENT WRONG, so the gate's shape makes sense. Register X12/X17/X26/X27
 * are four separate findings with one cause: a configuration fact changed in
 * the code and the file an operator reads kept the old one. None of them broke
 * a test, because prose does not.
 *
 *   A. `README.md` and the Settings modal both said a project's `CLAUDE.md`,
 *      skills dir and MCP config "auto-load" — unconditionally, and naming an
 *      MCP path under `.claude/` that the CLI does not read for that purpose.
 *      An untrusted project spawns `settingSources: ['user']` and loads none of
 *      its own files; the loading location is the project-root `.mcp.json`.
 *      Filed against the README only. The UI copy went unnamed for two weeks.
 *   B. `.env.example` documented six variables while the server read ten. The
 *      register named ONE of the gaps — `CEBAB_AUTO_RECLAIM_DAYS`, which
 *      soft-deletes operator sessions. Running this check backwards over the
 *      repo before writing it found four.
 *   C. Two files claimed CI runs the rolling Windows image. It is pinned. Worse,
 *      `ci.yml`'s own explanation of the required-status-check aggregator used
 *      the rolling name as its example of an emitted context — and context names
 *      are generated from the matrix VALUES, so the pin silently falsified the
 *      sentence that explains why that job exists.
 *
 * WHY A GATE AND NOT JUST THE FIX. `scripts/busSafetyClaims.test.mjs` makes the
 * argument at length and this file is deliberately the same shape: corrections
 * applied one file at a time, with no sweep, leave siblings holding the
 * identical sentence. Both of the copies in A were found by grepping the claim
 * rather than by reading the bead.
 *
 * THREE RULES, ALL LITERAL OR STRUCTURAL. No fuzzy qualifier regexes — those
 * need the design and revert-check care `busSafetyClaims.test.mjs` documents,
 * and a half-built matcher is worse than none. The prose rule this file does
 * NOT enforce ("a sentence saying project config auto-loads must name Trust in
 * the same window") is filed separately for that reason.
 *
 * ANTI-VACUITY. Every rule is at zero once the corrections land, so scanning
 * the corrected tree passes whether or not the checkers work — the exact
 * failure of `project_gates_pass_vacuously`. So each checker is fed the
 * VERBATIM pre-correction text as a fixture and must flag it, and the corrected
 * replacement as a fixture it must not. Those run independently of the tree.
 *
 * Parsing is line-oriented with no YAML/TS parser, matching
 * `scripts/busSafetyClaims.test.mjs` and `scripts/semgrepRules.test.mjs`: those
 * dependencies resolve as unhoisted transitives here and break on a clean
 * `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Excluded from its own literal scans. Its anti-vacuity fixtures are verbatim
 * copies of the strings it forbids, so scanning itself reports every one — the
 * same reason `.semgrep/cebab-bus.ts` is `--exclude`d from the semgrep step
 * while being the input to `semgrep --test`.
 */
const SELF = 'scripts/configSurfaceClaims.test.mjs';

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a test that scans files as text
 * should not assume its input: a contributor with a global `core.autocrlf=true`
 * reads `\r` at every line end, and this repo has lost CI round-trips to that
 * (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ===========================================================================
// 1. Ground truth: what the code actually does.
// ===========================================================================

describe('the configuration facts the prose must match', () => {
  test('the project-scoped MCP file is the project-root .mcp.json', () => {
    // Rule 2's premise. If the CLI ever starts reading a different path, this
    // is where the prose is re-derived — otherwise a real change would leave
    // the scan below forbidding the correct spelling.
    expect(read('server/src/repo/project_authority.ts')).toMatch(
      /const MCP_JSON_FILENAME = '\.mcp\.json';/,
    );
  });

  test('untrusted projects load none of their own files', () => {
    // The half of X17 that is about Trust rather than about a path. The SDK
    // default is `['user']`; a project's files need `'project'`.
    expect(read('server/src/runner/claude.ts')).toMatch(
      /settingSources:\s*opts\.settingSources \?\? \['user'\]/,
    );
  });

  test('the Windows CI image is pinned, not rolling', () => {
    // Rule 3's premise, and the reason the rolling name may still appear in
    // `ci.yml`: that file explains the pin and carries the revert condition.
    expect(read('.github/workflows/ci.yml')).toMatch(/os:\s*\[ubuntu-latest,\s*windows-2022\]/);
  });
});

// ===========================================================================
// 2. The checkers.
// ===========================================================================

/**
 * Environment variables the server reads STATICALLY, as `process.env.NAME`.
 *
 * TWO FILTERS ON TWO DIFFERENT AXES, both stated rather than implied — the
 * question `project_gates_pass_vacuously` says to ask of any gate that claims
 * to have no allowlist:
 *
 *   - FILES are filtered by PATH: `*.test.ts` (tests set env vars to arrange
 *     cases, they do not read config) and `*_smoke.ts` (three dev tools —
 *     `ws_smoke`, `live_smoke`, `ci_smoke` — whose `CEBAB_AUTH_TOKEN*` and
 *     `WS_URL` are harness plumbing an operator never sets).
 *   - NAMES are filtered by the explicit `NOT_OPERATOR_CONFIG` map below.
 *
 * KNOWN BLIND SPOT, stated because a silent one is how a gate goes vacuous:
 * this cannot see dynamic access. `repo/project_authority.ts` reads
 * `process.env[envKey]` to report whether a settings-declared variable is set,
 * which is a different thing from Cebab reading its own config — but a future
 * `process.env[SOME_CONST]` that IS config would pass unnoticed.
 */
function envVarsRead(sources) {
  const names = new Set();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Names that are read but are not operator configuration, each with its reason.
 * A name NOT here and NOT in `.env.example` fails: the gate cannot tell a knob
 * from an ambient signal, so a human decides once, in writing.
 *
 * One entry today, and that is the measurement rather than an oversight — the
 * path filter above already removes every other non-knob, because they are read
 * only from tests and smokes.
 */
const NOT_OPERATOR_CONFIG = new Map([
  ['VITEST', 'ambient test-runner signal, read by db.ts to refuse the real data dir'],
]);

/**
 * Whether `.env.example` documents `name` — as a set line (`PORT=4319`) or a
 * commented-out one (`# MAX_TURNS=50`), which is how every optional knob in
 * that file is written.
 *
 * Line-oriented rather than a built regex: `security/detect-non-literal-regexp`
 * flags `new RegExp` on an interpolated name, and while these names come from
 * an `[A-Z_][A-Z0-9_]*` match and cannot carry metacharacters, arguing with the
 * linter is worse than not needing it. Naming the variable in PROSE does not
 * count — the anchor is the point.
 */
function documentsEnvVar(envExample, name) {
  return envExample
    .split('\n')
    .some((line) => line.replace(/^#\s*/, '').trimStart().startsWith(`${name}=`));
}

/**
 * Names in `sources` whose text contains `needle`, verbatim.
 *
 * Takes its sources as an argument rather than reading paths off disk, for the
 * reason `web/src/vocabularyGate.test.ts` records: the tree is CLEAN once the
 * corrections land, so scanning it proves only that the tree is clean — never
 * that the checker would notice if it were not. The fixtures below feed this
 * the pre-correction text directly.
 */
function filesContaining(sources, needle) {
  return Object.entries(sources)
    .filter(([, text]) => text.includes(needle))
    .map(([name]) => name)
    .sort();
}

/** `{ relative path -> text }` for a list of repo-relative paths. */
function readAll(files) {
  return Object.fromEntries(files.map((rel) => [rel, read(rel)]));
}

/**
 * Built from fragments so this file's own rules do not flag it, the way
 * `web/src/vocabularyGate.test.ts` builds its needles. Load-bearing, not
 * decorative: both scans are substring tests, so the assembled words would be
 * found verbatim in this file and every scan would report it.
 */
const MCP_UNDER_DOT_CLAUDE = `.claude${'/'}mcp.json`;
const ROLLING_WINDOWS = `windows${'-'}latest`;

// ===========================================================================
// 3. Anti-vacuity: prove the checkers fire, independent of the tree.
// ===========================================================================

describe('the checkers actually catch the claims', () => {
  test('the env scan finds names in source text', () => {
    // The regex is the whole checker; a typo in it makes rule 1 pass by
    // finding nothing to check.
    const src = [
      "  port: parseIntEnv('PORT', process.env.PORT, { fallback: 4319 }),",
      '  autoReclaimDays: parseAutoReclaimDays(process.env.CEBAB_AUTO_RECLAIM_DAYS),',
    ].join('\n');
    expect(envVarsRead({ 'config.ts': src })).toEqual(['CEBAB_AUTO_RECLAIM_DAYS', 'PORT']);
  });

  test('the env scan does not invent names from prose', () => {
    // Must-not-find control. Without it the regex could be loosened to any
    // SHOUTING_TOKEN and rule 1 would demand documentation for words.
    expect(envVarsRead({ 'a.ts': 'Set MOCK_SCENARIO to replay a bus fixture.' })).toEqual([]);
  });

  test.each([
    ['CEBAB_AUTO_RECLAIM_DAYS', false],
    ['MOCK_INTERVAL_MS', false],
    ['PORT', true],
    ['MOCK', true],
  ])('documentsEnvVar(%s) === %s against the pre-correction .env.example', (name, expected) => {
    // Verbatim from `git show fd67a95 -- .env.example`, trimmed to the lines
    // that matter. The two `false` cases are gaps this PR closed; if
    // `documentsEnvVar` stops working they flip to true and the scan goes green
    // on a file that documents nothing.
    const preCorrection = [
      'WORKSPACE_ROOT=~/agents',
      'MOCK=0',
      'PORT=4319',
      '# MAX_TURNS=50',
      '# CEBAB_ALLOWED_ORIGINS=http://127.0.0.1:5173',
      '# VITE_SERVER_PORT=4319',
      '# CEBAB_DATA_DIR=~/.cebab',
    ].join('\n');
    expect(documentsEnvVar(preCorrection, name)).toBe(expected);
  });

  test('documentsEnvVar does not match a name that merely appears in prose', () => {
    // `MOCK_SCENARIO` named in a sentence is not documentation of it. Without
    // this the anchor could be loosened to `includes(name)` and every rule
    // would pass on any file that mentioned the variable anywhere.
    expect(
      documentsEnvVar('# Ignored unless MOCK_SCENARIO is a bus fixture dir.', 'MOCK_SCENARIO'),
    ).toBe(false);
  });

  test('RULE 2 flags both pre-correction copies, and only those', () => {
    // Verbatim from `git show fd67a95` — the README sentence X17 was filed
    // against, and the Settings-modal copy it was NOT filed against, which is
    // the one an operator actually reads. The third entry is the corrected
    // wording: it names `.mcp.json`, so a rule loosened to that literal would
    // forbid the right answer along with the wrong one.
    const sources = {
      'README.md':
        "project's `CLAUDE.md`, `.claude/skills/`, and " +
        '`' +
        MCP_UNDER_DOT_CLAUDE +
        '` all auto-load.',
      'SettingsModal.tsx':
        '<code>CLAUDE.md</code>, <code>.claude/skills/</code>, and <code>' +
        MCP_UNDER_DOT_CLAUDE +
        '</code>',
      'corrected.md': 'and project-root `.mcp.json`. Flipping a project to trusted',
    };
    expect(filesContaining(sources, MCP_UNDER_DOT_CLAUDE)).toEqual([
      'README.md',
      'SettingsModal.tsx',
    ]);
  });

  test('RULE 3 flags both pre-correction sentences, and not the pinned image', () => {
    // Verbatim from `git show fd67a95`. The `ci.yml` one is the one that
    // mattered: it used the rolling name as its EXAMPLE of an emitted context,
    // and context names are generated from the matrix VALUES — so pinning the
    // matrix falsified the sentence that explains why the aggregator exists.
    const sources = {
      'README.md': 'CI exercises both `ubuntu-latest` and\n`' + ROLLING_WINDOWS + '`.',
      'ci.yml':
        '# above reports per-OS contexts ("... (ubuntu-latest)" / "...\n  # (' +
        ROLLING_WINDOWS +
        ')"), so the bare name is never produced',
      'corrected.yml': '# "... (windows-2022)"), so the bare name is never produced',
    };
    expect(filesContaining(sources, ROLLING_WINDOWS)).toEqual(['README.md', 'ci.yml']);
  });

  test('filesContaining reports every hit, not just the first', () => {
    // Rules 2 and 3 both report a LIST; a checker that stopped at the first hit
    // would fix one copy per CI round and look green in between — which is the
    // one-file-at-a-time failure this gate exists to end.
    const src = 'names ' + MCP_UNDER_DOT_CLAUDE + ' here';
    const sources = { 'a.md': src, 'b.md': src, 'c.md': 'clean' };
    expect(filesContaining(sources, MCP_UNDER_DOT_CLAUDE)).toEqual(['a.md', 'b.md']);
  });
});

// ===========================================================================
// 4. The scans.
// ===========================================================================

/**
 * The rolling Windows image may be named in `ci.yml` and nowhere else: that
 * workflow pins the image and carries the revert condition, so it has to say
 * which image it is NOT using. One file, one reason.
 */
const ROLLING_IMAGE_ALLOWLIST = new Set(['.github/workflows/ci.yml']);

describe('the operator-facing config surface names things that exist', () => {
  const files = collectFiles();
  const scanned = files.filter((rel) => rel !== SELF);
  const serverConfigSources = files.filter(
    (rel) =>
      rel.startsWith('server/src/') &&
      rel.endsWith('.ts') &&
      !rel.endsWith('.test.ts') &&
      !rel.endsWith('_smoke.ts'),
  );

  // If the walk stops finding the tree, every scan below goes green while
  // measuring nothing. A count alone cannot catch the set being the WRONG set,
  // so the files each rule depends on are named too.
  test('the scan reaches the tree', () => {
    expect(files.length).toBeGreaterThan(200);
    // 84 today, of 229 `.ts` under `server/src` — the path filter drops the
    // rest as tests and smokes. A floor well below that survives ordinary
    // churn while still catching a collapse to a handful.
    expect(serverConfigSources.length).toBeGreaterThan(60);
  });

  test('each rule has its subject in range, by name', () => {
    // One `expect` per rule, failing for a different reason on purpose.
    expect(serverConfigSources).toContain('server/src/config.ts'); // rule 1
    expect(files).toContain('.env.example'); // rule 1
    expect(files).toContain('README.md'); // rules 2 and 3
    expect(files).toContain('web/src/components/SettingsModal.tsx'); // rule 2
    expect(files).toContain('.github/workflows/ci.yml'); // rule 3
  });

  test('the scanned server sources exclude tests and smokes', () => {
    // The path filter is half the env rule. If it stops applying, the smokes'
    // harness variables become "undocumented operator config" and the rule
    // fails for a reason that has nothing to do with drift.
    expect(serverConfigSources.filter((f) => f.includes('.test.'))).toEqual([]);
    expect(serverConfigSources.filter((f) => f.endsWith('_smoke.ts'))).toEqual([]);
  });

  test('RULE 1: .env.example documents every operator env var the server reads', () => {
    const envExample = read('.env.example');
    const undocumented = envVarsRead(readAll(serverConfigSources)).filter(
      (name) => !documentsEnvVar(envExample, name) && !NOT_OPERATOR_CONFIG.has(name),
    );
    expect(
      undocumented,
      'The server reads an environment variable that `.env.example` does not ' +
        'document. `.env.example` is the file operators copy; a knob missing ' +
        'from it is a knob nobody knows exists — which is how ' +
        'CEBAB_AUTO_RECLAIM_DAYS, the one setting that destroys data, went ' +
        'undocumented (register X26). Add it there, or add it to ' +
        'NOT_OPERATOR_CONFIG with the reason it is not configuration.',
    ).toEqual([]);
  });

  const scannedSources = readAll(scanned);

  test('RULE 2: no artifact names an MCP config under .claude/', () => {
    expect(
      filesContaining(scannedSources, MCP_UNDER_DOT_CLAUDE),
      'An artifact names an MCP config file under `.claude/`. The CLI does ' +
        'not read one there: the project-scoped location is the project-root ' +
        '`.mcp.json`, and it loads only when `settingSources` includes ' +
        "'project' — i.e. only for a trusted project. See the measured table " +
        'in `server/src/repo/project_authority.ts` (register X17).',
    ).toEqual([]);
  });

  test('RULE 3: the rolling Windows image is named only where it is pinned', () => {
    const unlisted = filesContaining(scannedSources, ROLLING_WINDOWS).filter(
      (rel) => !ROLLING_IMAGE_ALLOWLIST.has(rel),
    );
    expect(
      unlisted,
      'An artifact names the rolling Windows runner image. The matrix pins ' +
        '`windows-2022` (`.github/workflows/ci.yml` carries the reason and the ' +
        'revert condition). If this is a portability claim, name the OS ' +
        'instead — that stays true when the matrix repins. If it is about the ' +
        'pin itself, it belongs in ci.yml (register X12).',
    ).toEqual([]);
  });
});

/**
 * Walk the source tree for the file types these claims live in, plus the
 * top-level config artifacts by name. A directory walk rather than
 * `git ls-files` so the gate runs identically on both CI runners with no
 * subprocess — same approach as `scripts/busSafetyClaims.test.mjs`.
 */
function collectFiles() {
  const roots = ['server/src', 'shared/src', 'web/src', 'scripts', 'docs', '.github/workflows'];
  const exts = new Set(['.ts', '.tsx', '.sql', '.mjs', '.yml', '.md']);
  const out = [];
  for (const root of roots) walk(root, out, exts);
  // Extensionless or dot-prefixed, so the walk cannot reach them however the
  // roots are arranged — `.env.example` is rule 1's entire subject, and
  // `busSafetyClaims.test.mjs` records a superseded claim surviving in
  // `.github/CODEOWNERS` for exactly this reason. Listed by name or not at all.
  for (const top of [
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    '.env.example',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ]) {
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
    } else if (exts.has(path.extname(entry.name))) {
      out.push(child);
    }
  }
}
