import { describe, expect, test } from 'vitest';
// Vite's ?raw suffix returns the file contents as a string at build
// time (vite-env.d.ts declares the module). No Node fs dependency, so
// the test runs cleanly in the web workspace's jsdom env.
import stylesCss from '../../styles.css?raw';

/**
 * Risk #1 CI guard (PR-2): every `.tpl-*` `animation:` declaration that
 * sets a non-`none` value MUST live inside the
 * `@media (prefers-reduced-motion: no-preference) { … }` block.
 *
 * Why: a stray `animation:` outside that block would fire even for
 * users with `prefers-reduced-motion: reduce`. The component's JS guard
 * (omit the <circle>) is belt-and-braces — the CSS gate is the
 * primary protection. We've broken this once before; this test makes a
 * re-break visible at commit time.
 *
 * Tolerated:
 *   - `animation: none` anywhere (e.g., the reduce-block override).
 *   - keyframes (`@keyframes tpl-*`) anywhere — they don't fire unless
 *     a selector references them via `animation:`.
 */

const NO_PREF_OPEN = '@media (prefers-reduced-motion: no-preference) {';

/** Strip the body of every `@media (prefers-reduced-motion: no-preference)`
 *  block from `css`, leaving the surrounding text intact. Uses balanced
 *  brace matching from the opener so nested rules inside the media
 *  block are removed correctly. */
function stripNoPreferenceBlocks(css: string): string {
  let out = css;
  for (;;) {
    const open = out.indexOf(NO_PREF_OPEN);
    if (open === -1) break;
    let depth = 1;
    let i = open + NO_PREF_OPEN.length;
    while (i < out.length && depth > 0) {
      const ch = out[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    // Replace the entire media block (open..close inclusive) with empty.
    out = out.slice(0, open) + out.slice(i);
  }
  return out;
}

/** Find rule blocks whose selector touches `.tpl-` and whose body sets
 *  `animation:` to a non-none value. Returns the offending selectors. */
function findTplAnimationRules(css: string): string[] {
  const violations: string[] = [];
  // Match a top-level CSS rule: `<selector> { <body> }`. Selectors can
  // span multiple lines; bodies don't nest in our codebase outside
  // @media, which we've already stripped, so a simple greedy body
  // match works.
  const ruleRe = /([^{}@][^{}]*?)\{([^{}]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1]!.trim();
    const body = m[2]!;
    if (!selector.includes('.tpl-')) continue;
    // Allow `animation: none` (explicit cancellation, used in reduce blocks).
    const animRe = /animation:\s*([^;]+)/g;
    let am: RegExpExecArray | null;
    while ((am = animRe.exec(body)) !== null) {
      const value = am[1]!.trim();
      if (value === 'none') continue;
      violations.push(`${selector} { animation: ${value} }`);
    }
  }
  return violations;
}

/**
 * The rule above, generalised past `.tpl-*` — WCAG 2.2.2.
 *
 * Register U12 claimed the sidebar live dot, the session-row live marker and
 * the streaming caret "run an infinite pulse … while twelve other animations
 * are carefully gated". That finding is WRONG, and this is how it was
 * settled: all three are already cancelled in the big reduce block ~4,600
 * lines below where they are declared, and so are both spinners. The distance
 * between the `animation:` and its cancellation is what made the gap look
 * real to a reader — and is exactly why a scan beats reading.
 *
 * What was actually missing was any check at all beyond the `.tpl-*` prefix,
 * so the next ungated loop would have shipped unnoticed. Hence: no CSS
 * change, a real gate. The rule is not "no animations" — a one-shot enter or
 * fade is fine under reduce — it is that content moving *indefinitely* must
 * be stoppable, so only `infinite` counts.
 */

/** Selectors whose infinite animation may survive `reduce`, with the reason.
 *  EMPTY, and that is the finding: every infinite animation in this
 *  stylesheet is gated today, including the two busy spinners, so the gate
 *  needs no exceptions to pass. Adding one is a decision to leave a
 *  reduced-motion user with movement on screen — it belongs in review, not in
 *  a quiet pattern tweak, which is why the list is asserted below. */
const MOTION_EXEMPT: Array<{ selector: string; why: string }> = [];

/** Rules that set an `infinite` animation, paired with their selector. */
function findInfiniteAnimationRules(css: string): string[] {
  const violations: string[] = [];
  const ruleRe = /([^{}@][^{}]*?)\{([^{}]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1]!.trim();
    const body = m[2]!;
    for (const am of body.matchAll(/animation:\s*([^;]+)/g)) {
      const value = am[1]!.trim();
      if (!/\binfinite\b/.test(value)) continue;
      if (MOTION_EXEMPT.some((e) => selector.split(',').some((s) => s.trim() === e.selector))) {
        continue;
      }
      violations.push(`${selector} { animation: ${value} }`);
    }
  }
  return violations;
}

/** Strip every `@media (prefers-reduced-motion: reduce)` block, so a rule
 *  that only exists to cancel motion isn't itself reported as motion. */
function stripReduceBlocks(css: string): string {
  const OPEN = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let out = css;
  for (;;) {
    OPEN.lastIndex = 0;
    const m = OPEN.exec(out);
    if (!m) return out;
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < out.length && depth > 0) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
      i++;
    }
    out = out.slice(0, m.index) + out.slice(i);
  }
}

