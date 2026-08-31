import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
// Moved to cssColor.ts when styleContrast.test.ts needed the same split — the
// `@media` recursion is not something to hold two opinions about.
import { topLevelRules, type Rule } from './cssColor.js';

/**
 * Focus is a state of its own, not a synonym for hover (registers U19, U20).
 *
 * Two habits had spread through the stylesheet, both of which make a keyboard
 * user's position invisible:
 *
 *   1. `.x:hover, .x:focus-visible { … outline: none }` — one selector for
 *      both states, with the browser's focus ring explicitly removed. The
 *      focus style isn't merely *similar* to hover; it is the same
 *      declaration block. Fifteen rules did this.
 *   2. A control faded to `opacity: 0` and revealed only by an ancestor's
 *      `:hover`, so Tab lands on something fully transparent. Seven reveal
 *      sites already handled focus; two — the session row's `✎` and `⤓` —
 *      did not, sitting beside a third (`ⓘ`) that did.
 *
 * The fix in both cases was already house style: the shared accent ring
 * (`.primary-btn:focus-visible` and friends) and `.tpl-expand-btn`'s
 * hover/focus-within/focus-visible reveal. This gate keeps new code on it.
 *
 * NOT covered: whether a focus ring is *visible enough* against its backdrop
 * (that is a contrast question — `styleContrast.test.ts`), focus ORDER, or
 * `:focus` without `-visible` (deliberately unused here: it would ring mouse
 * clicks, which is the thing `:focus-visible` exists to prevent).
 */

const RULES = topLevelRules(stylesCss);

/**
 * Focus-only rules that legitimately replace the outline with an indicator of
 * their own. Both are text fields whose focus affordance is an accent border —
 * conventional, distinct, and NOT shared with any hover state, so neither is
 * an instance of the defect. Listed rather than silently skipped: an addition
 * here is a hole in the gate and has to be argued for.
 */
const OUTLINE_EXEMPT: Array<{ selector: string; why: string }> = [
  {
    selector: '.gate-modal-input:focus-visible',
    why: 'text input; accent border-color is its focus indicator and it has no hover twin',
  },
  {
    selector: '.tools-list-search:focus-visible',
    why: 'search input; same accent-border affordance, no hover twin',
  },
];

const focusRules = RULES.filter((r) => r.selector.includes(':focus-visible'));

describe('[a11y] focus is never styled as hover (U20)', () => {
  test('the parser found real rules', () => {
    // A broken scan returns [] and every assertion below passes over nothing.
    // Every check here must be one that FAILS on an empty list — a `.some(…)
    // === false` would sail through, which is the exact defect this file is
    // about, one level up.
    expect(RULES.length).toBeGreaterThan(500);
    expect(focusRules.length).toBeGreaterThanOrEqual(15);
    // The shared accent ring, found through the parser rather than by string
    // search, so a parser that mangles grouped selectors is caught here.
    const sharedRing = RULES.find((r) => r.selector.includes('.primary-btn:focus-visible'));
    expect(sharedRing?.body).toContain('outline: 2px solid var(--accent)');
  });

  // Note on what is NOT asserted: sharing a selector between `:hover` and
  // `:focus-visible` is not itself the defect. `.session-rename-btn`'s reveal
  // legitimately fuses them — both states should raise the same `opacity: 1`,
  // and the browser's focus ring still tells the two apart. What made the
  // fusion harmful in the fifteen U20 rules was the `outline: none` alongside
  // it: with the ring gone, one declaration block for two states means the two
  // states are literally indistinguishable. So the contract below is about the
  // outline, which is the part that carries the information.

  test('no focus-visible rule removes the outline without an exemption', () => {
    const stripped = focusRules
      .filter((r) => /outline:\s*none/.test(r.body))
      .map((r) => r.selector.replace(/\s+/g, ' '));
    const unexplained = stripped.filter((sel) => !OUTLINE_EXEMPT.some((e) => e.selector === sel));
    expect(unexplained).toEqual([]);
  });

  test('every exemption still exists and is still focus-only', () => {
    // An exemption for a rule that has been deleted or has since grown a hover
    // twin is a stale licence to break the contract.
    for (const { selector } of OUTLINE_EXEMPT) {
      const rule = focusRules.find((r) => r.selector.replace(/\s+/g, ' ') === selector);
      expect(rule, `exempt rule not found: ${selector}`).toBeDefined();
      expect(rule!.selector).not.toContain(':hover');
      // It must still declare *something* in place of the outline.
      expect(rule!.body).toMatch(/border-color|box-shadow|background/);
    }
  });
});

