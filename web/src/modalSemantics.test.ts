import { describe, expect, test } from 'vitest';

/**
 * Every modal surface declares what it is (register U08).
 *
 * `useModalSurface` gives a hand-rolled overlay the *behaviour* of a dialog —
 * body scroll lock, an `inert` focus trap over every sibling, focus restored
 * on close. What it cannot give it is the *semantics*: a screen reader still
 * announces a bare `<div>` as a generic group, with no boundary and no name,
 * so the operator gets no signal that a modal opened or what it is asking.
 *
 * Fifteen of the eighteen surfaces already declared `role="dialog"`,
 * `aria-modal="true"` and a name. Three did not — the Settings modal (the one
 * the register names), and the "Save as template" + event-detail modals inside
 * `MultiAgentTab`. That is the argument for a gate rather than three edits: the
 * convention was already the house style, and drifting off it cost nothing and
 * was invisible in review.
 *
 * This gate DISCOVERS surfaces rather than listing them, so a modal added
 * tomorrow is covered without anyone remembering to add it here. Discovery is
 * the failure mode to guard against, though — a glob that matches nothing
 * passes every assertion vacuously — so the counts below are asserted, not
 * merely computed.
 *
 * What it does NOT check: that the accessible name is *good*, that the focus
 * trap works (`useModalSurface`'s own concern), or non-modal popovers such as
 * `ParticipantControlMenu`, which are `role="menu"` and never call
 * `useModalSurface`.
 */

// Vite's ?raw + glob: every component source as literal text. `eager` so the
// values are strings, not import thunks. Test files are dropped so a fixture
// string in a spec can't register as a surface.
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob('./components/**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.tsx')),
);

/** Surfaces that may skip the contract, each with a reason. Empty by design —
 *  an entry here is a hole in the gate, so it has to be argued for in review
 *  rather than added quietly. */
const EXEMPT: Array<{ file: string; why: string }> = [];

const REF_ANCHOR = 'ref={overlayRef}';

/**
 * Text of the JSX opening tag that carries `ref={overlayRef}` at `at`.
 *
 * Walks back to the tag's `<` and forward to its closing `>`, ignoring any `>`
 * that sits inside a `{…}` expression. Deliberately not a regex: the repo's
 * eslint bans non-literal ones, and a literal one spanning a multi-line tag is
 * less readable than the scan.
 */
function openingTag(src: string, at: number): string {
  let start = at;
  while (start >= 0 && src[start] !== '<') start--;
  if (start < 0) throw new Error('no opening < before ref={overlayRef}');
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated JSX opening tag');
}

type Surface = { file: string; tag: string };

function discoverSurfaces(): Surface[] {
  const out: Surface[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    if (!src.includes('useModalSurface(')) continue;
    let from = 0;
    for (;;) {
      const at = src.indexOf(REF_ANCHOR, from);
      if (at === -1) break;
      out.push({ file, tag: openingTag(src, at) });
      from = at + REF_ANCHOR.length;
    }
  }
  return out;
}

const surfaces = discoverSurfaces();

describe('modal semantics', () => {
  test('the glob resolved real component sources', () => {
    // A broken glob returns {} and every assertion below would pass over an
    // empty list. Two independent sanity checks: enough files, and a known
    // one among them with plausible content.
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(50);
    const settings = SOURCES['./components/SettingsModal.tsx'];
    expect(settings).toBeDefined();
    expect(settings).toContain('useModalSurface(');
  });

  test('every useModalSurface caller mounts exactly one overlay per call', () => {
    // The gate anchors on `ref={overlayRef}`, so a component that destructured
    // the ref under another name would be silently skipped. Pin the 1:1
    // relationship instead of trusting it.
    const mismatched = Object.entries(SOURCES)
      .map(([file, src]) => ({
        file,
        calls: src.split('useModalSurface(').length - 1,
        refs: src.split(REF_ANCHOR).length - 1,
      }))
      .filter((r) => r.calls > 0 && r.calls !== r.refs);
    expect(mismatched).toEqual([]);
  });

  test('discovery found every known surface', () => {
    // 18 at the time of writing: 17 files, with MultiAgentTab holding two
    // (TemplateNameModal + EventModal). A number that only ever grows — if a
    // future refactor drops below it, that is a surface this gate stopped
    // seeing, not a cleanup.
    expect(surfaces.length).toBeGreaterThanOrEqual(18);
  });

  test('no surface is exempt', () => {
    expect(EXEMPT).toEqual([]);
  });

  test.each(surfaces.map((s, i) => [`${s.file}#${i}`, s] as const))(
    '%s declares role, modality and a name',
    (_label, surface) => {
      expect(surface.tag).toContain('role="dialog"');
      expect(surface.tag).toContain('aria-modal="true"');
      // Either labelling form gives an accessible name; `LogsModal` uses
      // `aria-label` because its heading is a fragment of a longer sentence.
      const named = surface.tag.includes('aria-labelledby=') || surface.tag.includes('aria-label=');
      expect(named).toBe(true);
    },
  );

  test('a labelledby reference points at an id in the same file', () => {
    for (const surface of surfaces) {
      const at = surface.tag.indexOf('aria-labelledby=');
      if (at === -1) continue;
      const src = SOURCES[surface.file]!;
      const value = surface.tag.slice(at + 'aria-labelledby='.length).trimStart();
      // Two forms in this codebase: a literal `"settings-modal-title"` and an
      // expression `{titleId}`. For the literal, the id must appear as
      // `id="…"`; for the expression, as `id={…}` bound to the same name.
      if (value.startsWith('"')) {
        const end = value.indexOf('"', 1);
        expect(src).toContain(`id="${value.slice(1, end)}"`);
      } else {
        const end = value.indexOf('}');
        expect(src).toContain(`id={${value.slice(1, end)}}`);
      }
    }
  });
});
