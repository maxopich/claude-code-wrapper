import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import { THEME_META, THEMES } from './theme.js';
import {
  AA_NORMAL_TEXT,
  composite,
  contrastRatio,
  parseColor,
  parseThemeBlocks,
  resolveColor,
  resolveVar,
  splitTopLevel,
  type Rgba,
} from './cssColor.js';

/**
 * Contrast gate for the four `[data-theme]` gammas.
 *
 * `styleTokens.test.ts` already asserts every gamma declares the same token
 * NAMES, so no theme silently inherits a wrong-gamma value. Nothing asserted
 * anything about the values themselves, and the palette drifted under that
 * blind spot: `--fg-3` was below WCAG AA as text in all four gammas
 * (2.54–3.22:1 against the worst surface it lands on, at ~83 `color:` sites,
 * many of them 10px), daylight's `--accent` gave 4.31:1 under white on every
 * primary button, and the MOCK badge's second stripe sat at 1.16:1.
 *
 * WHAT THIS COVERS — read this before trusting it. The pairs are enumerated
 * below by hand, not discovered by crawling the stylesheet. Auto-discovery
 * across ~2,570 `var()` references would mostly emit false positives (a
 * token used as a border, a fill, a glow), and a gate that cries wolf gets
 * deleted. So the guarantee is exactly: *these listed pairings clear AA in
 * all four gammas*. It is not "the app is AA conformant".
 *
 * KNOWN RESIDUAL, deliberately not claimed here: the semantic inks
 * (`--warn`, `--err`, `--ok`, `--info`) are still used as text directly on a
 * panel at roughly sixty sites, where they measure 2.4–3.4:1. The two banner
 * families that register U06 named were moved onto `--fg-1` and are gated
 * below; the rest is a separate, larger change and has its own bead. Naming
 * it here rather than quietly excluding it is the point — an instrument that
 * overstates its own coverage is the defect this file exists to catch.
 */

/** Surfaces that body text actually sits on, worst-case across all of them.
 *  In the light gammas the darkest of these binds; in the dark gammas the
 *  lightest does (slate's `--raised` is the real constraint, not `--panel` —
 *  which is why measuring against `--panel` alone under-reported every
 *  finding in the register by 0.3–0.6). */
const TEXT_SURFACES = ['--bg', '--panel', '--panel-2', '--raised'] as const;

/** The ink ramp, strongest first. */
const INK_RAMP = ['--fg-0', '--fg-1', '--fg-2', '--fg-3'] as const;

const blocks = parseThemeBlocks(stylesCss);
const WHITE = parseColor('#ffffff');

/** Lowest contrast `ink` reaches across every surface, with the surface named
 *  so a failure message points at the pair that broke rather than a number. */
function worstSurface(theme: string, ink: Rgba): { ratio: number; surface: string } {
  let worst = { ratio: Infinity, surface: '' };
  for (const s of TEXT_SURFACES) {
    const ratio = contrastRatio(ink, resolveColor(blocks[theme]!, s));
    if (ratio < worst.ratio) worst = { ratio, surface: s };
  }
  return worst;
}

/** A translucent tint painted over a gamma's panel, the way a browser would. */
function tintOverPanel(theme: string, token: string): Rgba {
  return composite(resolveColor(blocks[theme]!, token), resolveColor(blocks[theme]!, '--panel'));
}

/** Body of the first rule whose selector matches exactly, balanced-brace. */
function ruleBody(selector: string): string {
  const i = stylesCss.indexOf(`\n${selector} {`);
  if (i === -1) throw new Error(`rule not found: ${selector}`);
  const start = stylesCss.indexOf('{', i) + 1;
  let depth = 1;
  let j = start;
  while (j < stylesCss.length && depth > 0) {
    if (stylesCss[j] === '{') depth++;
    else if (stylesCss[j] === '}') depth--;
    j++;
  }
  return stylesCss.slice(start, j - 1);
}

/** Value of one declaration in a rule body, to the `;` at paren depth 0.
 *  Scoping to a single property matters: `.mock-badge` names `--err` in its
 *  border and its text-shadow as well as in the gradient, and measuring
 *  those as if they were text backdrops is how the first draft of this gate
 *  "found" a failure in a 1px border. */
