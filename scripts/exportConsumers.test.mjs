/**
 * [security] Every export in a watched module is either LIVE or knowingly not.
 *
 * WHAT THIS IS FOR. An export with no caller is ambiguous in a way a grep
 * cannot resolve: it is either dead code, or it is *preventive* — machinery
 * whose whole job is to be there when something new arrives. This repo has both
 * kinds sitting next to each other, and telling them apart wrong is expensive
 * in both directions:
 *
 *   - `cebab-bus-spawn-non-literal` (register C07) was filed as a dead semgrep
 *     rule. It matches nothing because the directory it guards legitimately has
 *     no spawn sites. Deleting it would have removed the guard.
 *   - `cebab-writeInboxMessage-unhandled` (register X09) looked identical and
 *     WAS dead — its target symbol had been deleted months earlier while
 *     SECURITY.md went on counting it as live coverage.
 *
 * A 1 Aug 2026 sweep filed five of these at once (N06, N07, N10, N11, N12) and
 * proposed deleting most of them. Measured: three were not dead, and two of the
 * proposed fixes would have broken something —
 *
 *   - N12 `breakpoints.ts`: "entire module unimported, delete it". `SHELL` has a
 *     runtime caller, and the other four exports are the input to a
 *     bidirectional stylesheet gate. Deleting them deletes the gate.
 *   - N06 `tokens.ts`: "import it in the layout module". The table had drifted
 *     from the layout it claimed to mirror, so importing it would have silently
 *     restyled the diagram. (That export is now gone — unread AND wrong.)
 *   - N10 `probeIsMuted`: filed as "only the test imports it". Nothing imported
 *     it. A tripwire wired to nothing, deleted.
 *
 * So the gate does not try to answer "is this dead?" — it makes the answer a
 * RECORDED DECISION. Every export of a watched module must be declared `'live'`
 * (and then actually have a non-test importer) or carry a written reason for
 * having none. An undeclared export fails with "decide which it is". Same
 * posture as the `nosemgrep` waivers in `scripts/predev-server.mjs` and the file
 * allowlist in `scripts/busSafetyClaims.test.mjs`: where a checker cannot judge,
 * make a human judge once, in writing.
 *
 * SCOPED TO A DECLARED LIST, NOT THE WHOLE TREE, on purpose. A repo-wide
 * unused-export scan is a different project, and an allowlist of dozens
 * invented in one sitting is exactly the silently-incomplete artifact this repo
 * keeps rediscovering. WATCHED holds modules whose headers make a claim about
 * who reads them — those are the ones that can lie.
 *
 * Parsing is line-oriented rather than via the TypeScript compiler API: `tsc`
 * is a devDependency of the workspaces, not the root, so importing it here
 * works locally and breaks on a clean `npm ci`. Same choice, same reason, as
 * `scripts/semgrepRules.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file with CRLF normalised away (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Watched modules → per-export verdict.
 *
 *   'live'            must have at least one importer that is not a test file
 *   { reason: '…' }   knowingly has none, and why
 *
 * Type-only exports are excluded by the scanner (a type has no runtime
 * consumer to find, and `import type` sites are not what this gate is about).
 */
const WATCHED = new Map([
  [
    'web/src/breakpoints.ts',
    {
      SHELL: 'live',
      BUFFERED: { reason: 'input to breakpoints.test.ts, the stylesheet gate (U24)' },
      EXACT: { reason: 'input to breakpoints.test.ts, the stylesheet gate (U24)' },
      ULTRAWIDE_CAP: { reason: 'input to breakpoints.test.ts, the stylesheet gate (U24)' },
      mqBelow: { reason: 'input to breakpoints.test.ts; @media cannot read a custom property' },
    },
  ],
  [
    'web/src/featureFlags.ts',
    {
      ENABLE_CUSTOM_MODE_PICKER: {
        reason: 'staged opt-in for the unshipped custom-mode picker; deliberate (N11)',
      },
      FEATURE_ARTIFACT_DIFF_V2: 'live',
    },
  ],
  ['web/src/components/templatePreview/tokens.ts', { TPL_FS_UNDER_BADGE: 'live' }],
  [
    'shared/src/topology.ts',
    {
      validateCustomTopology: {
        reason: 'validator awaiting the custom-mode editor; tested, uncalled by design (N07)',
      },
      validateTemplateTopology: { reason: 'ditto — the thin wrapper over the above' },
    },
  ],
]);

