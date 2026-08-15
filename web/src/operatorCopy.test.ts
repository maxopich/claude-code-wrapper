import { describe, expect, test } from 'vitest';
import { jsxTextNodes, stripComments } from './sourceScan';

/**
 * What the app says out loud has to be addressed to the person reading it
 * (registers U32, U40).
 *
 * Cebab ships as an application. The person looking at an empty state or a
 * keyboard cheatsheet is an operator running agents — not the person who wrote
 * the file, and usually not someone who can open it. Two strings had forgotten
 * that:
 *
 *   - the authority panel's cache-miss copy named two internal build phases
 *     and an SDK parameter, and then told the operator the Refresh button
 *     "returns the empty cache for now" — which is not what the resolver does;
 *   - the shortcuts modal's footer told the operator to go edit
 *     `web/src/shortcutRegistry.ts`.
 *
 * Both are the same defect: a channel to the operator carrying something
 * addressed to a developer. Fixing two strings fixes two strings; this holds
 * the rule, so the third one fails here instead of shipping.
 *
 * The rule: **no rendered text may name an internal phase or a repository
 * source path.** Two markers, both mechanical, both chosen because they are
 * unambiguously developer vocabulary rather than judgment calls about tone.
 *
 * What this deliberately does NOT do:
 *   - judge whether copy is *good*. Plain-English quality is a review
 *     question; this catches only the objectively-wrong-audience case.
 *   - read interpolated values. `{someVar}` is dropped by `jsxTextNodes`, so a
 *     phase number arriving through a variable slips past. That is a known
 *     miss in the safe direction — the alternative is flagging every prop
 *     value and import path as though it were prose.
 *   - look at comments. `stripComments` runs first, which is what lets this
 *     file's own prose (and the U32/U40 notes left at the fix sites) say
 *     "Phase 3b" without turning the gate red — the exact bug that made
 *     `widgetRoles.test.ts` fail on its own explanation last round.
 */

// Vite's ?raw + glob: every component source as literal text. Test files are
// dropped — a spec asserting on the old copy is not itself operator-facing.
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob(['./**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.tsx')),
);

/** `Phase 3b`, `phase 6`, `Phase  12` — an internal milestone identifier. */
const INTERNAL_PHASE = /\bPhase\s*\d/i;

/** `web/src/foo.ts`, `server/src/bus/runner.ts` — a path into this repository. */
const REPO_PATH = /\b(web|server|shared)\/src\/[\w./-]+/;

type Offence = { file: string; text: string; marker: string };

function scan(): { offences: Offence[]; filesScanned: number; nodesScanned: number } {
  const offences: Offence[] = [];
  let nodesScanned = 0;
  for (const [file, src] of Object.entries(SOURCES)) {
    for (const text of jsxTextNodes(stripComments(src))) {
      nodesScanned++;
      if (INTERNAL_PHASE.test(text)) offences.push({ file, text, marker: 'internal phase' });
      else if (REPO_PATH.test(text)) offences.push({ file, text, marker: 'repository path' });
    }
  }
  return { offences, filesScanned: Object.keys(SOURCES).length, nodesScanned };
}

describe('operator-facing copy', () => {
  // Anti-vacuity, per the "new gates pass vacuously" lesson: a scan that
  // globbed nothing, or whose text extractor returned nothing, would report a
  // clean bill of health while measuring air. Both floors are far below the
  // real numbers and are about catching a broken harness, not about the count.
  test('the scan actually reads the component sources', () => {
    const { filesScanned, nodesScanned } = scan();
    expect(filesScanned).toBeGreaterThan(40);
    expect(nodesScanned).toBeGreaterThan(200);
  });

  test('no rendered text names an internal build phase or a repository path', () => {
    const { offences } = scan();
    expect(
      offences.map((o) => `${o.file}: [${o.marker}] ${o.text.slice(0, 90)}`),
      'operator-facing copy must not address a developer',
    ).toEqual([]);
  });

  // The extractor is the load-bearing part, so it is pinned directly rather
  // than only through the rule above. Without the first two cases the gate
  // would be unusable — every file imports from a `./`-relative path and most
  // pass string props that mention internals.
  describe('jsxTextNodes', () => {
    test('ignores import paths and prop values, reads only rendered text', () => {
      const src = [
        `import { SHORTCUTS } from '../shortcutRegistry';`,
        `const el = <p title="web/src/thing.ts">Files appear here.</p>;`,
      ].join('\n');
      expect(jsxTextNodes(src)).toEqual(['Files appear here.']);
    });

    test('reads text inside a nested element, which is where U40 hid', () => {
      const src = `<p>Edit <code>web/src/shortcutRegistry.ts</code> to add one.</p>`;
      const texts = jsxTextNodes(src);
      expect(texts).toContain('web/src/shortcutRegistry.ts');
      expect(texts.some((t) => REPO_PATH.test(t))).toBe(true);
    });

    test('drops interpolations so a variable name is not mistaken for copy', () => {
      const [text] = jsxTextNodes(`<span>Age {phase3bValue} seconds</span>`);
      // Asserted on content, not on the exact run of whitespace the
      // substitution leaves behind — the point is that the identifier is gone.
      expect(text).not.toContain('phase3bValue');
      expect(text?.replace(/\s+/g, ' ')).toBe('Age seconds');
    });

    test('a phase number in a comment is not rendered text', () => {
      const src = `{/* Phase 3b will spawn a probe */}<p>No snapshot yet.</p>`;
      expect(jsxTextNodes(stripComments(src))).toEqual(['No snapshot yet.']);
    });
  });
});
