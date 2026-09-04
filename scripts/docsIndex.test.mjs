/**
 * `docs/README.md` must list every page that ships, and list nothing else.
 *
 * The instruction already exists — "Link it from the table above, and from the
 * module it describes" — and nothing enforced it. A page added and never linked
 * is a page nobody opens, which `docs/README.md` itself calls "the same as not
 * writing it"; a link to a page that left is a 404 for whoever followed it.
 * Modelled on `server/src/assistant/kb_gate.test.ts`, which does this for the
 * assistant's knowledge base.
 *
 * THE CORPUS IS THE TRACKED SET, NOT THE DIRECTORY, and that is the whole
 * subtlety. `docs/` holds pages that are gitignored and present only on this
 * machine — the loop's two specs and the Beads workflow note. Measured
 * 2026-09-04, in the primary checkout: eight `.md` files on disk, five
 * tracked. A `readdirSync` walk would demand the index link three files CI has
 * never seen, so it would fail for every developer and pass on CI — the split
 * that teaches people to ignore a gate, which `.prettierignore` records this
 * repo paying for once already.
 *
 * That deviates from `busSafetyClaims.test.mjs`, which walks the directory
 * deliberately "so the gate runs identically on both CI runners and needs no
 * subprocess". The difference is what each is asking. That one asks "does any
 * file in the tree carry a superseded claim", where an extra local file is
 * harmless. This one asks "does the shipped index match the shipped pages",
 * and the answer is wrong unless the corpus is what ships.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'README.md';

/** Tracked `docs/*.md`, index excluded. Sorted for a stable failure message. */
function trackedPages() {
  // `git` is a hard prerequisite of every path that runs this suite (CI clones,
  // developers clone), unlike the unhoisted transitives other gates avoid.
  const out = execFileSync('git', ['ls-files', 'docs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('docs/') && l.endsWith('.md'))
    .map((l) => l.slice('docs/'.length))
    .filter((n) => !n.includes('/') && n !== INDEX)
    .sort();
}

/**
 * Markdown link targets in the index that point at a sibling page.
 *
 * The link body is captured whole and filtered in JS rather than shaped by the
 * pattern. A `([^)#]+?\.md)` form describes this exactly and is ambiguous —
 * `[^)#]` matches `.`, so the lazy repetition and the literal suffix compete —
 * which `security/detect-unsafe-regex` flags, correctly.
 */
function indexLinkTargets() {
  const src = fs.readFileSync(path.join(repoRoot, 'docs', INDEX), 'utf8');
  const targets = [...src.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1].split('#')[0])
    .filter((t) => t.endsWith('.md') && !/^https?:/.test(t));
  return [...new Set(targets.filter((t) => !t.includes('/')))].sort();
}

describe('docs/README.md is a true index', () => {
  const pages = trackedPages();
  const linked = indexLinkTargets();

  test('the corpus is real — anti-vacuity', () => {
    // Both assertions below are "these two lists agree". Two empty lists agree,
    // and would if `git ls-files` failed or the link regex stopped matching. So
    // pin that each side actually found something, and name a page that must be
    // in range either way.
    expect(pages.length, 'no tracked docs/*.md pages found').toBeGreaterThan(2);
    expect(linked.length, 'no sibling links found in docs/README.md').toBeGreaterThan(2);
    expect(pages).toContain('safety-and-security.md');
  });

  test('every shipped page is linked from the index', () => {
    expect(pages.filter((p) => !linked.includes(p))).toEqual([]);
  });

  test('every index link points at a page that ships', () => {
    // Catches the other direction: a page removed, or made local-only, while
    // the index kept pointing at it. A reader following that link gets a 404 on
    // GitHub with nothing to say the page was deliberately withdrawn.
    expect(linked.filter((l) => !pages.includes(l))).toEqual([]);
  });

  test('exactly one H1 per page, so the index can name it', () => {
    const offenders = [INDEX, ...pages].filter(
      (name) =>
        fs
          .readFileSync(path.join(repoRoot, 'docs', name), 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.startsWith('# ')).length !== 1,
    );
    expect(offenders).toEqual([]);
  });
});
