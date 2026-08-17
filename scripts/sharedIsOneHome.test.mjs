/**
 * `shared/` is the one home for the names it declares — register N13.
 *
 * WHAT WENT WRONG. `server/src/repo/per_agent_control.ts` declared its own
 * `KickMode`, `PauseExpiryAction`, their frozen sets and both guards, all of
 * which `shared/src/protocol.ts` already owned. The copies were structurally
 * equal, so everything compiled and nothing drifted — but the server's sets
 * were typed `ReadonlySet<string>` where shared's are `ReadonlySet<KickMode>`,
 * so a typo added to the server set compiled and the same typo in shared's did
 * not. The weaker copy was the one validating DB rows.
 *
 * `server/src/repo/multi_agent.ts` had the same defect with
 * `MultiAgentLifecycle`, filed nowhere: six wire message shapes use shared's
 * copy, every server consumer imported the local one, and adding a third arm to
 * the wire union would have compiled cleanly here while being unrepresentable.
 *
 * WHY THIS AXIS AND NOT "NO DUPLICATE EXPORTS ANYWHERE". Measured before the
 * rule was written, across `shared/src` + `server/src` + `web/src`: 750
 * exported value names, 8 colliding; 380 exported type names, 6 colliding. Of
 * those 14, exactly 5 collided with a name declared in `shared/src` — and all
 * 5 were defects. The other 9 are not:
 *
 *   - `__resetForTests`, `_testing` — per-module test seams. Every module that
 *     needs one exports its own; that is the pattern working, not failing.
 *   - `AwaitGateInput` — two structurally DIFFERENT types in two gate modules
 *     that happen to share a role-derived name.
 *   - `MIN_SEARCH_QUERY_LEN`, `RAW_ACK_HEADER`, `RAW_ACK_VALUE`,
 *     `ExportFormat`, `InboxFilters` — deliberate server↔web mirrors, each
 *     carrying a comment that says so. A real drift risk, differently shaped,
 *     and tracked separately; enforcing them is a decision, not a cleanup.
 *   - `formatElapsed` — filed as its own finding.
 *
 * So a repo-wide no-duplicates rule would flag 6 non-defects and need a written
 * allowlist. On the `shared/src` axis the exception count is zero, which is
 * what makes this a rule. The rejected wider variant is in the revert-check.
 *
 * THE RULE, both halves:
 *
 *   1. No name DECLARED in `shared/src` may be declared again in `server/src`
 *      or `web/src`.
 *   2. No name may be declared twice WITHIN `shared/src`. `shared/src/index.ts`
 *      is five `export *` lines, and TypeScript drops an ambiguous star
 *      re-export silently — no error, the name simply stops being exported.
 *      Measured at zero today, so this half is a ratchet, not a fix.
 *
 * RE-EXPORTS ARE THE FIX, SO THEY MUST PASS. `multi_agent.ts` now does
 * `export type { MultiAgentLifecycle }` over an import from shared. That is one
 * symbol with two import paths, which cannot drift — unlike two declarations,
 * which is the whole defect. The scan therefore matches DECLARATION forms only,
 * and a test below pins that, because if it did not hold, the fix this gate
 * ships alongside would fail the gate.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Non-exported duplicates: the two private
 * `writeTranscript` copies in `bus/orchestrator.ts` and `bus/chain.ts` are the
 * same root cause and this gate cannot see them (tracked separately). Stated
 * rather than silent — a gate read as broader than it is, is worse than a
 * narrow one.
 *
 * Lives in `scripts/` rather than `web/` because it reads all three packages;
 * `web/tsconfig.json` sets `types: []` and `nodeTypeIsolation.test.ts` enforces
 * it, so a `web/` spec cannot use `node:fs`. Hand-rolled parsing, no TypeScript
 * dependency — those resolve as unhoisted transitives here and break on a clean
 * `npm ci`, which is why every gate in `scripts/` parses by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './lib/strip_comments.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a scan should not assume its
 * input: a contributor with a global `core.autocrlf=true` reads `\r` at every
 * line end, and this repo has lost CI round-trips to that
 * (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ===========================================================================
// 1. The checker.
// ===========================================================================

/**
 * Every `export` form that introduces a NEW name.
 *
 * Deliberately excludes `export { … }` / `export type { … } from …`: those
 * bind an existing symbol, and a second path to one symbol cannot disagree
 * with itself. The `[A-Za-z_$]` after the keyword is what separates them — a
 * re-export has `{` there.
 */
