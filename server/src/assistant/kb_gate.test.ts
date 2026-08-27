// Cebab-8x8.2.3: KB drift gates.
//
// The knowledge base under `assistant/kb/` is downstream of the code it
// documents, so a stale page becomes a confidently wrong answer — worse for a
// user than no assistant at all. This file makes the build fail when the KB
// drifts, in the repo's existing assert-against-source-text family
// (`web/src/styleTokens.test.ts`, `templatePreview/cssGate.test.ts`,
// `vocabularyGate.test.ts`): read the source of truth, scan the docs, fail with
// the offending filename named.
//
// Two kinds of gate live here. STRUCTURE gates keep the routing table honest and
// the pages bounded — internal consistency, no external truth. FRESHNESS gates
// couple a doc to a machine-readable registry the code already carries
// (shortcuts, slash commands, theme gammas), so adding a binding without
// documenting it reddens the build. There is no pre-existing user documentation
// to diff the whole KB against, so we gate only where the code carries
// machine-readable truth, plus internal consistency — that honest scope is the
// point, not a shortcut.
//
// Web source is read as TEXT via `fs`, not imported: `server`'s tsconfig sets
// `rootDir: "src"`, so a direct `import` of `web/src/*.ts` fails typecheck
// (TS6059, file outside rootDir). Regex-scanning the source string is the same
// approach `cssGate.test.ts` already uses and needs no cross-program import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { assistantKbRoot } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/assistant → repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WEB_SRC = path.resolve(REPO_ROOT, 'web', 'src');

const KB_DIR = assistantKbRoot();
const INDEX_FILE = '00-index.md';

// Per-doc codepoint cap. Set well below the prompt composer's truncation
// threshold (MAX 12000 codepoints in `assistant/prompt.ts`, mirroring
// `bus/runtime.ts`'s injected-CLAUDE.md cap) so drift trips CI here, before a
// page is silently truncated in a live turn.
const PER_DOC_CODEPOINT_CAP = 11000;

function readKb(name: string): string {
  return fs.readFileSync(path.join(KB_DIR!, name), 'utf8');
}

/** Lines that are a level-1 ATX heading (`# `), excluding `##`/`###`. */
function h1Lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.startsWith('# '));
}

/** The single H1's text, or throws if there isn't exactly one. */
function soleH1(name: string, text: string): string {
  const lines = h1Lines(text);
  expect(lines.length, `${name} must contain exactly one H1 (\`# \`) line`).toBe(1);
  return lines[0]!.slice(2).trim();
}

/** Markdown links in the index that target a `NN-*.md` KB page. */
function indexLinks(indexText: string): Array<{ text: string; target: string }> {
  const out: Array<{ text: string; target: string }> = [];
  const re = /\[([^\]]+)\]\((\d{2}-[a-z0-9-]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexText)) !== null) {
    out.push({ text: m[1]!, target: m[2]! });
  }
  return out;
}

describe('KB exists', () => {
  test('assistant/kb/ is present on disk (the assistant is only enabled when it is)', () => {
    expect(
      KB_DIR,
      'assistant/kb/ not found — the KB content ships here; assistantKbRoot() returned null',
    ).not.toBeNull();
  });
});

