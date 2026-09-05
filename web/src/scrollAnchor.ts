/**
 * "Is this scroller still following its tail?" — register W14.
 *
 * THE DECISION THAT MATTERS, because the obvious implementation is wrong: the
 * offset is measured in the `scroll` handler, never in the effect that reacts
 * to new content. By the time that effect runs `scrollHeight` has already
 * grown, so an operator pinned to the bottom reads as "scrolled up by the
 * height of whatever just arrived" and the pane silently stops following.
 * `scrollAnchor.test.ts`'s W14 describe enforces that against both call sites;
 * it carries the incident, and it is why this paragraph is three lines rather
 * than the twenty it used to be.
 *
 * A programmatic scroll-to-bottom fires `scroll` too and lands at distance ≈ 0,
 * so the handler recomputes the value it already held. No "was that scroll ours
 * or theirs?" bookkeeping is needed — which is the usual source of flapping in
 * stick-to-bottom implementations, and the reason not to add any.
 */

/**
 * How far from the bottom still counts as "following", in CSS pixels.
 *
 * Absorbs sub-pixel rounding (a clamped `scrollTo` can land fractionally short
 * on fractional device-pixel ratios) plus about a line and a half of slack, so
 * a stray trackpad nudge does not un-stick the pane. A deliberate scroll — one
 * wheel notch is ~100px — is well clear of it.
 *
 * The `_PX` suffix is deliberate: register N23 is open about a constant that
 * carries no unit while its siblings do.
 */
export const SCROLL_STICK_THRESHOLD_PX = 32;

/** The three numbers a scroll container reports. `Element` structurally satisfies this. */
export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * True when the scroller is at, or within `thresholdPx` of, its bottom.
 *
 * NOTE — the all-zeroes case returns `true`, and that is both correct and the
 * trap: a container with no overflow (nothing to scroll) IS at its bottom, and
 * an *unstaged jsdom element* reports exactly the same thing while meaning
 * "layout never ran". Same answer, opposite significance. Any test that renders
 * a component and asserts on scroll behaviour must stage these three numbers or
 * it is measuring the second case while claiming the first.
 */
export function isPinnedToBottom(
  metrics: ScrollMetrics,
  thresholdPx: number = SCROLL_STICK_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}
