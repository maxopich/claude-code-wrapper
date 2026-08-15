import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import { parseColor, resolveVar, tokenBlockRanges } from './cssColor.js';

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
    const offenders = SITES.filter((s) => (FILL_TOKENS as readonly string[]).includes(s.token)).map(
      (s) => `${s.line}: ${s.text}`,
    );
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

/**
 * Cebab-rsw: a `-soft` token must be TRANSLUCENT.
 *
 * The rule above keeps the five fills out of `color:`. It says nothing about
 * what a *surface* named `-soft` may be, and that gap is how `--fg-1` on
 * `--accent-soft` shipped at 1.56:1: `--accent-soft` read as a pale tint and
 * was a solid saturated hex in every block, so neutral ink went onto it the
 * way it safely goes onto `--ok-soft` and friends.
 *
 * `--accent-soft` is now deleted — it duplicated `--accent-2` byte-for-byte in
 * all five blocks, so the repair was a deletion and this guard holds with NO
 * exemption list. That matters here specifically: the `EXEMPT` comment above
 * says an unchecked exemption list is where the next one hides, and an
 * accessibility defect is the last thing that should be parked on one.
 *
 * ALL FIVE BLOCKS, including `:root`, and that is not incidental.
 * `parseThemeBlocks` returns the four `[data-theme]` blocks only, and the four
 * `--agent-N-soft` tints are declared in `:root` and nowhere else — so a guard
 * built on it would have reported a clean pass over half the `-soft` tokens in
 * the file. Measured, not assumed: the control below counts what each block
 * actually contributes.
 */
function tokenMap(blockText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of blockText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1]!, m[2]!.trim());
  }
  return map;
}

/**
 * The declarations of every block with this name, concatenated.
 *
 * `:root` appears THREE times in `styles.css`, so a `.find()` here would have
 * read the first and reported a clean pass over the other two — and
 * `--accent-2` lives in the second. Aggregate, never find.
 */
function blockText(blockName: string): string {
  const ranges = tokenBlockRanges(stylesCss).filter((b) => b.name === blockName);
  if (ranges.length === 0) throw new Error(`no token block named ${blockName}`);
  return ranges.map((r) => stylesCss.slice(r.start, r.end)).join('\n');
}

/** Every `-soft` token in one named block that resolves to a FULLY OPAQUE
 *  colour — i.e. a fill wearing a tint's name. */
function opaqueSoftTokens(blockName: string): string[] {
  const tokens = tokenMap(blockText(blockName));
  const offenders: string[] = [];
  for (const [name, raw] of tokens) {
    if (!name.endsWith('-soft')) continue;
    // `color-mix(…, transparent)` is the light-gamma spelling of a tint and
    // `rgba()` the dark-gamma one; `parseColor` resolves both. Anything that
    // lands at full alpha is the defect.
    if (parseColor(resolveVar(tokens, raw)).a >= 1) offenders.push(`${name}: ${raw}`);
  }
  return offenders.sort();
}

// Written out per block rather than looped: a loop cannot catch the list of
// blocks itself being wrong, which is how a guard passes while measuring a
// fraction of what it claims (this one nearly did — see the header).
describe('[a11y] a -soft token is a tint, not a fill (Cebab-rsw)', () => {
  test(':root', () => expect(opaqueSoftTokens(':root')).toEqual([]));
  test('aurora', () => expect(opaqueSoftTokens('aurora')).toEqual([]));
  test('daylight', () => expect(opaqueSoftTokens('daylight')).toEqual([]));
  test('slate', () => expect(opaqueSoftTokens('slate')).toEqual([]));
  test('phosphor', () => expect(opaqueSoftTokens('phosphor')).toEqual([]));

  test('CONTROL: the scan reaches -soft tokens in every block it claims', () => {
    // Without this, an empty token map — or a suffix test that matched
    // nothing — makes all five cases above pass while measuring zero tokens.
    // The counts are asserted per block because they are NOT uniform: the
    // agent tints live only in `:root`, which is the asymmetry that made a
    // themes-only scan look complete.
    const counted = (name: string) =>
      [...tokenMap(blockText(name)).keys()].filter((k) => k.endsWith('-soft')).length;
    expect(counted(':root'), 'root: 4 semantic + 4 agent tints').toBe(8);
    for (const theme of ['aurora', 'daylight', 'slate', 'phosphor']) {
      expect(counted(theme), `${theme}: the 4 semantic tints`).toBe(4);
    }
  });

  test('--accent-soft is gone, not merely unused', () => {
    // The deletion IS the fix. A revert that restored the declaration while
    // leaving call sites on `--accent-2` would redden the guard above too,
    // but this states plainly which token was removed, so a future re-add
    // needs a new argument rather than passing as a fresh idea.
    expect(stylesCss).not.toMatch(/^\s*--accent-soft\s*:/m);
    expect(stylesCss).not.toContain('var(--accent-soft)');
  });
});
