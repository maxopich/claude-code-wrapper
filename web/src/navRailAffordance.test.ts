import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import { topLevelRules } from './cssColor.js';

/**
 * The collapsed nav rail shows how to open itself (Cebab-vl5, Cebab-7dk).
 *
 * The rail collapses to 66px when unpinned. Above the narrow tier the
 * hamburger is `display: none` (it is the mobile affordance) and
 * `permanentPanels` is false on any 16:10 display, so on a laptop at desktop
 * width the ONLY route to the project list was hovering that strip — while
 * the composer told the operator to pick a project "in the sidebar". The pin,
 * the one control that expands it, was faded to `opacity: 0` until you had
 * already found it, and carried no focus ring at all.
 *
 * Two rules hold the fix:
 *
 *   1. No rule fades the SIDEBAR pin. The inspector may still fade its own —
 *      it is secondary, reached from a session that is already running — and
 *      test 3 keeps that split deliberate rather than letting a blanket
 *      delete pass as this fix.
 *   2. `.pin-btn` is in the shared accent focus ring.
 *
 * NOT covered here: `:focus-within` parity across the rail rules, which is
 * `railFocus.test.ts` (U02) and still applies to the inspector's fade; whether
 * the ring has enough contrast (`styleContrast.test.ts`); and the first-run
 * pinned default, which is a localStorage question and lives in
 * `navPinnedDefault.test.ts`.
 */

const RULES = topLevelRules(stylesCss);

/** Rules that fade something to nothing. */
const FADE_TO_ZERO = RULES.filter((r) => /opacity:\s*0\s*;/.test(r.body));

/** …and specifically the ones that fade a rail's pin button. */
const PIN_FADES = FADE_TO_ZERO.filter((r) => r.selector.includes('.pin-btn'));

describe('[a11y] the collapsed nav rail shows how to open it (Cebab-vl5)', () => {
  test('the scan found real rules, including the pin', () => {
    // Anti-vacuity: a broken parser returns [] and "no rule fades the sidebar
    // pin" is trivially true — which is the same shape as the bug.
    expect(RULES.length).toBeGreaterThan(500);
    expect(FADE_TO_ZERO.length).toBeGreaterThanOrEqual(5);
    expect(RULES.some((r) => r.selector === '.pin-btn')).toBe(true);
  });

  test('nothing fades the sidebar pin out of view', () => {
    // The failing state this whole bead is about: `opacity: 0` (plus
    // `pointer-events: none`) on the sidebar's own pin while the rail is
    // collapsed, i.e. exactly when it is the only way back in.
    const sidebarFades = PIN_FADES.filter((r) => r.selector.includes('.sidebar')).map((r) =>
      r.selector.replace(/\s+/g, ' '),
    );
    expect(sidebarFades).toEqual([]);
  });

  test('the inspector still fades its own pin, and still answers focus', () => {
    // Keeps the split honest in the other direction. Deleting the rule
    // outright would also satisfy the test above, and would silently change a
    // second rail this bead never measured.
    const inspectorFades = PIN_FADES.filter((r) => r.selector.includes('.inspector'));
    expect(inspectorFades).toHaveLength(1);
    expect(inspectorFades[0]!.selector).toContain(':focus-within');
  });
});

describe('[a11y] the pin control has a focus ring (Cebab-7dk)', () => {
  test('.pin-btn is in the shared accent ring', () => {
    // It was absent, so Tab landed on the app's primary navigation control
    // and nothing on screen changed. Asserted through the parser rather than
    // by string search so a grouped selector that the parser mangles fails
    // here rather than passing on a substring.
    const ring = RULES.find(
      (r) => r.selector.includes('.pin-btn:focus-visible') && /outline:/.test(r.body),
    );
    expect(ring, '.pin-btn has no :focus-visible rule that sets an outline').toBeDefined();
    expect(ring!.body).toContain('outline: 2px solid var(--accent)');
  });

  test('and it is the shared rule, not a private one that could drift', () => {
    const ring = RULES.find((r) => r.selector.includes('.pin-btn:focus-visible'))!;
    expect(ring.selector).toContain('.primary-btn:focus-visible');
  });
});