describe('KB structure gates', () => {
  const entries = fs.readdirSync(KB_DIR!, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  const contentFiles = mdFiles.filter((n) => n !== INDEX_FILE).sort();

  test('flat directory — no subdirectories under assistant/kb/', () => {
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs, `assistant/kb/ must be flat; found subdirectories: ${dirs.join(', ')}`).toEqual(
      [],
    );
  });

  test('the router index exists', () => {
    expect(mdFiles).toContain(INDEX_FILE);
  });

  test('bidirectional coverage: every page is linked from the index, no dangling targets', () => {
    const links = indexLinks(readKb(INDEX_FILE));
    const linkedTargets = [...new Set(links.map((l) => l.target))].sort();

    // Every content page must be linked from the index.
    const missingFromIndex = contentFiles.filter((f) => !linkedTargets.includes(f));
    expect(missingFromIndex, 'pages present on disk but not linked from 00-index.md').toEqual([]);

    // Every index link target must exist on disk.
    const danglingTargets = linkedTargets.filter((t) => !contentFiles.includes(t));
    expect(danglingTargets, 'index links pointing at pages that do not exist on disk').toEqual([]);
  });

  test('exactly one H1 per page (index included)', () => {
    const offenders = mdFiles.filter((name) => h1Lines(readKb(name)).length !== 1);
    expect(offenders, 'pages without exactly one `# ` H1 line').toEqual([]);
  });

  test('index link text matches each page H1 (the routing table cannot mislabel a page)', () => {
    const links = indexLinks(readKb(INDEX_FILE));
    const mismatches: string[] = [];
    for (const { text, target } of links) {
      if (!contentFiles.includes(target)) continue; // dangling handled above
      const h1 = soleH1(target, readKb(target));
      if (h1 !== text) mismatches.push(`${target}: index says "${text}", H1 is "${h1}"`);
    }
    expect(mismatches, 'index link text disagreeing with the page H1').toEqual([]);
  });

  test(`each page stays under the ${PER_DOC_CODEPOINT_CAP}-codepoint cap`, () => {
    const tooBig = mdFiles
      .map((name) => ({ name, len: [...readKb(name)].length }))
      .filter((f) => f.len >= PER_DOC_CODEPOINT_CAP)
      .map((f) => `${f.name} (${f.len})`);
    expect(tooBig, `pages at or above the ${PER_DOC_CODEPOINT_CAP}-codepoint cap`).toEqual([]);
  });
});

describe('KB freshness gates (coupled to code)', () => {
  test('every shortcut id in shortcutRegistry.ts is documented', () => {
    const src = fs.readFileSync(path.join(WEB_SRC, 'shortcutRegistry.ts'), 'utf8');
    const ids = [...src.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(
      ids.length,
      'sanity: shortcut id scan found too few ids — regex likely stale',
    ).toBeGreaterThanOrEqual(5);
    const doc = readKb('13-shortcuts-and-commands.md');
    const undocumented = ids.filter((id) => !doc.includes(id));
    expect(undocumented, 'shortcut ids missing from 13-shortcuts-and-commands.md').toEqual([]);
  });

  test('every slash command in slashCommands.ts is documented', () => {
    const src = fs.readFileSync(path.join(WEB_SRC, 'slashCommands.ts'), 'utf8');
    const commands = [...src.matchAll(/command:\s*'(\/[^']+)'/g)].map((m) => m[1]!);
    expect(
      commands.length,
      'sanity: slash-command scan found too few commands — regex likely stale',
    ).toBeGreaterThanOrEqual(3);
    const doc = readKb('13-shortcuts-and-commands.md');
    const undocumented = commands.filter((c) => !doc.includes(c));
    expect(undocumented, 'slash commands missing from 13-shortcuts-and-commands.md').toEqual([]);
  });

  test('every [data-theme] gamma in styles.css is documented', () => {
    const src = fs.readFileSync(path.join(WEB_SRC, 'styles.css'), 'utf8');
    const themes = [...new Set([...src.matchAll(/\[data-theme='([^']+)'\]/g)].map((m) => m[1]!))];
    expect(
      themes.length,
      'sanity: no [data-theme] gammas found — regex likely stale',
    ).toBeGreaterThanOrEqual(1);
    // Theme names appear capitalized in prose (e.g. "Aurora"); match
    // case-insensitively so the doc reads naturally.
    const doc = readKb('12-settings-storage-and-data.md').toLowerCase();
    const undocumented = themes.filter((t) => !doc.includes(t.toLowerCase()));
    expect(undocumented, 'theme gammas missing from 12-settings-storage-and-data.md').toEqual([]);
  });
});
