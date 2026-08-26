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

describe('[a11y] hover-styled buttons carry a focus ring at all (Cebab-p5y)', () => {
  /**
   * The gap U19/U20 leave open. Both ask whether a control's focus style is
   * DISTINCT from its hover style (U20: outline not stripped) or whether a
   * hover-REVEALED control is also focus-revealed (U19). Neither asks the prior
   * question: does a button that restyles on `:hover` have a focus ring AT ALL?
   * A button with a `:hover` rule and no `:focus-visible` anywhere takes Tab
   * focus with no visible position — WCAG 2.1 AA 2.4.7 — and passes both gates
   * above vacuously, because there is no focus rule for them to inspect.
   *
   * The list is closed and each entry was confirmed per case against the TSX,
   * because the raw scan that sized this (11 classes with a `:hover` rule, no
   * `:focus-visible`, class-name on a button) over-counts three ways, and each
   * exclusion is a distinct failure of that heuristic:
   *
   *   - `.tpl-item` sits on an `<li>`, not a button; its `:hover` is a row
   *     highlight, and an `<li>` takes no Tab focus. (The button inside it is
   *     `.tpl-item-main`, which has no `:hover` and so was never flagged.)
   *   - `.permission` is `.msg.permission`, the message-frame `<div>`; the
   *     `:hover` selectors carrying that class are `.permission-allow` /
   *     `.permission-deny` DESCENDANTS. The container is not focusable.
   *   - `.danger` is a modifier that only ever rides `.bulk-action-btn` (three
   *     TSX sites, all `bulk-action-btn danger`); the base class's ring covers
   *     it, so it needs no rule of its own.
   *
   * Where a hover rule sits on a base class the button shares (the permission
   * pair share `.msg.permission button`), the ring is keyed there so the whole
   * family is covered, not just the one variant the scan happened to name.
   */
  const RINGED_BUTTONS: Array<{ ring: string; why: string }> = [
    { ring: '.ask-user-option:focus-visible', why: 'AskUserQuestionCard option button' },
    {
      ring: '.bulk-action-btn:focus-visible',
      why: 'ProjectList bulk-op button; covers the .danger variant',
    },
    { ring: '.notif-inbox-chip:focus-visible', why: 'NotificationInbox tier-filter chip button' },
    {
      ring: '.msg.permission button:focus-visible',
      why: 'permission Allow + Deny (+ armed Allow) share this base',
    },
    { ring: '.slash-command-btn:focus-visible', why: 'SlashCommandButtons button' },
    { ring: '.stopped-marker-skip:focus-visible', why: 'StoppedMarker Skip button' },
    { ring: '.tpl-item-del:focus-visible', why: 'MultiAgentTab template-delete button' },
    {
      ring: '.trust:focus-visible',
      why: 'ProjectList trust toggle button; fades with the rail',
    },
  ];

  test('the curated list is non-empty and the parser can see focus rules', () => {
    // Vacuity guard: if the parser returned [] every `.find` below is undefined
    // and the loop would assert nothing. Anchored to the same >500 floor the
    // U20 block uses, so a broken scan reddens here rather than passing silently.
    expect(RINGED_BUTTONS.length).toBeGreaterThanOrEqual(8);
    expect(RULES.length).toBeGreaterThan(500);
    expect(focusRules.length).toBeGreaterThanOrEqual(15);
  });

  test.each(RINGED_BUTTONS.map((b) => [b.ring, b] as const))(
    '%s exists and sets the shared accent ring',
    (_label, { ring }) => {
      const rule = focusRules.find((r) => r.selector.replace(/\s+/g, ' ') === ring);
      // Fails before the fix: none of these rules existed, so `rule` is
      // undefined. The defect is the ABSENCE of a ring, so a bare existence
      // check would be satisfied by an empty declaration block — assert the
      // outline is actually drawn, and in the house accent, not `none`.
      expect(rule, `no focus ring for a hover-styled button: ${ring}`).toBeDefined();
      expect(rule!.body).toMatch(/outline:\s*2px\s+solid\s+var\(--accent\)/);
      expect(rule!.body).not.toMatch(/outline:\s*none/);
    },
  );
});
