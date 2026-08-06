import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';

/**
 * The collapsible rails answer to the keyboard, not only the mouse (U02).
 *
 * The sidebar and inspector collapse when unpinned and expand on `:hover`.
 * Their contents were faded with `opacity: 0; pointer-events: none` — which
 * stops the mouse and does nothing at all to focus. So Tab moved through an
 * invisible sidebar, and the only way to reveal what was focused was to hover
 * it, which a keyboard user by definition is not doing. On a 16:9 desktop at
 * ≥1120px `permanentPanels` pins both rails and the bug never appears; on a
 * 16:10 laptop or a narrow window it is there on first load, which is why it
 * went unnoticed.
 *
 * The fix is parity, not suppression: every rail rule that consults `:hover`
 * also consults `:focus-within`. (The register's other suggestion, `inert`,
 * would have made the collapsed rail unreachable — including the pin button,
 * the only control that gets a keyboard user out of the collapsed state.)
 *
 * This gate holds that pairing for the whole file rather than for a list of
 * line numbers, so a rail rule added later is covered without anyone
 * remembering this file exists.
 *
 * NOT covered: whether the expanded rail is actually *usable*, whether focus
 * order inside it is sensible, or the narrow-tier drawers (which use
 * `data-nav-open`, not hover, and have their own finding in U25).
 */

/** Selector text of every rule in the stylesheet, in source order.
 *
 *  A brace scan rather than a regex: selectors here span lines and contain
 *  `:is(…)` / `:not(…)` groups, and the media/keyframes blocks mean a naive
 *  `{`-split would hand back at-rule preludes as if they were selectors. */
function ruleSelectors(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const prelude = css.slice(start, i).trim();
        // Skip at-rules (`@media`, `@keyframes`, …) — their prelude is not a
        // selector, and their inner rules are reached on the next iteration
        // because we keep scanning at depth 1.
        if (!prelude.startsWith('@')) out.push(prelude);
        else out.push('');
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) start = i + 1;
      // Inside an at-rule, a closing brace at depth 1 ends a nested rule;
      // reset the prelude start so the next selector is read cleanly.
      if (depth === 1) start = i + 1;
    } else if (depth === 1 && (ch === ';' || ch === '\n')) {
      // no-op: declarations inside a rule; the prelude tracker only matters
      // at depth 0 and immediately after a nested rule closes.
    }
  }
  return out.map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter((s) => s !== '');
}

const SELECTORS = ruleSelectors(stylesCss);

/**
 * Does this selector gate on hover **of a rail itself**?
 *
 * The distinction matters: `.sidebar-resizer:hover` and the like are ordinary
 * hover affordances on controls that happen to live in the rail, and they are
 * not part of the collapse contract — widening them would be noise. What this
 * gate is about is `.sidebar` / `.inspector` carrying a hover pseudo directly,
 * because that is what decides whether the rail is open and whether its
 * contents are visible.
 *
 * Implemented as a scan rather than a regex: eslint bans constructed ones
 * here, and the rule ("the class name is followed immediately by a pseudo
 * chain that mentions hover") reads more plainly written out.
 */
function gatesOnRailHover(selector: string): boolean {
  for (const rail of ['.sidebar', '.inspector']) {
    for (let i = selector.indexOf(rail); i !== -1; i = selector.indexOf(rail, i + 1)) {
      let j = i + rail.length;
      if (selector[j] !== ':') continue; // `.sidebar-resizer`, `.sidebar h1`, …
      // Take the pseudo chain up to the next combinator or list separator.
      while (j < selector.length && !' ,>+~\n\t'.includes(selector[j]!)) j++;
      if (selector.slice(i, j).includes('hover')) return true;
    }
  }
  return false;
}

/** Rules whose selector decides a rail's collapsed/expanded appearance. */
const RAIL_HOVER = SELECTORS.filter(gatesOnRailHover);

describe('[a11y] collapsible rails respond to focus, not only hover', () => {
  test('the selector scan found real rules', () => {
    // Guard against a vacuous pass: a broken scan returns [] and every
    // assertion below would hold over nothing.
    expect(SELECTORS.length).toBeGreaterThan(500);
    expect(SELECTORS).toContain('.sidebar');
  });

  test('every hover-conditional rail rule was discovered', () => {
    // Eight selector strings at the time of writing: 2 expand rules, 2
    // content-fade rules, the pin-button rule (one rule, two comma-joined
    // selectors — hence eight strings for nine rail selectors), and 3
    // sidebar-footer/workspace rules. A count that only grows: a drop means
    // this gate stopped seeing rules, not that the rules went away.
    expect(RAIL_HOVER.length).toBeGreaterThanOrEqual(8);
  });

  test.each(RAIL_HOVER.map((s, i) => [`#${i} ${s.slice(0, 72)}`, s] as const))(
    '%s also handles :focus-within',
    (_label, selector) => {
      expect(selector).toContain(':focus-within');
    },
  );

  test('the two forms are used consistently', () => {
    // `:hover` alone must be widened to `:is(:hover, :focus-within)`; a
    // negated `:not(:hover)` must gain a matching `:not(:focus-within)`.
    // Anything else means a rule mentions focus somewhere but not in a way
    // that pairs with its hover test.
    for (const selector of RAIL_HOVER) {
      const widened = selector.split(':is(:hover, :focus-within)').length - 1;
      const negated = selector.split(':not(:hover):not(:focus-within)').length - 1;
      const hoverMentions = selector.split(':hover').length - 1;
      expect({ selector, paired: widened + negated }).toEqual({
        selector,
        paired: hoverMentions,
      });
    }
  });
});
