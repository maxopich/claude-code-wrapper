/**
 * "Is this scroller still following its tail?"
 *
 * Register W14: the chat pane re-scrolled to `scrollHeight` on every streamed
 * delta with no check of where the operator was, so reading back through a
 * running session was impossible — each token yanked the pane down. The same
 * unguarded re-scroll existed a second time in `AuthRefreshModal`, spelled
 * `scrollTop = scrollHeight` rather than `scrollTo` but identical in effect,
 * and worse in kind there: that modal exists so the operator can read an OAuth
 * URL, and every new chunk dragged it off screen mid-read.
 *
 * THE DECISION THAT MATTERS, because the obvious implementation is wrong.
 * Measuring the offset *inside the effect that reacts to new content* does not
 * work: by then `scrollHeight` has already grown, so an operator who was pinned
 * to the bottom reads as "scrolled up by the height of whatever just arrived".
 * One long tool result and the pane silently stops following. So the pin is
 * tracked on `scroll` — where the number still describes where the operator
 * chose to be — and the content effect only *consults* it.
 *
 * A programmatic scroll-to-bottom fires `scroll` too, and lands at distance ≈ 0
 * → the handler recomputes `true`, the value it already held. So this needs no
 * "was that scroll ours or theirs?" bookkeeping, which is the usual source of
 * flapping in stick-to-bottom implementations.
 *
 * Extracted as a pure function rather than inlined into the two components, for
 * the reason `drawerState.ts` gives and one more that is specific to scrolling:
 * **jsdom performs no layout, so `scrollTop`, `scrollHeight` and `clientHeight`
 * all read `0`** — and `0 - 0 - 0 <= threshold` is `true`, whatever `scrollTop`
 * is set to. Measured, because the obvious way to describe that is wrong: an
 * unstaged component spec does not silently go green, it cannot express the bug
 * at all. The negative case ("scrolled up, so no scroll") fails against this
 * fix *and* against the unguarded original, and the only assertion left
 * writable is the positive one — which the unguarded original passes too. So
 * the trap is not a green test hiding a red one; it is that skipping the setup
 * leaves you asserting the half both implementations satisfy.
 *
 * `scrollAnchor.test.ts` feeds synthetic metrics so the rule is pinned somewhere
 * the environment cannot answer for it, and both component specs stage the three
 * numbers explicitly. See the all-zeroes note on `isPinnedToBottom` below.
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