function declaration(body: string, prop: string): string {
  // Scanned rather than built into a RegExp: a constructed pattern here trips
  // eslint's security/detect-non-literal-regexp, and the boundary rules are
  // clearer written out anyway — `color` must not match inside
  // `border-color`, and `background` must not match `background-clip`.
  let at = -1;
  for (let k = body.indexOf(prop); k !== -1; k = body.indexOf(prop, k + 1)) {
    const before = k === 0 ? '{' : body[k - 1]!;
    if (!';{ \n\t'.includes(before)) continue;
    let j = k + prop.length;
    while (j < body.length && (body[j] === ' ' || body[j] === '\t')) j++;
    if (body[j] !== ':') continue;
    at = j + 1;
    break;
  }
  if (at === -1) throw new Error(`declaration not found: ${prop}`);
  let i = at;
  const start = i;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) break;
    i++;
  }
  return body.slice(start, i).trim();
}

/**
 * Colour stops of a `*-gradient(…)` value, in declaration order.
 *
 * Deliberately form-agnostic. The first draft only collected `color-mix(…)`
 * literals, which meant that reverting the gradient to the shipped
 * `var(--err) / var(--err-soft)` version produced an EMPTY stop list — and
 * the per-theme cases below then iterated over nothing and passed. A gate
 * that goes quiet exactly when the bug comes back is worse than no gate, so
 * this reads whatever colour each stop is written as.
 */
function gradientStops(value: string): string[] {
  const open = value.indexOf('(');
  const args = splitTopLevel(value.slice(open + 1, value.lastIndexOf(')')));
  return (
    args
      .map((a) => a.trim())
      // Drop the direction/angle argument; keep anything that names a colour.
      .filter((a) => !/^(to\s|[\d.]+deg$|[\d.]+turn$)/.test(a))
      // Strip the trailing length stops ("… 0 6px", "… 6px 12px").
      .map((a) => {
        let s = a;
        for (;;) {
          const next = s.replace(/\s+-?[\d.]+(px|%|em|rem|vh|vw)?$/, '');
          if (next === s) return s.trim();
          s = next;
        }
      })
      .filter((a) => a !== '')
  );
}

describe('[a11y] theme contrast — the ink ramp', () => {
  test.each(THEMES)('%s: every ink tier clears AA on every text surface', (theme) => {
    const measured = INK_RAMP.map((token) => {
      const w = worstSurface(theme, resolveColor(blocks[theme]!, token));
      return { token, ratio: Number(w.ratio.toFixed(2)), surface: w.surface };
    });
    const failing = measured.filter((m) => m.ratio < AA_NORMAL_TEXT);
    expect(failing, `${theme} ink below ${AA_NORMAL_TEXT}:1`).toEqual([]);
  });

  test.each(THEMES)('%s: the ramp is monotone, so "muted" never outranks its tier', (theme) => {
    // Raising --fg-3 to clear AA pushed it PAST --fg-2 in daylight (4.51) and
    // slate (4.73), which would have shipped an inverted hierarchy — the
    // faintest tier rendering strongest. --fg-2 moved with it. Without this
    // assertion the contrast test above would happily bless that inversion.
    const ratios = INK_RAMP.map((t) => worstSurface(theme, resolveColor(blocks[theme]!, t)).ratio);
    const descending = ratios.every((r, i) => i === 0 || ratios[i - 1]! > r);
    expect({ theme, ratios: ratios.map((r) => Number(r.toFixed(2))), descending }).toMatchObject({
      descending: true,
    });
  });
});