/** Selectors this stylesheet cancels under `reduce`. */
function reduceCancelledSelectors(css: string): Set<string> {
  const out = new Set<string>();
  const OPEN = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = OPEN.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const inner = css.slice(start, i - 1);
    for (const r of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/animation:\s*none/.test(r[2]!)) continue;
      for (const s of r[1]!.split(',')) out.add(s.trim());
    }
  }
  return out;
}

describe('CSS gate (Risk #1)', () => {
  test('every .tpl-* animation: lives inside the no-preference block', () => {
    const stripped = stripNoPreferenceBlocks(stylesCss);
    const violations = findTplAnimationRules(stripped);
    expect(violations).toEqual([]);
  });

  test('[a11y] every infinite animation is motion-gated or explicitly exempt', () => {
    // Outside a no-preference block AND outside a reduce block: what is left
    // is motion that runs for everyone, forever.
    const ungated = findInfiniteAnimationRules(
      stripReduceBlocks(stripNoPreferenceBlocks(stylesCss)),
    );
    const cancelled = reduceCancelledSelectors(stylesCss);
    const survives = ungated.filter((v) => {
      const selector = v.slice(0, v.indexOf(' {')).trim();
      return !selector.split(',').every((s) => cancelled.has(s.trim()));
    });
    expect(survives).toEqual([]);
  });

  test('[a11y] the five perpetual indicators stay cancelled under reduce', () => {
    // Positive lock, and the evidence that register U12 was a false finding.
    // The negative scan above also passes if a selector is simply deleted;
    // this one fails if a cancellation is dropped while its element stays.
    const cancelled = reduceCancelledSelectors(stylesCss);
    for (const s of [
      '.project-live-dot.on', // sidebar live-session dot
      '.session-marker.live', // session-row live marker
      '.caret', // streaming caret
      '.btn-spinner', // in-button busy state
      '.input-box-btn-stop.is-stopping::after', // stop-button spinner
    ]) {
      expect(cancelled, `${s} must be cancelled under reduce`).toContain(s);
    }
  });

  test('[a11y] no infinite animation is exempted from the motion gate', () => {
    // Every entry here would be a place a reduced-motion user still sees
    // movement. The list is empty today and adding to it should be a visible
    // decision, not a quiet edit that turns the scan above into a formality.
    expect(MOTION_EXEMPT).toEqual([]);
  });

  test('reduce-motion block still cancels .tpl-flow-dot animation', () => {
    // Belt-and-braces: even though no .tpl-* animation can fire outside
    // no-preference (above test), the reduce block also forces
    // `.tpl-flow-dot { animation: none; display: none }` as a defense.
    expect(stylesCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(stylesCss).toMatch(/\.tpl-flow-dot\s*\{\s*display:\s*none/);
  });
});

describe('CSS gate — PR-5 motion polish', () => {
  // PR-5 (round 2): the trip-dot's hue handoff was moved out of
  // keyframes (inline `fill` set by AgentDiagram per leg). The
  // keyframes must stay fill-free so the dot's color doesn't
  // interpolate across the trip — that interpolation caused the
  // mid-trip velocity kink the PR was written to eliminate.
  test('tpl-flow keyframes contain no fill declaration', () => {
    // Match either keyframe block; the body cannot mention `fill:`.
    expect(stylesCss).not.toMatch(/@keyframes\s+tpl-flow-forward\s*\{[^}]*fill:/);
    expect(stylesCss).not.toMatch(/@keyframes\s+tpl-flow-return\s*\{[^}]*fill:/);
  });

  test('.tpl-flow-dot opts into compositor with will-change', () => {
    // Without will-change: offset-distance, browsers fall back to
    // main-thread paint for the SVG dot, visible as a mid-trip stutter
    // on slower machines.
    expect(stylesCss).toMatch(/\.tpl-flow-dot\s*\{[^}]*will-change:\s*offset-distance/);
  });

  test('.tpl-stage uses contain: layout style (NOT size)', () => {
    // `contain: layout style` scopes invalidations to the stage; adding
    // `size` would break the figure's aspect-ratio sizing contract.
    //
    // The `.tpl-stage` block has CSS comments that mention `}` (e.g.
    // `figure { margin: 1em 40px }` cited as an explanation). Strip
    // comments first so the [^}] body match doesn't terminate inside
    // the wrong rule.
    const noComments = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const stageBlock = noComments.match(/\.tpl-stage\s*\{[^}]*\}/);
    expect(stageBlock).not.toBeNull();
    expect(stageBlock![0]).toMatch(/contain:\s*layout\s+style/);
    // Belt: ensure we didn't accidentally add `contain: size` anywhere
    // on .tpl-stage.
    expect(stageBlock![0]).not.toMatch(/contain:\s*size/);
  });

  test('arrival keyframes split per tile kind (rect vs badge base widths)', () => {
    // The badge tile has base stroke-width 3 (PR-4 hue ring); a single
    // 1→2.4→1 keyframe would dip below base. Two keyframes — one
    // anchored at 1, one at 3 — keep the pulse direction "out then in"
    // for both tile kinds.
    expect(stylesCss).toMatch(/@keyframes\s+tpl-node-arrival-rect/);
    expect(stylesCss).toMatch(/@keyframes\s+tpl-node-arrival-badge/);
  });
});

describe('CSS gate — PR-3 directional markers', () => {
  test('orchestrator arrowhead and tail both declare a fill', () => {
    // The visual contract for PR-3: every orchestrator edge has BOTH a
    // tail marker at the hub end AND an arrowhead at the worker end.
    // Each marker references one of these two classes; if either lacks
    // a fill, the marker renders invisibly and the directional
    // affordance silently breaks.
    expect(stylesCss).toMatch(/\.tpl-arrowhead--out\s*\{[^}]*fill\s*:/);
    expect(stylesCss).toMatch(/\.tpl-arrowtail--in\s*\{[^}]*fill\s*:/);
  });

  test('forced-colors block remaps edges + markers to ButtonText', () => {
    // Windows High Contrast (and other forced-colors environments) drop
    // author colors and substitute system tokens. The figure stops
    // being readable if edges/markers don't opt into ButtonText.
    expect(stylesCss).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    // The selector list inside the forced-colors block must include
    // both new orchestrator marker classes; the chain marker
    // (`.tpl-arrowhead`) is also included so chain templates remap too.
    const forcedColors = stylesCss.match(/@media\s*\(forced-colors:\s*active\)\s*\{[\s\S]*?\n\}/);
    expect(forcedColors).not.toBeNull();
    const block = forcedColors![0];
    expect(block).toMatch(/\.tpl-edge\s*\{[^}]*stroke\s*:\s*ButtonText/);
    expect(block).toMatch(/ButtonText/);
    expect(block).toMatch(/\.tpl-arrowhead--out/);
    expect(block).toMatch(/\.tpl-arrowtail--in/);
  });

  test('figcaption uses the --t-xs typography token', () => {
    // The figcaption must NOT regress to a hard-coded font-size; the
    // typography pass (PR-#86) standardized text via --t-* tokens.
    expect(stylesCss).toMatch(/\.tpl-figcaption\s*\{[^}]*font-size\s*:\s*var\(--t-xs\)/);
  });
});