const DECL =
  /^export (?:declare )?(?:async )?(?:function|const|let|var|class|type|interface|enum|abstract class) ([A-Za-z_$][\w$]*)/gm;

/**
 * Deterministic name ordering.
 *
 * NOT `localeCompare`: its result depends on the ambient locale, which differs
 * between this repo's two CI runners and a developer's shell. Code-unit order
 * is identical everywhere, and these are ASCII identifiers where "sorted" only
 * needs to mean "stable". Same class of trap as CRLF — a comparison that is
 * right on the machine you wrote it on and different on the one that gates the
 * merge.
 */
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** `Map<name, file[]>` for one content map. */
function declarations(sources) {
  const out = new Map();
  for (const [file, rawSrc] of Object.entries(sources)) {
    // Prose first (Cebab-6sr). `DECL`'s `^` anchor makes an indented sample in
    // a comment safe, but a code block written flush-left inside a `/** … */` —
    // and any commented-out declaration — matched. This gate was measured
    // counting one such line before the strip: it was a false positive in the
    // OTHER direction (a real declaration hidden behind a phantom block
    // comment, Cebab-1px), which is how the stripper's own bug surfaced.
    const src = stripComments(rawSrc);
    for (const m of src.matchAll(DECL)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(file);
    }
  }
  return out;
}

/** Names declared in `shared` and declared again in `outside`. */
function reDeclared(shared, outside) {
  const own = declarations(shared);
  const hits = [];
  for (const [name, files] of declarations(outside)) {
    if (own.has(name)) hits.push({ name, shared: own.get(name).join(','), at: files.join(',') });
  }
  return hits.sort(byName);
}

/** Names `shared` declares in more than one of its own files. */
function ambiguousWithin(shared) {
  return [...declarations(shared)]
    .filter(([, files]) => new Set(files).size > 1)
    .map(([name, files]) => ({ name, at: [...new Set(files)].join(',') }))
    .sort(byName);
}

// ===========================================================================
// 2. Anti-vacuity: prove the checker fires, independent of the tree.
// ===========================================================================