/**
 * Test files are not consumers for this gate's purposes.
 *
 * This used to end `|| rel.endsWith('.security.test.ts')`, which never ran: the
 * regex above already matches `….security.test.ts` (it ends `.test.ts`). A
 * disjunct that cannot fire reads as a second rule and is really a comment, and
 * the next person adjusting the regex would have trusted a guard that was not
 * there.
 */
function isTestFile(rel) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/**
 * Value exports declared by a module, in file order.
 *
 * `export type` / `export interface` are skipped: a type has no runtime
 * consumer for this gate to look for. `export * from` is skipped too — it
 * re-exports someone else's names, which are that module's problem.
 */
const DECLARERS = new Set(['const', 'let', 'function', 'class']);

export function declaredValueExports(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (!line.startsWith('export ')) continue;
    // Tokenised rather than one regex: the natural pattern here
    // (`^export\s+(?:async\s+)?(?:const|…)\s+`) trips eslint's
    // `security/detect-unsafe-regex` on its adjacent `\s+` runs, and the repo
    // lints at --max-warnings 0. Splitting is also easier to read.
    const words = line.slice('export '.length).trim().split(/\s+/);
    let i = words[0] === 'async' ? 1 : 0;
    if (!DECLARERS.has(words[i])) continue;
    const name = /^[A-Za-z_$][\w$]*/.exec(words[i + 1] ?? '')?.[0];
    if (name) out.push(name);
  }
  return out;
}

/**
 * Does `importerSrc` import `name` from a module whose specifier ends in
 * `moduleBase`?
 *
 * Matches the whole `import { … } from '…'` clause including multi-line ones,
 * which is the common formatting for a long list — a single-line matcher would
 * silently miss every prettier-wrapped import and report live code as dead.
 */
