import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import { tokenBlockRanges } from './cssColor.js';

/**
 * One token cannot be both the fill and the ink (bead .5.37).
 *
 * `--warn`, `--err`, `--ok`, `--info` and `--accent` are each used two ways: as
 * a FILL (a 12% tint, a border, a glow), where the value wants to sit close to
 * the surface, and as INK, where it wants to sit far from it. They were tuned
 * for the fill and used as text at 159 sites, measuring 2.35–4.30:1 in the two
 * light gammas — under WCAG AA, at every status chip, badge and count in the
 * app.
 *
 * `styleContrast.test.ts` proves the `--X-ink` values are readable. This file
 * proves the *fills* stay out of `color:`, which is the half a value-level gate
 * cannot see: reverting one rule to `color: var(--warn)` would leave every
 * measured pairing passing, because the pairing being measured would no longer
 * be the one the browser paints.
 */

/** Fill tokens. Each has an `-ink` sibling; none of them belongs in `color:`. */
const FILL_TOKENS = ['--ok', '--warn', '--err', '--info', '--accent'] as const;

/**
 * `color:` sites allowed to name a fill token, each with a reason and a proof
 * string checked against the rule below. An unchecked exemption list is where
 * the next one hides.
 */
const EXEMPT: Array<{ selector: string; token: string; why: string }> = [
  {
    selector: '.claude-mark',
    token: '--coral',
    why: 'an SVG brand mark driving fill:currentColor, not text — logos are exempt from the text-contrast minimum, and --coral has no ink variant because it has no other use',
  },
];

/** Comment bodies blanked, lengths preserved so line numbers still line up. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * `color:` declarations in ORDINARY rules — the `:root` and `[data-theme]`
 * blocks are masked out, because naming a fill token inside them is how the
 * fill gets declared in the first place.
 */
function colorSites(): Array<{ line: number; token: string; text: string }> {
  const css = blankComments(stylesCss);
  const lines = css.split('\n');
  const masked = new Array<boolean>(lines.length).fill(false);
  for (const { start, end } of tokenBlockRanges(css)) {
    const from = css.slice(0, start).split('\n').length - 1;
    const to = css.slice(0, end).split('\n').length - 1;
    for (let i = from; i <= to; i++) masked[i] = true;
  }
  const out: Array<{ line: number; token: string; text: string }> = [];
  lines.forEach((l, i) => {
    if (masked[i]) return;
    const m = /^\s*color:\s*var\(\s*(--[a-zA-Z0-9-]+)/.exec(l);
    if (m) out.push({ line: i + 1, token: m[1]!, text: l.trim() });
  });
  return out;
}

const SITES = colorSites();

describe('[a11y] a fill token is never used as ink', () => {
  test('the scan found the color sites', () => {
    // Anti-vacuity: a masking bug that blanked the whole sheet, or a regex that
    // matched nothing, would make every assertion below pass over an empty
    // list. Floors rather than exact counts, so ordinary edits do not churn.
    expect(SITES.length).toBeGreaterThan(200);
    expect(SITES.some((s) => s.token.endsWith('-ink'))).toBe(true);
  });

  test('the mask removed the declarations and kept the rules', () => {
    // Two-sided: masking nothing would report every gamma's own declarations,
    // masking everything would report none of the rules.
    expect(SITES.some((s) => s.token === '--fg')).toBe(true);
    expect(stylesCss).toContain('--warn-ink:');
    expect(SITES.some((s) => s.text.includes('--warn-ink:'))).toBe(false);
  });

  test('no ordinary rule sets color to a fill token', () => {
    const offenders = SITES.filter((s) =>
      (FILL_TOKENS as readonly string[]).includes(s.token),
    ).map((s) => `${s.line}: ${s.text}`);
    expect(offenders).toEqual([]);
  });

  test('every fill token has the ink sibling this rule assumes', () => {
    // The rule above is only fair if there is somewhere to go. If a family ever
    // loses its ink token, this fails here rather than pushing authors back
    // onto the fill.
    //
    // Existence only — "declared in ALL FOUR gammas" is `styleTokens.test.ts`'s
    // parity assertion, and duplicating it here would be a second opinion about
    // the same fact. Existence plus parity gives the whole guarantee.
    const missing = FILL_TOKENS.filter((t) => !stylesCss.includes(`${t}-ink:`));
    expect(missing).toEqual([]);
  });

  test('each exemption still exists and still says what it claims', () => {
    for (const { selector, token } of EXEMPT) {
      const at = stylesCss.indexOf(`\n${selector} {`);
      expect(at, `exempt rule not found: ${selector}`).toBeGreaterThan(-1);
      const body = stylesCss.slice(at, stylesCss.indexOf('}', at));
      expect(body, selector).toContain(`color: var(${token})`);
    }
  });

  test('the exemption list is not a back door', () => {
    // `--coral` is exempt as a brand mark. If it ever appears as `color:` on
    // something that is not the mark, that is a new decision and needs a new
    // argument, not a free ride on this entry.
    const coral = SITES.filter((s) => s.token === '--coral');
    expect(coral).toHaveLength(EXEMPT.length);
  });
});
