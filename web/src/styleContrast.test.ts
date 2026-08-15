import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import { THEME_META, THEMES } from './theme.js';
import {
  AA_NORMAL_TEXT,
  composite,
  contrastRatio,
  parseColor,
  parseThemeBlocks,
  relativeLuminance,
  resolveColor,
  resolveVar,
  splitTopLevel,
  topLevelRules,
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
 * The KNOWN RESIDUAL this header used to declare — the semantic inks used as
 * text at "roughly sixty sites", measuring 2.4–3.4:1 — is closed. It was 159
 * sites across five token families, and the fix was to stop asking one token
 * to be both the fill and the ink: `--ok-ink` / `--warn-ink` / `--err-ink` /
 * `--info-ink` now sit beside their fills, the way `--accent-ink` always has.
 * Those pairings are gated below, and `semanticInk.test.ts` keeps the fills
 * from creeping back into `color:`.
 */

/** Surfaces that body text actually sits on, worst-case across all of them.
 *  In the light gammas the darkest of these binds; in the dark gammas the
 *  lightest does (slate's `--raised` is the real constraint, not `--panel` —
 *  which is why measuring against `--panel` alone under-reported every
 *  finding in the register by 0.3–0.6).
 *
 *  `--bg-4` was missing and is the darkest surface the light gammas paint text
 *  on. Its absence was not a rounding error: `--fg-3` measured 4.32/4.38 on it
 *  at three sites while this list bottomed out at 4.60, so the gate reported a
 *  pass over a sub-AA pairing that ships.
 *
 *  `--bg-5` is deliberately NOT here. It is painted eight times and *no rule
 *  pairs text with it* — every one inherits its ink. Listing it would repeat
 *  the mistake this file was audited for (`--panel-2` sat here for months
 *  while nothing painted it), and it would hold the gate red over a pairing
 *  that does not exist. The declared-pairings block below is what catches it
 *  the moment text does land there — which is the better mechanism, because it
 *  needs no one to remember to update a list.
 *
 *  WHAT THIS LIST IS AND IS NOT. It is a palette-level PROMISE: every ink
 *  clears AA on all of these, whether or not a rule pairs them. It is not the
 *  enforcement — shortening it reddens nothing, because the pairings that
 *  actually ship are checked against the stylesheet below and never read this
 *  list. Deliberate: a hand-kept list cannot notice itself being shortened,
 *  which is why the promise and the enforcement are separate. */
const TEXT_SURFACES = ['--bg', '--panel', '--panel-2', '--raised', '--bg-4'] as const;

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
  const found = findDeclaration(body, prop);
  if (found === null) throw new Error(`declaration not found: ${prop}`);
  return found;
}

/** `declaration`, but `null` instead of a throw when the property is absent.
 *  The pairing scan below asks every rule in the stylesheet whether it sets
 *  `color` and `background`; almost none set both, so "absent" is the ordinary
 *  case there rather than an error. */