describe('[a11y] theme contrast — accent and banner surfaces', () => {
  test.each(THEMES)('%s: --on-accent is readable on --accent', (theme) => {
    // Every Save / Start / Choose-folder button in the app. Daylight — the
    // first-run default — sat at 4.31 (register U05); aurora still passes by
    // roughly one hundredth, which is exactly why it needs a gate rather than
    // a one-off measurement.
    const ratio = contrastRatio(
      resolveColor(blocks[theme]!, '--on-accent'),
      resolveColor(blocks[theme]!, '--accent'),
    );
    expect({ theme, ratio: Number(ratio.toFixed(3)) }).toMatchObject({ theme });
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  test.each(THEMES)('%s: banner ink is readable on the soft tints it sits on', (theme) => {
    // `.multi-agent-warning` and `.tpl-banner.is-warn/.is-info` put text on
    // their own semantic tint. The tints are translucent, so the panel behind
    // them is part of the measurement.
    const ink = resolveColor(blocks[theme]!, '--fg-1');
    for (const tint of ['--warn-soft', '--info-soft'] as const) {
      const ratio = contrastRatio(ink, tintOverPanel(theme, tint));
      expect({ theme, tint, ratio: Number(ratio.toFixed(2)) }).toMatchObject({ theme, tint });
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});

describe('[a11y] theme contrast — the MOCK badge', () => {
  // Read the stripes out of the declared rule rather than restating them, so
  // editing the gradient is what this measures. The badge pins `color: #fff`
  // regardless of gamma, so white is the correct foreground for all four.
  const gradient = declaration(ruleBody('.mock-badge'), 'background');
  const stripes = gradientStops(gradient);

  test('the gradient still declares exactly two stripes', () => {
    expect(gradient).toContain('repeating-linear-gradient');
    expect(stripes).toHaveLength(2);
  });

  test.each(THEMES)('%s: white clears AA on both stripes', (theme) => {
    // Re-asserted per theme, not just once above: `stripes` is shared, and a
    // future edit that empties it would otherwise turn each of these four
    // cases into a loop over nothing that reports success.
    expect(stripes).toHaveLength(2);
    const ratios = stripes.map((stripe) => {
      const colour = parseColor(resolveVar(blocks[theme]!, stripe));
      // Opaque by construction (mixed with #000, not with transparent) — but
      // composite over the panel anyway so a future translucent stripe is
      // measured as painted rather than as declared.
      return contrastRatio(WHITE, composite(colour, resolveColor(blocks[theme]!, '--panel')));
    });
    expect({ theme, ratios: ratios.map((r) => Number(r.toFixed(2))) }).toMatchObject({ theme });
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('[a11y] warning banners do not signal by colour alone (WCAG 1.4.1)', () => {
  test('.multi-agent-warning carries a background, a border and a glyph', () => {
    const body = ruleBody('.multi-agent-warning');
    expect(body).toMatch(/background:\s*var\(--warn-soft\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--warn-border\)/);
    expect(stylesCss).toMatch(/\.multi-agent-warning::before\s*\{[^}]*content:\s*'⚠'/);
  });

  test('every soft-tint banner takes its ink from the neutral tier', () => {
    // This is what binds the rules to the token pair measured above. Without
    // it the contrast case is a statement about `--fg-1` and `--warn-soft` in
    // the abstract, and putting `color: var(--warn)` back would not fail
    // anything — which is exactly what happened on the first pass.
    for (const selector of ['.multi-agent-warning', '.tpl-banner.is-warn', '.tpl-banner.is-info']) {
      expect(declaration(ruleBody(selector), 'color'), selector).toBe('var(--fg-1)');
    }
  });

  test('the hue survives where it is decoration rather than text', () => {
    // Losing the colour channel entirely would trade a contrast failure for a
    // "which banner is this?" failure.
    expect(declaration(ruleBody('.tpl-banner.is-warn .tpl-banner-glyph'), 'color')).toBe(
      'var(--warn)',
    );
    expect(declaration(ruleBody('.tpl-banner.is-info .tpl-banner-glyph'), 'color')).toBe(
      'var(--info)',
    );
    expect(declaration(ruleBody('.multi-agent-warning::before'), 'color')).toBe('var(--warn)');
  });
});

describe('[a11y] the Appearance picker previews the real palette', () => {
  test('every swatch accent equals that gamma’s --accent token', () => {
    // theme.ts calls these "kept in sync with styles.css values" and nothing
    // checked it, so retuning daylight's accent would have left the Settings
    // card previewing a colour the app no longer uses.
    for (const meta of THEME_META) {
      const declared = blocks[meta.id]!.get('--accent');
      expect({ theme: meta.id, swatch: meta.swatch.accent }).toEqual({
        theme: meta.id,
        swatch: declared,
      });
    }
  });

  test('every swatch bg and panel are colours that gamma actually declares', () => {
    // Deliberately weaker than the accent case, because the two dark gammas
    // preview `--panel-2` rather than `--panel` — their real panel is within a
    // few points of the page and a swatch of it would read as one flat block.
    // That looks like a considered choice, not drift, so this asserts what is
    // checkable (the hex is live somewhere in the gamma) instead of inventing
    // a rule the designer never agreed to.
    for (const meta of THEME_META) {
      const declared = new Set(blocks[meta.id]!.values());
      expect({ id: meta.id, bg: declared.has(meta.swatch.bg) }).toEqual({ id: meta.id, bg: true });
      expect({ id: meta.id, panel: declared.has(meta.swatch.panel) }).toEqual({
        id: meta.id,
        panel: true,
      });
    }
  });
});