describe('[a11y] hover-revealed controls are revealed by focus too (U19)', () => {
  /** Class name a rule sets `opacity: 0` on, if it does. */
  function hiddenTarget(rule: Rule): string | null {
    if (!/opacity:\s*0\s*;/.test(rule.body)) return null;
    const sel = rule.selector.trim();
    // Only simple single-class rules — a compound or descendant selector is a
    // state rule, not the control's base declaration.
    return /^\.[a-z0-9-]+$/i.test(sel) ? sel : null;
  }

  const hiddenControls = [
    ...new Set(RULES.map(hiddenTarget).filter((s): s is string => s !== null)),
  ].sort();

  /**
   * Per CONTROL, not per rule. The reveal for one control may be spread over
   * several rules — splitting a fused `:hover, :focus-visible` selector into a
   * hover rule and a focus rule (which U20 does, fifteen times) is exactly
   * that, and a per-rule check would call the result a regression. What
   * matters is whether the control is reachable-and-visible by focus at all.
   */
  const revealed = hiddenControls
    .map((control) => {
      const rules = RULES.filter(
        (r) => /opacity:\s*1\s*;/.test(r.body) && r.selector.includes(control),
      );
      return {
        control,
        byHover: rules.some((r) => r.selector.includes(':hover')),
        byFocus: rules.some((r) => /:focus-within|:focus-visible/.test(r.selector)),
      };
    })
    .filter((c) => c.byHover);

  test('the scan found hidden controls and their reveals', () => {
    // Guards against a vacuous pass: if the `opacity: 0` matcher or the
    // reveal matcher broke, these lists empty out and every case below would
    // pass over nothing.
    expect(hiddenControls.length).toBeGreaterThanOrEqual(5);
    expect(revealed.length).toBeGreaterThanOrEqual(4);
  });

  test.each(revealed.map((c) => [c.control, c] as const))(
    '%s is revealed on focus, not only on hover',
    (_label, control) => {
      // Either form counts: `:focus-within` on an ancestor (the row) or
      // `:focus-visible` on the control itself. `.tpl-expand-btn` uses both.
      expect(control.byFocus).toBe(true);
    },
  );

  test('the two session-row actions are revealed on a coarse pointer', () => {
    // A phone has neither hover nor (before a tap) focus, so the rules above
    // leave the control invisible-but-tappable. Structural, because the media
    // query is the whole point and a value assertion would not see it.
    const coarse = stylesCss.slice(stylesCss.indexOf('@media (hover: none), (pointer: coarse)'));
    expect(coarse).toContain('.session-rename-btn');
    expect(coarse).toContain('.session-download-btn');
  });
});

/**
 * `Cebab-p5y` — a control that answers the mouse and stays silent for the
 * keyboard (register U19/U20's third habit, and the class `Cebab-7dk` was one
 * instance of).
 *
 * WHAT THE TWO GATES ABOVE DO NOT ASK. U20 asks whether a `:focus-visible`
 * rule removes the outline; U19 asks whether a hover-REVEALED control is also
 * focus-revealed. Neither asks whether a hover-styled control has a ring AT
 * ALL — so a button with a `:hover` rule and no focus rule anywhere passed
 * both, which is how eleven of them accumulated.
 *
 * WHY `:hover` IS THE TRIGGER. Not every unringed button is this defect; some
 * controls are simply unstyled. A `:hover` rule is evidence that a pointer
 * state was DESIGNED for this control and the keyboard state was forgotten,
 * which is the asymmetry WCAG 2.1 AA 2.4.7 is about. (Unringed buttons with no
 * hover rule are a larger, separate finding — see `Cebab-p5y`'s notes.)
 *
 * THE SCAN IS DERIVED, NOT LISTED. A hardcoded list of thirteen classes would
 * pass forever after someone deletes the fourteenth control's hover rule and
 * adds a fifteenth. Both sides are recomputed from `styles.css` and the TSX on
 * every run, so a NEW hover-styled button with no ring fails this the day it
 * lands.
 */