function findDeclaration(body: string, prop: string): string | null {
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
  if (at === -1) return null;
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

describe('[a11y] theme contrast — the permission card’s Allow/Deny', () => {
  // The app's highest-stakes buttons: in an untrusted project this pair is the
  // last thing between the model and a `Bash("rm -rf …")`. Neither was in the
  // pair list until register U09 sent us here, so nothing measured them — the
  // affirmative button's ink is a literal (`#0c1a12`) chosen once, against a
  // `--ok` that each gamma redefines.
  const cases = [
    { label: 'Allow', selector: '.msg.permission .actions .permission-allow' },
    {
      label: 'Allow (armed for a dangerous call)',
      selector: '.msg.permission .actions .permission-allow.is-armed',
    },
    { label: 'Deny', selector: '.msg.permission .actions .permission-deny' },
  ] as const;

  // `.permission-deny` has no rule of its own beyond `:hover` — it takes the
  // shared `.msg.permission button` fill and ink — so a missing rule is a
  // legitimate "inherits the base" here, not a lookup failure.
  const optionalRuleBody = (selector: string): string =>
    stylesCss.includes(`\n${selector} {`) ? ruleBody(selector) : '';
  /** The property as declared on this rule, or '' when the rule leaves it to
   *  the base — `declaration` throws on absence, which is right for a rule
   *  that is supposed to carry the property and wrong for a fallback chain. */
  const optionalDeclaration = (body: string, prop: string): string =>
    body === '' || !body.includes(prop) ? '' : declaration(body, prop);

  for (const { label, selector } of cases) {
    const own = optionalRuleBody(selector);
    const base = ruleBody('.msg.permission button');
    const ink = optionalDeclaration(own, 'color') || declaration(base, 'color');
    const fill = optionalDeclaration(own, 'background') || declaration(base, 'background');

    test(`${label} declares both an ink and a fill`, () => {
      // Without this the theme loop below would measure an empty string and
      // `parseColor` would throw — but a future refactor could just as easily
      // leave one side blank in a way that silently resolves. Pin both.
      expect(ink).not.toBe('');
      expect(fill).not.toBe('');
    });

    test.each(THEMES)(`%s: ${label} ink clears AA on its own fill`, (theme) => {
      const tokens = blocks[theme]!;
      const fg = parseColor(resolveVar(tokens, ink));
      const bg = composite(parseColor(resolveVar(tokens, fill)), resolveColor(tokens, '--panel'));
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }

  test('the affirmative button is coloured by class, not by DOM position', () => {
    // U09's actual mechanism: the green came from `:first-child`, so swapping
    // the two buttons would have repainted Deny as the safe-looking one with
    // no CSS diff to notice. Both directions are asserted — the class rule
    // must exist AND the positional one must be gone.
    expect(ruleBody('.msg.permission .actions .permission-allow')).toContain('var(--ok)');
    expect(stylesCss).not.toContain('.msg.permission .actions button:first-child');
    expect(stylesCss).not.toContain('.msg.permission .actions button:last-child');
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
    //
    // These now name the ink variant rather than the fill. The hue is
    // identical — `--warn-ink` is `--warn` with lightness lowered — so the
    // property this test exists for is untouched, while a glyph that measured
    // 2.35:1 against its surface in aurora measures 4.6:1. Keeping the fill
    // here would also have made "every `color:` is an ink token" a rule with
    // three exceptions to remember, which is how the fills got into `color:`
    // in the first place.
    expect(declaration(ruleBody('.tpl-banner.is-warn .tpl-banner-glyph'), 'color')).toBe(
      'var(--warn-ink)',
    );
    expect(declaration(ruleBody('.tpl-banner.is-info .tpl-banner-glyph'), 'color')).toBe(
      'var(--info-ink)',
    );
    expect(declaration(ruleBody('.multi-agent-warning::before'), 'color')).toBe('var(--warn-ink)');
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

/**
 * ── Semantic ink (bead .5.37) ─────────────────────────────────────────
 *
 * `--warn`, `--err`, `--ok` and `--info` were each doing two opposite jobs.
 * As a FILL — a 12% tint, a border, a glow — a token wants to sit close to
 * the surface. As INK it wants to sit far from it. They were tuned for the
 * fill and used as text at 159 sites, where they measured 2.35–4.30:1 in the
 * two light gammas.
 *
 * The split is not new: `--accent-ink` has sat beside `--accent` since the
 * redesign. These tests hold the other four to the same standard, on the two
 * surfaces the sites actually use — the declared text surfaces, and each
 * token's own 12% tint, which 63 of the sites sit on and which is the harder
 * of the two (the tint pulls the background toward the ink).
 */
const SEMANTIC_FAMILIES = ['--ok', '--warn', '--err', '--info', '--accent'] as const;

/** Gammas whose base tokens already clear AA as ink, where `--X-ink` is
 *  deliberately an alias rather than a different colour. */
const INK_ALIASING_GAMMAS = ['slate', 'phosphor'] as const;

describe('[a11y] semantic ink is readable as text', () => {
  test.each(THEMES)('%s: every ink clears AA on every text surface', (theme) => {
    const measured = SEMANTIC_FAMILIES.map((base) => {
      const ink = resolveColor(blocks[theme]!, `${base}-ink`);
      const w = worstSurface(theme, ink);
      return { token: `${base}-ink`, ratio: Number(w.ratio.toFixed(2)), surface: w.surface };
    });
    // Printed, not just asserted: a passing run should show its work, because
    // the whole point of this file is that nobody was measuring.
    expect(measured.length).toBe(SEMANTIC_FAMILIES.length);
    expect(measured.filter((m) => m.ratio < AA_NORMAL_TEXT)).toEqual([]);
  });

  /**
   * The four families whose `-soft` is a translucent 12% tint of the base.
   *
   * `--accent` is excluded and it is not an oversight: `--accent-soft` is a
   * SOLID darker accent, not a tint — "soft" means something different in that
   * family. Compositing it over the panel and measuring `--accent-ink` against
   * it produced a 1.0 ratio in aurora, where the two happen to be the same
   * hex. The accent's real tint is `--accent-glow`, checked on its own below.
   */
  const TINTED_FAMILIES = ['--ok', '--warn', '--err', '--info'] as const;

  test.each(THEMES)('%s: every ink clears AA on its own soft tint', (theme) => {
    // 63 of the 159 sites are `color: var(--X-ink)` over `background:
    // var(--X-soft)`. The tint composites the fill over the panel, so the
    // background moves toward the ink and this binds harder than a bare panel.
    const failing = TINTED_FAMILIES.filter(
      (base) =>
        contrastRatio(
          resolveColor(blocks[theme]!, `${base}-ink`),
          tintOverPanel(theme, `${base}-soft`),
        ) < AA_NORMAL_TEXT,
    );
    expect({ theme, failing }).toEqual({ theme, failing: [] });
    // The tint must actually be translucent, or this measures a bare colour
    // and silently stops testing the harder case.
    for (const base of TINTED_FAMILIES) {
      expect(blocks[theme]!.get(`${base}-soft`), `${theme} ${base}-soft`).toMatch(
        /transparent|rgba/,
      );
    }
  });

  test.each(THEMES)('%s: --accent-ink is readable on --accent-glow', (theme) => {
    // The one accent site that sits on a tint rather than a panel.
    const ratio = contrastRatio(
      resolveColor(blocks[theme]!, '--accent-ink'),
      tintOverPanel(theme, '--accent-glow'),
    );
    expect({ theme, ratio: Number(ratio.toFixed(2)) }).toMatchObject({ theme });
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  test.each(INK_ALIASING_GAMMAS)('%s: the ink alias is deliberate, not an oversight', (theme) => {
    // These two gammas declare `--X-ink: var(--X)`. That is only defensible
    // while the base itself clears AA as ink — which is the measurement that
    // made aliasing the right call instead of inventing four colours for a
    // palette nobody can eyeball from here. If a base is ever retuned into
    // failing, this says so rather than letting the alias carry it through.
    const failing = SEMANTIC_FAMILIES.filter(
      (base) => worstSurface(theme, resolveColor(blocks[theme]!, base)).ratio < AA_NORMAL_TEXT,
    );
    expect({ theme, failing }).toEqual({ theme, failing: [] });
  });

  test.each(['aurora', 'daylight'] as const)('%s: the ink is darker than its fill', (theme) => {
    // A positive lock. Both light gammas need a genuinely different value; a
    // future "simplification" to `--warn-ink: var(--warn)` here would revert
    // the fix while leaving every call site looking correct, and the AA tests
    // above would catch it only because the numbers happen to fail. This
    // catches the shape directly.
    const notDarker = SEMANTIC_FAMILIES.filter((base) => {
      const ink = resolveColor(blocks[theme]!, `${base}-ink`);
      const fill = resolveColor(blocks[theme]!, base);
      return relativeLuminance(ink) >= relativeLuminance(fill);
    });
    expect({ theme, notDarker }).toEqual({ theme, notDarker: [] });
  });
});

// ===========================================================================
// The pairings the stylesheet actually declares.
// ===========================================================================

/**
 * The block above measures a CROSS-PRODUCT: every ink tier against every
 * surface someone remembered to list. That has two failure modes and this
 * repo has now hit both.
 *
 *   - It measures pairings that do not exist. `--panel-2` sat in
 *     `TEXT_SURFACES` for months while no rule painted it (a rule does now,
 *     since #293). Harmless, but it made the list feel maintained.
 *   - It MISSES pairings that do. `--bg-4` was absent, and `--fg-3` on it
 *     measured 4.32:1 in aurora and 4.38 in daylight at three real sites,
 *     while the listed surfaces bottomed out at 4.60. The gate said PASS over
 *     sub-AA text in the default theme.
 *
 * The second is the one that matters, and no amount of care with the list
 * fixes it — a hand-kept list of surfaces is exactly the artifact that goes
 * stale silently. So this block does not use a list. It reads every rule that
 * sets BOTH `color: var(--fg-N)` and a `background` naming a token, and
 * measures that pair in all four gammas. A new component pairing a ramp tier
 * with a darker fill is caught the day it lands.
 *
 * Covers the neutral ramp AND the `-ink` partners, because both are inks that
 * land on arbitrary fills. `semanticInk.test.ts` is not a duplicate of this —
 * it asserts a *fill* token never appears in `color:`, and says nothing about
 * the contrast of the pairing that results.
 *
 * A first draft scanned `--fg-N` only. That left `--info-ink` on `--bg-4`
 * (`.avatar.tool`, `.msg.user-command .avatar.user`) covered solely by the
 * hand-kept `TEXT_SURFACES` list — and the revert-check proved it: dropping
 * `--bg-4` from that list reddened nothing, because no *declared* pairing
 * depended on it. A gate whose coverage evaporates when someone shortens a
 * list is the thing this block exists to replace.
 */
type Pairing = { ink: string; surface: string; selectors: string[] };

/**
 * The token a `color:` / `background:` value names, in EITHER `var()` form.
 *
 * `var(--x, <fallback>)` is the form that hid two of the three sub-AA pairings
 * this scan was widened to catch: the old pattern ended at `\s*\)$`, so a
 * declaration with a fallback argument matched nothing and the rule was
 * skipped entirely — 55 declarations in this stylesheet use it. The fallback
 * is deliberately NOT modelled: it applies only when the token is undefined,
 * which is a different rule than the one shipping, and `.tools-list-usage-
 * toggle-btn-active` is the cautionary tale — it was written
 * `var(--accent-soft, <a 12% tint>)` by an author who believed they were
 * getting the tint, while `--accent-soft` was a saturated fill and the
 * fallback never fired.
 */
function namedToken(value: string | null): string | null {
  if (value === null) return null;
  return /^var\(\s*(--[a-z0-9-]+)\s*[,)]/.exec(value.trim())?.[1] ?? null;
}

/**
 * Tokens the scan cannot put a number on, recorded rather than swallowed.
 *
 * Two kinds reach here, both legitimate: properties set from JS
 * (`--agent-hue`, `--identity-hue`) which no gamma block declares, and
 * `--grad-user`, a `linear-gradient` — a gradient has no single contrast
 * value, the same class of limitation as the "tint over a surface darker than
 * `--panel`" one documented on `pairingRatio`.
 *
 * The reason this is a Set and not a bare `continue`: a silent skip is how a
 * widened scan narrows again without anyone noticing. The test below asserts
 * these BY NAME, so a new unmeasurable surface reddens and forces a decision
 * rather than quietly leaving a rule unguarded.
 */
const UNMEASURABLE = new Set<string>();

function measurable(token: string): boolean {
  for (const theme of THEMES) {
    try {
      resolveColor(blocks[theme]!, token);
    } catch {
      UNMEASURABLE.add(token);
      return false;
    }
  }
  return true;
}

/**
 * `color: var(--X)` + `background[-color]: var(--Y)` in one rule.
 *
 * NO ALLOWLIST OF INK NAMES, and that is the point. A previous version matched
 * `--fg-[0-3]`, the four `--X-ink` partners and `--on-accent`, on the
 * reasonable-sounding premise that those are "the inks". Three real sub-AA
 * pairings shipped past it because they used a token that was not on the list:
 *
 *   - bare `--fg` on `--accent-2`   (2.22:1) — `.sidebar-reopen-btn:hover`
 *   - `--bg-0` on `--err`           (3.27:1) — `.notif-bell-badge`
 *   - `--bg-0` on `--accent`        (4.02:1) — `.gate-modal-btn-primary`,
 *                                              `.logs-filter-count`
 *
 * The last two are the interesting shape: `--bg-0` is an INVERSE ink, reached
 * for because "the background colour" reads like the safe opposite of the
 * foreground. It is not — it tracks the gamma, so on a saturated fill it is
 * right in the dark gammas and wrong in the light ones.
 *
 * A name list cannot anticipate that, and the header of this file already
 * argues the general case: a hand-kept list is exactly the artifact that goes
 * stale silently. So every token named in a `color:` beside a `background:` is
 * measured, whatever it is called. Measured cost of the widening: 121
 * pairings, of which the four above were the only ones below AA.
 */
function declaredPairings(): Pairing[] {
  const byPair = new Map<string, Pairing>();
  for (const rule of topLevelRules(stylesCss)) {
    const ink = namedToken(findDeclaration(rule.body, 'color'));
    if (!ink) continue;
    const surface = namedToken(
      findDeclaration(rule.body, 'background') ?? findDeclaration(rule.body, 'background-color'),
    );
    if (!surface) continue;
    if (!measurable(ink) || !measurable(surface)) continue;
    const key = `${ink} on ${surface}`;
    const entry = byPair.get(key) ?? { ink, surface, selectors: [] };
    entry.selectors.push(rule.selector.replace(/\s+/g, ' '));
    byPair.set(key, entry);
  }
  return [...byPair.values()].sort((a, b) => (a.ink + a.surface).localeCompare(b.ink + b.surface));
}

const PAIRINGS = declaredPairings();

/**
 * Worst contrast a pairing reaches in one gamma.
 *
 * A translucent surface (`--*-soft` is `rgba()` in the dark gammas and
 * `color-mix(…, transparent)` in the light ones) has no contrast of its own —
 * what the eye sees is the tint composited over whatever is behind it, and
 * that is NOT knowable from the rule alone.
 *
 * Modelled as "over `--panel`", reusing `tintOverPanel` and therefore the same
 * assumption the shipped `--accent-ink on --accent-glow` case already makes.
 * A draft composited over every surface and took the worst, which is stricter
 * and sounds better — and it reported `--err-ink`/`--info-ink`/`--ok-ink` on
 * their own tints at 3.90–3.95, on the premise that a badge might sit over
 * `--bg-4`. Nothing shows that any of them does. This file's header is right
 * that a gate which cries wolf gets deleted, so the limitation is written
 * down instead of guessed at: **a tint over a surface darker than `--panel`
 * is not modelled here.** If a component ever puts one there, this gate will
 * not see it.
 */
function pairingRatio(theme: string, p: Pairing): number {
  const ink = resolveColor(blocks[theme]!, p.ink);
  const fill = resolveColor(blocks[theme]!, p.surface);
  if (fill.a >= 1) return contrastRatio(ink, fill);
  return contrastRatio(ink, tintOverPanel(theme, p.surface));
}

/**
 * A neutral ramp tier sitting on a saturated, fully opaque semantic fill.
 *
 * Extracted so it can be exercised on its own — see the cases at the bottom of
 * this file for why that is not optional.
 */
function isRampOnOpaqueFill(p: Pairing): boolean {
  return (
    (p.ink === '--fg' || p.ink.startsWith('--fg-')) &&
    /^--(ok|warn|err|info|accent|accent-2)(-soft)?$/.test(p.surface) &&
    THEMES.every((theme) => resolveColor(blocks[theme]!, p.surface).a >= 1)
  );
}

describe('[a11y] theme contrast — pairings the stylesheet declares', () => {
  test('the scan found the pairings', () => {
    // Without this the two assertions below iterate an empty list and pass —
    // the shape this whole file exists to prevent, one level up. A floor
    // rather than an exact count, so adding a component is a one-file edit.
    expect(PAIRINGS.length).toBeGreaterThanOrEqual(18);
    // Two anchors found through the scanner rather than by string search, so a
    // parser that mangles multi-line selectors or skips `@media` bodies is
    // caught here rather than by silently shrinking the list.
    const surfaces = new Set(PAIRINGS.map((p) => p.surface));
    expect([...surfaces]).toContain('--bg-4');
    expect([...surfaces]).toContain('--bg-3');
  });

  test('the widened scan still reaches the three shapes that used to escape it', () => {
    // A floor of 18 was set when the ink pattern was an allowlist. Dropping
    // back to it would not redden anything above, so each shape the widening
    // added is named here. All three shipped a sub-AA pairing past the old
    // scan; each is now represented by a rule that still exists.
    const inks = new Set(PAIRINGS.map((p) => p.ink));
    // 1. bare `--fg`, which `--fg-[0-3]` did not match. 41 rules use it.
    expect([...inks], 'bare --fg is measured').toContain('--fg');
    // 2. NO allowlist at all. `--on-err` did not exist when the old pattern
    //    was written, so no list could have contained it — if the ink filter
    //    ever becomes an enumeration again, this is the case that says so.
    //    (The `--bg-0` inverse inks that motivated the widening were all
    //    repaired in the same change, so there is no live example of that
    //    shape left to anchor on; a token invented here is the stronger
    //    proof anyway.)
    expect([...inks], 'a token no allowlist could contain is measured').toContain('--on-err');
    // 3. the `var(--x, <fallback>)` form, which the old `\\s*\\)$` anchor
    //    rejected outright. `.kbd` uses it and is NOT one of the rules this
    //    change edited, so the case cannot be satisfied by the repair.
    const kbd = PAIRINGS.find((p) => p.selectors.some((s) => s.includes('.kbd')));
    expect(kbd, 'a var(--x, fallback) rule is measured').toBeDefined();
  });

  test('every token the scan gave up on is one we have looked at', () => {
    // Named, not counted. A count passes when one unmeasurable token is
    // swapped for another, which is exactly when a rule silently stops being
    // guarded. One entry, inspected: `--msg-user-bg` is `var(--grad-user)` in
    // the dark gammas — a `linear-gradient`, which has no single contrast
    // value. Same class of limitation as the "tint over a surface darker than
    // --panel" one on `pairingRatio`, and written down for the same reason.
    expect([...UNMEASURABLE].sort()).toEqual(['--msg-user-bg']);
  });

  test.each(THEMES)('%s: every declared ink/surface pairing clears AA', (theme) => {
    const failing = PAIRINGS.map((p) => ({
      pair: `${p.ink} on ${p.surface}`,
      ratio: Number(pairingRatio(theme, p).toFixed(2)),
      at: p.selectors.slice(0, 3),
    })).filter((m) => m.ratio < AA_NORMAL_TEXT);
    expect(failing, `${theme}: text below ${AA_NORMAL_TEXT}:1`).toEqual([]);
  });

  test('a ramp tier never sits on an OPAQUE semantic fill', () => {
    // How `--fg-1` on `--accent-soft` survived to ship at 1.56:1 in phosphor,
    // on the search-result highlight: `semanticInk.test.ts` guards the five
    // FILL_TOKENS but not their `-soft` variants, so nobody owned this pair.
    //
    // The distinction that matters is OPACITY, not the name. `--ok-soft` and
    // friends are 10-12% tints (`rgba()` in the dark gammas,
    // `color-mix(..., transparent)` in the light ones); composited they are
    // near enough the panel that a ramp tier on them is fine, and six such
    // pairings ship correctly today. `--accent-soft` is the odd one out in its
    // own family -- a solid hex in all four gammas. A ramp tier on a saturated
    // fill is the `.5.37` defect, and the fill's own ink (`--on-accent`) is
    // what it takes.
    //
    // A first draft keyed on the `-soft` SUFFIX and flagged all six legitimate
    // tints. Naming is not the invariant; opacity is.
    //
    // UPDATE: the surface filter was `/^--(ok|warn|err|info|accent)(-soft)?$/`
    // and `--accent-2` was not in it — while `--accent-soft`, which it DID
    // name, carried the identical value in all five blocks. So the same colour
    // was guarded under one name and unguarded under the other, and `--fg` on
    // `--accent-2` shipped at 2.22:1 on `.sidebar-reopen-btn:hover`. The
    // duplicate is gone now (`--accent-soft` deleted, uses repointed at
    // `--accent-2`), and the filter names the token that survived.
    //
    // The ink side had the mirror hole: `startsWith('--fg-')` misses bare
    // `--fg`, which is the ink that actually shipped the failure. Naming was
    // not the invariant on the surface side and it is not on the ink side
    // either — this is the neutral ramp, all of it.
    const onOpaqueFill = PAIRINGS.filter(isRampOnOpaqueFill);
    expect(
      onOpaqueFill.map((p) => `${p.ink} on ${p.surface} at ${p.selectors[0]}`),
      'an opaque semantic fill takes its own ink (--on-accent / --X-ink), not a --fg-N tier',
    ).toEqual([]);
  });

  // The predicate, not the stylesheet.
  //
  // Widening it to `--fg` and `--accent-2` reverts GREEN against the shipped
  // CSS, and that is not a reason to skip the widening — it is a reason not to
  // pretend the stylesheet covers it. Every rule that used to trip this
  // predicate was repaired in the same change, so the only live net is the AA
  // test above; the predicate's value is the sharper message it gives the NEXT
  // author, and a predicate nothing exercises is a comment.
  //
  // So it is exercised directly, with synthetic pairings. Each case names the
  // hole it stands for.
  describe('the opaque-fill predicate itself', () => {
    const pair = (ink: string, surface: string): Pairing => ({ ink, surface, selectors: ['x'] });

    test('flags bare --fg on --accent-2 — the pairing that shipped at 2.22:1', () => {
      expect(isRampOnOpaqueFill(pair('--fg', '--accent-2'))).toBe(true);
    });

    test('flags a --fg-N tier on --accent-2 — the surface half of the hole', () => {
      expect(isRampOnOpaqueFill(pair('--fg-1', '--accent-2'))).toBe(true);
    });

    test('flags bare --fg on --accent — the ink half of the hole', () => {
      expect(isRampOnOpaqueFill(pair('--fg', '--accent'))).toBe(true);
    });

    test('CONTROL: a translucent tint is not flagged', () => {
      // `--ok-soft` is a 12% tint. Flagging it would make the predicate cry
      // wolf on six pairings that ship correctly, which this file's header
      // says is how a gate gets deleted.
      expect(isRampOnOpaqueFill(pair('--fg-1', '--ok-soft'))).toBe(false);
    });

    test('CONTROL: a fill taking its own ink is not flagged', () => {
      expect(isRampOnOpaqueFill(pair('--on-accent', '--accent-2'))).toBe(false);
    });

    test('CONTROL: a neutral surface is not flagged', () => {
      expect(isRampOnOpaqueFill(pair('--fg', '--bg-4'))).toBe(false);
    });
  });
});