export function importsName(importerSrc, moduleBase, name) {
  for (const m of importerSrc.matchAll(/\{([^{}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    // Keep only `import { … } from`, not `export { … } from`: a re-export
    // forwards the name onward, it does not consume it. Checked by inspecting
    // the text before the brace rather than folding the keyword into the
    // pattern, which trips eslint's unsafe-regex rule.
    const head = importerSrc.slice(Math.max(0, m.index - 24), m.index).trimEnd();
    if (!head.endsWith('import') && !head.endsWith('import type')) continue;

    const specBase = m[2].replace(/\.js$/, '').split('/').pop();
    if (specBase !== moduleBase) continue;
    const listed = m[1].split(',').map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    );
    if (listed.includes(name)) return true;
  }
  return false;
}

/** Every source file the scan considers a possible importer. */
function collectSources() {
  const out = [];
  for (const root of ['web/src', 'shared/src', 'server/src', 'scripts']) walk(root, out);
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
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(child);
    }
  }
}

// ===========================================================================
// Anti-vacuity: the scanner must work on inputs the tree cannot influence.
// ===========================================================================

describe('[security] the export/import scanner itself', () => {
  test('finds value exports and skips type-only ones', () => {
    const src = [
      'export const A = 1;',
      'export function b() {}',
      'export class C {}',
      'export async function d() {}',
      'export type T = string;',
      'export interface I { x: number }',
      'export * from "./other.js";',
      '  export const notAtLineStart = 2;',
    ].join('\n');
    expect(declaredValueExports(src)).toEqual(['A', 'b', 'C', 'd']);
  });

  test('matches an import across the line wrap prettier introduces', () => {
    const wrapped = "import {\n  BUFFERED,\n  mqBelow,\n} from './breakpoints.js';";
    expect(importsName(wrapped, 'breakpoints', 'mqBelow')).toBe(true);
    expect(importsName(wrapped, 'breakpoints', 'SHELL')).toBe(false);
  });

  test('honours the module specifier, not just the name', () => {
    const src = "import { SHELL } from './somewhereElse.js';";
    expect(importsName(src, 'breakpoints', 'SHELL')).toBe(false);
  });

  test('sees through a renaming import', () => {
    const src = "import { SHELL as TIERS } from './breakpoints';";
    expect(importsName(src, 'breakpoints', 'SHELL')).toBe(true);
  });

  test('classifies test files as non-consumers', () => {
    expect(isTestFile('web/src/breakpoints.test.ts')).toBe(true);
    expect(isTestFile('server/src/ws/upgrade_gate.security.test.ts')).toBe(true);
    expect(isTestFile('web/src/breakpoints.ts')).toBe(false);
  });
});

// ===========================================================================
// The scan.
// ===========================================================================

describe('[security] watched exports are live or knowingly not', () => {
  const sources = collectSources();

  test('the scan reaches the tree', () => {
    // Without this, an empty file list makes every assertion below pass while
    // measuring nothing — `project_gates_pass_vacuously`.
    expect(sources.length).toBeGreaterThan(200);
    expect(sources).toContain('web/src/App.tsx');
  });

  /** Non-test files that import `name` from `moduleRel`. */
  function liveImporters(moduleRel, name) {
    const base = path.basename(moduleRel).replace(/\.[cm]?[jt]sx?$/, '');
    return sources.filter(
      (rel) => rel !== moduleRel && !isTestFile(rel) && importsName(read(rel), base, name),
    );
  }

  // Positive controls against the REAL tree, both verdicts. If the resolver
  // silently answered "no importers" for everything, the `'live'` case here
  // fails; if it answered "yes" for everything, the reason case fails.
  test('resolver control — SHELL is live via App.tsx, BUFFERED is not', () => {
    expect(liveImporters('web/src/breakpoints.ts', 'SHELL')).toContain('web/src/App.tsx');
    expect(liveImporters('web/src/breakpoints.ts', 'BUFFERED')).toEqual([]);
  });

  for (const [moduleRel, verdicts] of WATCHED) {
    describe(moduleRel, () => {
      const declared = declaredValueExports(read(moduleRel));

      test('every export carries a recorded verdict', () => {
        const undeclared = declared.filter((name) => !(name in verdicts));
        expect(
          undeclared,
          `New export(s) in a watched module. Decide which it is and record it in ` +
            `WATCHED: 'live' if something outside a test imports it, or ` +
            `{ reason: '…' } if nothing does and that is intended. An export ` +
            `nothing reads is not automatically dead — see this file's header.`,
        ).toEqual([]);
      });

      test('no verdict names an export that no longer exists', () => {
        // The mirror direction. Without it, deleting an export leaves its
        // verdict behind and the map slowly becomes fiction.
        const stale = Object.keys(verdicts).filter((name) => !declared.includes(name));
        expect(stale).toEqual([]);
      });

      for (const [name, verdict] of Object.entries(verdicts)) {
        if (verdict === 'live') {
          test(`${name} — declared live, and something outside a test imports it`, () => {
            expect(liveImporters(moduleRel, name)).not.toEqual([]);
          });
        } else {
          test(`${name} — declared consumer-less, and still is`, () => {
            // If this goes red, the export gained a real caller: good news, and
            // the fix is to flip the verdict to 'live'.
            expect(liveImporters(moduleRel, name)).toEqual([]);
            expect(verdict.reason.length).toBeGreaterThan(20);
          });
        }
      }
    });
  }
});