describe('[a11y] a hover-styled button has a focus ring too (Cebab-p5y)', () => {
  const hoverStyled = new Set<string>();
  const ringed = new Set<string>();
  for (const r of RULES) {
    for (const part of r.selector.split(',')) {
      for (const m of part.matchAll(/\.([a-z0-9][a-z0-9-]*):hover/gi)) hoverStyled.add(m[1]!);
      for (const m of part.matchAll(/\.([a-z0-9][a-z0-9-]*):focus-visible/gi)) ringed.add(m[1]!);
    }
  }

  /**
   * Classes reaching a ring through an ANCESTOR rather than their own, each
   * naming the selector that does it. Listed rather than silently skipped,
   * same contract as `OUTLINE_EXEMPT`: the container selector must still exist
   * in the stylesheet, and adding an entry is a hole that has to be argued
   * for. Verified by walking the JSX ancestry, not by assuming from the name.
   */
  const CONTAINER_RINGED: Array<{ cls: string; container: string; why: string }> = [
    {
      cls: 'input-box-btn-stop',
      container: '.input-box button:focus-visible',
      why: 'rendered inside <div className="input-box"> (InputBox.tsx), so the container rule rings it; a rule of its own would be a duplicate of the same declarations',
    },
  ];

  /** Balanced-brace slice of a `{...}` starting at `open`. */
  function braced(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return '';
  }

  /**
   * Literal class tokens on every `<button>` in the TSX.
   *
   * TWO PARSING HAZARDS, both of which produced a silently short list on the
   * first pass and were caught only because a class showed up while its
   * obvious sibling did not:
   *
   *  - the tag does NOT end at the first `>`. An `onClick={() => …}` arrow
   *    puts one inside the attribute list, so the scan has to skip braced
   *    expressions to find the real close. Measured: this one class of
   *    truncation costs exactly one control, `.logs-button`, whose
   *    `className` sits after such an attribute. The others survive by
   *    accident of ordering, which is not a property to rely on.
   *  - `${…}` interpolations must be blanked BEFORE tokenising. A quote inside
   *    one (`` `permission-allow${armed ? ' is-armed' : ''}` ``) otherwise
   *    terminates the string match and swallows every class AFTER the first —
   *    measured at 14 controls, `.permission-allow` and `.managed-file-tab`
   *    among them. It is how `.permission-allow` hid while `.permission-deny`,
   *    a plain string two lines below it, was found; a scan that returns a
   *    short list returns it silently.
   *
   * Dynamic class names are out of reach by construction; this reads what is
   * literally in the source, which is what the stylesheet can be checked
   * against.
   */
  const tsx = import.meta.glob('./**/*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const buttonSites: string[][] = [];
  for (const [file, src] of Object.entries(tsx)) {
    if (file.includes('.test.')) continue;
    for (const m of src.matchAll(/<button\b/g)) {
      let i = m.index! + '<button'.length;
      let end = -1;
      while (i < src.length && i < m.index! + 4000) {
        if (src[i] === '{') {
          i += braced(src, i).length + 2;
          continue;
        }
        if (src[i] === '>') {
          end = i;
          break;
        }
        i++;
      }
      if (end === -1) continue;
      const tag = src.slice(m.index!, end);
      const ci = tag.indexOf('className=');
      if (ci === -1) continue;
      const after = tag.slice(ci + 'className='.length);
      const raw = after.startsWith('{') ? braced(after, 0) : (after.match(/^"([^"]*)"/)?.[1] ?? '');
      let flat = raw;
      for (let g = 0; g < 8; g++) flat = flat.replace(/\$\{[^{}]*\}/g, ' ');
      const toks = [...flat.matchAll(/[`"']([^`"']*)[`"']/g)]
        .flatMap((t) => t[1]!.split(/\s+/))
        .filter((t) => /^[a-z][a-z0-9-]*$/i.test(t));
      const bare = /^[a-z][a-z0-9-\s]*$/i.test(flat) ? flat.split(/\s+/) : [];
      const classes = [...new Set([...toks, ...bare])].filter(Boolean);
      if (classes.length) buttonSites.push(classes);
    }
  }

  const onButtons = new Set(buttonSites.flat());
  const exempt = new Set(CONTAINER_RINGED.map((e) => e.cls));

  /**
   * A hover-styled button class is covered iff it has a ring of its own, or
   * EVERY button carrying it also carries a class that does. "Every", not
   * "some": one unringed site is one control a keyboard user loses.
   */
  /**
   * Does any button carrying `cls` leave it without a ring?
   *
   * EXTRACTED so the "every site, not some site" rule can be exercised on
   * input where the two answers differ. Against the live stylesheet they
   * cannot: once every class is covered, `.some` and `.every` are both empty
   * and a mutation between them is invisible — a green that means "this
   * scenario cannot tell the two apart", not "the rule is right".
   */
  function hasUnringedSite(
    cls: string,
    sites: readonly (readonly string[])[],
    hasRing: (c: string) => boolean,
  ): boolean {
    return sites
      .filter((site) => site.includes(cls))
      .some((site) => !site.some((o) => o !== cls && hasRing(o)));
  }

  const uncovered = [...hoverStyled]
    .filter((c) => onButtons.has(c) && !ringed.has(c) && !exempt.has(c))
    .filter((c) => hasUnringedSite(c, buttonSites, (o) => ringed.has(o)))
    .sort();

  test('the scan found real rules on both sides', () => {
    // Every assertion below is "this list is empty", which an empty scan
    // satisfies for the wrong reason — the exact shape of defect this file
    // exists to catch, one level up. These floors fail on a broken scan.
    expect(RULES.length).toBeGreaterThan(500);
    expect(hoverStyled.size).toBeGreaterThanOrEqual(60);
    expect(ringed.size).toBeGreaterThanOrEqual(50);
    expect(buttonSites.length).toBeGreaterThanOrEqual(150);
    // The two parse hazards above, each pinned by the control that is
    // MEASURABLY lost when that fix is reverted — not by a plausible-looking
    // one. `.spine-chip` was the first choice here and is wrong: its class is
    // the first token in its template literal, so it survives the
    // interpolation bug by ordering and the assertion would have proved
    // nothing.
    expect(onButtons.has('logs-button'), 'lost when the tag-end scan truncates').toBe(true);
    expect(onButtons.has('permission-allow'), 'lost when `${…}` is not blanked').toBe(true);
  });

  test('every container exemption still exists and still rings', () => {
    for (const { cls, container } of CONTAINER_RINGED) {
      expect(onButtons.has(cls), `exempt class no longer on any button: ${cls}`).toBe(true);
      const rule = RULES.find((r) => r.selector.replace(/\s+/g, ' ').includes(container));
      expect(rule, `container rule gone: ${container}`).toBeDefined();
      expect(rule!.body).toMatch(/outline:\s*\d/);
    }
  });

  test('one unringed site is enough — a class ringed at SOME sites is not covered', () => {
    // The rule that the live stylesheet cannot exercise. `.danger` really does
    // ride on several buttons and reach a ring through a base class at each,
    // so "some site is ringed" and "every site is ringed" agree there. The
    // case that matters is the one that has not happened yet: the same
    // modifier used once WITHOUT its base class. One unringed site is one
    // control a keyboard user loses, so it must fail.
    const ringed2 = (c: string) => c === 'base-btn';
    const sites = [
      ['base-btn', 'danger'],
      ['danger'], // the site with no base class
    ];
    expect(hasUnringedSite('danger', sites, ringed2)).toBe(true);
    // Control in the other direction: every site ringed → covered. Without
    // this, a predicate hardwired to `true` would pass the case above.
    expect(hasUnringedSite('danger', [['base-btn', 'danger']], ringed2)).toBe(false);
  });

  test('no hover-styled button class is left without a reachable focus ring', () => {
    expect(uncovered).toEqual([]);
  });
});
