import { describe, expect, test } from 'vitest';
// Vite's ?raw suffix returns the file contents as a string at build time
// (declared in vite-env.d.ts). No Node fs dependency — runs in jsdom.
import stylesCss from './styles.css?raw';

/**
 * Design-migration guard (redesign → prod, Phase 0).
 *
 * Two obligations this file locks in:
 *
 *  1. NO baked AI-purple. The redesign — and prod's own token doc
 *     (styles.css `:root` comment: "move away from AI purple") — bans
 *     violet/purple as an interactive/decorative hue. ~17 sites had a
 *     hard-coded `rgba(139, 92, 246, …)` that (a) violated that rule and
 *     (b) would NOT re-theme once the four `[data-theme]` gammas land,
 *     because a literal ignores the token cascade. Phase 0 rewrote each
 *     to `color-mix(in srgb, var(--accent) N%, transparent)` so the
 *     selection/active/focus highlights follow the per-theme accent.
 *     This test fails the build if a purple literal ever comes back.
 *
 *  2. Theme parity (added in Phase 1 below) — every `[data-theme]` gamma
 *     must fill the identical token-name contract, so no theme silently
 *     drops a token and falls back to an inherited (wrong-gamma) value.
 *     The parity assertion is inert until ≥2 theme blocks exist; it goes
 *     live the moment Phase 1 adds them, in the same file.
 */

/** Strip `/* … *\/` comments so documentation prose that *names* a
 *  banned color (e.g. the "move away from AI purple" note) can't trip the
 *  literal scanners below. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Purple/violet in the forms it actually appeared (or could reappear):
// the exact rgba triple, plus the common Tailwind-ish violet hexes.
const PURPLE_RGB = /rgba?\(\s*139\s*,\s*92\s*,\s*246/i;
const PURPLE_HEX = /#(?:8b5cf6|a78bfa|7c3aed|6d28d9|c4b5fd|ddd6fe)\b/i;

describe('style tokens — no baked AI-purple', () => {
  const body = stripComments(stylesCss);

  test('no rgba(139, 92, 246, …) literal survives', () => {
    expect(body).not.toMatch(PURPLE_RGB);
  });

  test('no violet hex literal (#8b5cf6 & friends)', () => {
    expect(body).not.toMatch(PURPLE_HEX);
  });

  test('the de-purpled highlights now resolve through var(--accent)', () => {
    // Positive lock: the rewrite routed the old purple highlights through
    // the accent token via color-mix. If someone re-hardcodes a color
    // here, this disappears and the test fails — catching a silent
    // regression that the negative scanners above might miss.
    expect(body).toMatch(/color-mix\(in srgb, var\(--accent\)\s+\d/);
  });
});

/**
 * ── Theme parity (Phase 1 target) ─────────────────────────────────────
 * Parses every `[data-theme='…']` block and asserts they declare the
 * same set of custom-property names. Inert (vacuously true) until the
 * gammas land, so Phase 0 stays green; becomes a hard gate in Phase 1.
 */
const EXPECTED_THEMES = ['aurora', 'daylight', 'slate', 'phosphor'] as const;

/** Extract `[data-theme='NAME'] { … }` blocks → { name: Set<--token> }.
 *  Balanced-brace scan from each opener (theme blocks are flat — a
 *  requirement kept for templatePreview/cssGate.test.ts's flat-rule
 *  regex — so a single-level body match is sufficient). */
function parseThemeBlocks(css: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const openRe = /\[data-theme=['"]([a-z]+)['"]\]\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(css)) !== null) {
    const name = m[1]!;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const inner = css.slice(start, i - 1);
    const tokens = new Set<string>();
    for (const t of inner.matchAll(/(--[a-z0-9-]+)\s*:/gi)) tokens.add(t[1]!);
    out[name] = tokens;
  }
  return out;
}

describe('style tokens — theme parity', () => {
  const blocks = parseThemeBlocks(stripComments(stylesCss));
  const names = Object.keys(blocks);

  test('every declared gamma fills the identical token contract', () => {
    if (names.length < 2) return; // inert until Phase 1 adds the gammas
    const reference = blocks[names[0]!]!;
    for (const name of names.slice(1)) {
      const set = blocks[name]!;
      const missing = [...reference].filter((t) => !set.has(t));
      const extra = [...set].filter((t) => !reference.has(t));
      expect({ theme: name, missing, extra }).toEqual({ theme: name, missing: [], extra: [] });
    }
  });

  test('all four gammas are present once any theme block exists', () => {
    if (names.length === 0) return; // inert until Phase 1
    for (const t of EXPECTED_THEMES) expect(names).toContain(t);
  });
});
