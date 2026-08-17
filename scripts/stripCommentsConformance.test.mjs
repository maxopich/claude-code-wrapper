/**
 * The three `stripComments` copies must behave identically.
 *
 * WHY THREE COPIES AT ALL. A source-derived gate's first step is always the
 * same — remove the prose, so the scan counts code. This repo needs that step
 * in three programs that cannot import each other:
 *
 *   - `web/src/sourceScan.ts` — `web/tsconfig.json` sets `types: []`, enforced
 *     by `web/src/nodeTypeIsolation.test.ts`, so the web program has no Node
 *     types and nothing outside `web/src` belongs in it.
 *   - `server/src/test_support/strip_comments.ts` — `server/tsconfig.json` sets
 *     `rootDir: src` with no `allowJs`. Importing the `.mjs` below from a
 *     server test fails `npm run typecheck` with `TS7016: Could not find a
 *     declaration file`. Measured before this file was written, not assumed.
 *   - `scripts/lib/strip_comments.mjs` — for the `scripts/*.test.mjs` gates.
 *
 * WHY THIS FILE EXISTS. A comment saying "keep these in sync" is not a
 * mechanism; four hand-rolled copies is how the repo arrived at Cebab-1px in
 * the first place. Copies are only safe when divergence FAILS. Every case below
 * runs against all three, so fixing a bug in one and not the others is red.
 *
 * A vitest `.test.mjs` can import a workspace `.ts` module (vitest transforms
 * it) — that is what lets one file reach all three. Probed before relying on it.
 *
 * The fixture table is the real asset: it is the accumulated bug history of
 * this function, and each entry names the failure it pins.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments as scriptsStrip } from './lib/strip_comments.mjs';
import { stripComments as webStrip } from '../web/src/sourceScan.ts';
import { stripComments as serverStrip } from '../server/src/test_support/strip_comments.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IMPLEMENTATIONS = [
  ['scripts/lib/strip_comments.mjs', scriptsStrip],
  ['web/src/sourceScan.ts', webStrip],
  ['server/src/test_support/strip_comments.ts', serverStrip],
];

/**
 * Each case: [name, input, expected].
 *
 * `expected` is written out in full rather than compared between
 * implementations only. Three copies agreeing on the WRONG answer is the
 * failure this file exists to catch — a pure cross-comparison would have passed
 * on all four of the pre-fix copies, since they shared the bug.
 */
const CASES = [
  [
    'the phantom-block bug, verbatim from SlashCommandsList.tsx:16 (Cebab-1px)',
    '//   - per-project `.claude/commands/*.md` (when settingSources includes\nexport function SlashCommandsList() {',
    '\nexport function SlashCommandsList() {',
  ],
  [
    'a line comment naming a block opener does not swallow the rest of the file',
    '// see /* this\nconst a = 1;\nconst b = 2;',
    '\nconst a = 1;\nconst b = 2;',
  ],
  [
    'a real block comment is still removed',
    '/* prose\n * more prose\n */\nconst a = 1;',
    '\n\n\nconst a = 1;',
  ],
  [
    'a real trailing line comment is removed, code before it kept',
    'const a = 1; // why',
    'const a = 1; ',
  ],
  [
    'a URL in a string is not a comment',
    "const u = 'https://example.invalid/x';",
    "const u = 'https://example.invalid/x';",
  ],
  [
    'an inline block comment leaves the code either side of it',
    'const a = /* mid */ 1;',
    'const a =  1;',
  ],
  [
    'line numbering survives: comments blank, they do not vanish',
    '// one\n// two\nconst a = 1;',
    '\n\nconst a = 1;',
  ],
  [
    'a block opened and closed across lines blanks only the comment',
    'const a = 1; /* start\nmiddle\nend */ const b = 2;',
    'const a = 1; \n\n const b = 2;',
  ],
  [
    'a block comment containing // is not reopened as a line comment',
    '/* http://x\n   still comment */\nconst a = 1;',
    '\n\nconst a = 1;',
  ],
  ['the JSX braced comment form', '<div>\n  {/* note */}\n</div>', '<div>\n  {}\n</div>'],
  [
    'an unterminated real block comment blanks to end of input',
    'const a = 1;\n/* opened and never closed\nconst b = 2;',
    'const a = 1;\n\n',
  ],
  [
    'no comments at all is the identity',
    'const a = 1;\nconst b = 2;',
    'const a = 1;\nconst b = 2;',
  ],
  ['empty input', '', ''],
];

describe('every stripComments copy behaves identically', () => {
  for (const [name, input, expected] of CASES) {
    test.each(IMPLEMENTATIONS)(`%s — ${name}`, (_label, strip) => {
      expect(strip(input)).toBe(expected);
    });
  }

  test('line count is always preserved, on every case, by every copy', () => {
    // Separate from the table because it is a property, not an example: a
    // caller reporting `i + 1` as a file line depends on it, and a future
    // "tidy up blank lines" would break every such message silently.
    for (const [name, input] of CASES) {
      for (const [label, strip] of IMPLEMENTATIONS) {
        expect(strip(input).split('\n').length, `${label} on: ${name}`).toBe(
          input.split('\n').length,
        );
      }
    }
  });
});

describe('the copies agree on the real tree, not only on fixtures', () => {
  // A fixture table is written by one person on one afternoon. This runs all
  // three over every file the gates actually scan, which is the corpus that
  // found Cebab-1px in the first place.
  const files = [];
  for (const root of ['web/src', 'server/src', 'shared/src', 'scripts']) {
    walk(root, files);
  }

  test('the corpus is real (anti-vacuity floor)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('web/src/components/authority/SlashCommandsList.tsx');
  });

  test('all three produce byte-identical output for every scanned file', () => {
    const disagreements = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
      const [first, ...rest] = IMPLEMENTATIONS.map(([label, strip]) => [label, strip(src)]);
      for (const [label, out] of rest) {
        if (out !== first[1]) disagreements.push(`${rel}: ${label} differs from ${first[0]}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test('no scanned file strips to nothing — the shape Cebab-1px took', () => {
    // The regression that matters, stated as a property of the corpus rather
    // than of one file. A file whose every line is a comment would be a
    // legitimate empty result, so the floor is on files with real code in them.
    const erased = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
      const hasCode = src.split('\n').some((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      });
      if (hasCode && scriptsStrip(src).trim() === '') erased.push(rel);
    }
    expect(
      erased,
      'stripComments erased a file that contains code. This is Cebab-1px: a ' +
        'block-comment opener inside a line comment. The gates that run this ' +
        'first now see nothing in these files.',
    ).toEqual([]);
  });

  test('SlashCommandsList.tsx specifically survives, with its JSX copy intact', () => {
    // Named rather than left to the property above, because it is the file the
    // bug was found on and a corpus-wide assertion can pass while the one file
    // that proves the point has been renamed out of range.
    const src = fs.readFileSync(
      path.join(repoRoot, 'web/src/components/authority/SlashCommandsList.tsx'),
      'utf8',
    );
    const stripped = scriptsStrip(src);
    expect(stripped).toContain('No slash commands resolved by the SDK');
    // And the prose around it is still gone — otherwise "return the input"
    // passes the line above.
    expect(stripped).not.toContain('plugin-contributed commands');
    expect(stripped).not.toContain('Render contract');
  });
});

function walk(rel, out) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(child, out);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      out.push(child);
    }
  }
}