describe('the one-home checker catches what it is for', () => {
  // `git show d42568a:…`. The tree has zero violations after this PR, so
  // without these fixtures every scan below passes whether or not it works.
  const SHARED_BEFORE = {
    'shared/src/protocol.ts': [
      "export type KickMode = 'drain' | 'hard';",
      "export const KICK_MODES: ReadonlySet<KickMode> = new Set(['drain', 'hard']);",
      'export function isKickMode(v: unknown): v is KickMode {',
      "export type MultiAgentLifecycle = 'persistent' | 'temp';",
    ].join('\n'),
  };

  test('flags the verbatim pre-fix per_agent_control declarations', () => {
    const server = {
      'server/src/repo/per_agent_control.ts': [
        "export type PauseExpiryAction = 'auto_resume' | 'auto_kick';",
        "export type KickMode = 'drain' | 'hard';",
        'export function isKickMode(v: unknown): v is KickMode {',
      ].join('\n'),
    };
    expect(reDeclared(SHARED_BEFORE, server)).toEqual([
      {
        name: 'KickMode',
        shared: 'shared/src/protocol.ts',
        at: 'server/src/repo/per_agent_control.ts',
      },
      {
        name: 'isKickMode',
        shared: 'shared/src/protocol.ts',
        at: 'server/src/repo/per_agent_control.ts',
      },
    ]);
  });

  test('flags the verbatim pre-fix multi_agent declaration', () => {
    // The twin the register never filed — found by measurement, not by reading
    // the bead. Its own case so a fix to one cannot silently cover the other.
    const server = {
      'server/src/repo/multi_agent.ts': "export type MultiAgentLifecycle = 'persistent' | 'temp';",
    };
    expect(reDeclared(SHARED_BEFORE, server)).toEqual([
      {
        name: 'MultiAgentLifecycle',
        shared: 'shared/src/protocol.ts',
        at: 'server/src/repo/multi_agent.ts',
      },
    ]);
  });

  test('a RE-EXPORT is not a declaration — the shape this PR ships', () => {
    // If this regressed, the fix in `multi_agent.ts` would fail this very gate.
    // Both spellings: with a `from` clause, and over a local import.
    const server = {
      'a.ts': "export type { MultiAgentLifecycle } from '@cebab/shared/protocol';",
      'b.ts': 'export type { MultiAgentLifecycle };',
      'c.ts': "export { isKickMode, KICK_MODES } from '@cebab/shared/protocol';",
      'd.ts': 'export { isKickMode };',
    };
    expect(reDeclared(SHARED_BEFORE, server)).toEqual([]);
  });

  test('an unrelated name in the same file is not flagged', () => {
    // Over-fire control: the checker must key on the NAME, not on the file
    // being one that also happens to contain a violation.
    const server = {
      'server/src/repo/per_agent_control.ts': [
        'export type ControlState = { muted: boolean };',
        "export type KickMode = 'drain' | 'hard';",
      ].join('\n'),
    };
    expect(reDeclared(SHARED_BEFORE, server).map((h) => h.name)).toEqual(['KickMode']);
  });

  test('a name declared only outside shared is not flagged', () => {
    expect(
      reDeclared(SHARED_BEFORE, { 'a.ts': 'export type ControlRow = { id: number };' }),
    ).toEqual([]);
  });

  test('every declaration keyword is recognised', () => {
    // A keyword missing from the alternation is a silent hole: the name stops
    // being seen on BOTH sides at once, so no scan reddens.
    const kinds = {
      'shared/src/x.ts': [
        'export function fn() {}',
        'export const cn = 1;',
        'export let ln = 1;',
        'export var vn = 1;',
        'export class Cn {}',
        'export type Tn = string;',
        'export interface In { a: 1 }',
        "export enum En { A = 'a' }",
      ].join('\n'),
    };
    const dup = { 'server/src/y.ts': Object.values(kinds)[0] };
    expect(reDeclared(kinds, dup).map((h) => h.name)).toEqual([
      'Cn',
      'En',
      'In',
      'Tn',
      'cn',
      'fn',
      'ln',
      'vn',
    ]);
  });

  test('a flush-left code sample inside a comment is not a declaration', () => {
    // Cebab-6sr. `^` alone is not enough: a JSDoc code block written flush-left
    // — and a commented-out declaration — both sit at column 0. This is the
    // paragraph someone would write in `per_agent_control.ts` to explain WHY
    // the local copies went away, and before the strip it re-created the very
    // violation it was describing.
    const prose = {
      'a.ts': [
        '/**',
        ' * These used to be declared here and now come from shared:',
        "export type KickMode = 'drain' | 'hard';",
        ' */',
        "// export const KICK_MODES = new Set(['drain']);",
      ].join('\n'),
    };
    expect(reDeclared(SHARED_BEFORE, prose)).toEqual([]);
  });

  test('a real declaration in the same file is still flagged', () => {
    // Positive control for the case above: without it, stripping everything
    // would pass, and every scan below would then measure an empty corpus.
    const mixed = {
      'a.ts': [
        '/**',
        "export type KickMode = 'commented';",
        ' */',
        "export type MultiAgentLifecycle = 'persistent' | 'temp';",
      ].join('\n'),
    };
    expect(reDeclared(SHARED_BEFORE, mixed)).toEqual([
      { name: 'MultiAgentLifecycle', shared: 'shared/src/protocol.ts', at: 'a.ts' },
    ]);
  });

  test('an indented declaration is not a module-level export', () => {
    // `^` is load-bearing: a nested `export` inside a `declare module` block
    // is not the module's own surface.
    const nested = { 'a.ts': "  export type KickMode = 'drain';" };
    expect(reDeclared(SHARED_BEFORE, nested)).toEqual([]);
  });

  test('the within-shared half flags a name declared in two shared files', () => {
    const two = {
      'shared/src/protocol.ts': "export type Mode = 'a';",
      'shared/src/mutation.ts': "export type Mode = 'b';",
    };
    expect(ambiguousWithin(two)).toEqual([
      { name: 'Mode', at: 'shared/src/protocol.ts,shared/src/mutation.ts' },
    ]);
  });

  test('the within-shared half does not flag a name declared once', () => {
    expect(
      ambiguousWithin({
        'shared/src/protocol.ts': "export type Mode = 'a';",
        'shared/src/mutation.ts': 'export type Other = 1;',
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// 3. The scan.
// ===========================================================================

describe('shared/ is the one home for the names it declares', () => {
  const shared = collectSources(['shared/src']);
  const outside = collectSources(['server/src', 'web/src']);

  test('the scan reaches all three packages', () => {
    // A walk that found only `shared/src` would pass while comparing it to
    // nothing — the emptiest possible green.
    expect(Object.keys(shared).length).toBeGreaterThan(5);
    expect(Object.keys(outside).length).toBeGreaterThan(200);
    for (const f of ['shared/src/protocol.ts', 'server/src/repo/per_agent_control.ts']) {
      expect({ ...shared, ...outside }, `${f} is not in the scanned set`).toHaveProperty(f);
    }
    // Both non-shared packages, named: a walk that dropped `web/src` would
    // still clear the count above on `server/src` alone.
    expect(Object.keys(outside).some((f) => f.startsWith('server/src/'))).toBe(true);
    expect(Object.keys(outside).some((f) => f.startsWith('web/src/'))).toBe(true);
  });

  test('the corpus is the declarations, not an empty set', () => {
    // 95 / 1039 today. Floors well below survive churn while catching a regex
    // that stopped matching — which would make the scan pass on nothing.
    expect(declarations(shared).size).toBeGreaterThan(60);
    expect(declarations(outside).size).toBeGreaterThan(600);
  });

  test('tests are excluded from the scan', () => {
    // Test files legitimately re-declare fixture types named after the real
    // ones, and this file's own fixtures are verbatim copies of the
    // declarations it forbids.
    expect(Object.keys({ ...shared, ...outside }).filter((f) => f.includes('.test.'))).toEqual([]);
  });

  test('no name declared in shared/src is declared again outside it', () => {
    expect(
      reDeclared(shared, outside),
      'A name declared in `shared/src` is declared again in `server/src` or ' +
        '`web/src`. Two structurally-equal declarations compile and drift ' +
        'silently: consumers bind to whichever they imported, so adding an arm ' +
        'to the wire union leaves the other copy compiling and unable to ' +
        'represent it. Import from `@cebab/shared/protocol` instead, and ' +
        're-export if local consumers need the name (a re-export is one symbol ' +
        'and cannot drift). See `MultiAgentLifecycle` in ' +
        'server/src/repo/multi_agent.ts (register N13).',
    ).toEqual([]);
  });

  test('no name is declared twice within shared/src', () => {
    expect(
      ambiguousWithin(shared),
      '`shared/src/index.ts` re-exports its modules with `export *`. When two ' +
        'of them declare the same name, TypeScript drops it from the star ' +
        'export SILENTLY — no error, the name just stops being importable from ' +
        '`@cebab/shared`. Rename one, or export it explicitly from index.ts.',
    ).toEqual([]);
  });
});

/**
 * Walk the given roots. A directory walk rather than `git ls-files` so the gate
 * runs identically on both CI runners with no subprocess — same approach as
 * `scripts/predicateReturns.test.mjs` and `scripts/configSurfaceClaims.test.mjs`.
 */
function collectSources(roots) {
  const out = {};
  for (const root of roots) walk(root, out);
  return out;
}

function walk(rel, out) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(child, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.')
    ) {
      out[child] = read(child);
    }
  }
}
