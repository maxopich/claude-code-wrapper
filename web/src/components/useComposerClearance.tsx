// This hook carries no JSX, but it lives in a `.tsx` file on purpose: it is the
// one place `--composer-clearance` is written at runtime, and `styleTokens.test.ts`
// proves every runtime-set token is set by a component by globbing `**/*.tsx`.
// A `.ts` here would set the token invisibly to that gate.
import { useEffect, type RefObject } from 'react';

/**
 * The custom property the on-screen composer publishes its height on, read by
 * `.notif-stack` in `styles.css` so the notification dock clears the composer
 * (`Cebab-aids`). Exported so a test asserts the same string the hook writes —
 * a hand-copied name in the test would keep passing after a rename while the
 * stylesheet quietly stopped matching.
 */
export const COMPOSER_CLEARANCE_VAR = '--composer-clearance';

/**
 * `Cebab-aids` / `Cebab-xqad`: the notification dock and every composer's
 * primary action (Send / Start) live in the bottom-right corner, and nothing
 * in the stack says which one yields. Measured live — with a toast up,
 * `document.elementFromPoint` at the button's own centre returned
 * `notif-message`, and real clicks were swallowed with no error and no visual
 * response. From the operator's side that is indistinguishable from the app
 * ignoring them, and it lands exactly when notifications are arriving.
 *
 * THE OBVIOUS FIX IS THE WRONG ONE. Making the toast cards
 * `pointer-events: none` would let the click through, but `.notif-stack > .notif`
 * is `auto` ON PURPOSE (`Cebab-git`): the dock is height-capped and scrolls
 * internally, and the cards are what carry the wheel to that scroller. That
 * would fix a swallowed click by breaking a deliberate one, and it would still
 * leave the toast covering the button the operator is aiming at.
 *
 * So the DOCK moves, and the composer is the only thing that knows how far — it
 * grows with the draft. It publishes its own height; `.notif-stack` offsets by
 * it. A ResizeObserver rather than a one-shot read because the textarea grows
 * as the operator types, which is precisely when they are about to press the
 * button.
 *
 * `Cebab-xqad`: extracted from `InputBox` into a shared hook so the multi-agent
 * and chain composers publish the same clearance as the single-agent one — the
 * bug was exactly a second composer that forgot to. Pass the ref of the
 * composer's wrapping element. One document-level property is only
 * unambiguous while at most ONE caller of this hook is mounted at a time: two
 * would clobber each other (last write wins, and either unmount removes the
 * value). The chat view and the multi-agent draft are mutually exclusive
 * today; a new caller has to keep it that way.
 */
export function useComposerClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty(
        COMPOSER_CLEARANCE_VAR,
        `${Math.ceil(wrap.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    // Guarded: jsdom and older embedders do not implement ResizeObserver, and a
    // composer that throws on mount is a worse bug than a dock that does not
    // follow a growing textarea.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    ro?.observe(wrap);
    return () => {
      ro?.disconnect();
      // REMOVED, not set to 0: with no composer mounted there is nothing for the
      // dock to clear, and a stale offset would leave it floating in mid-air
      // over the transcript. The CSS fallback in `var(..., 0px)` is the
      // no-composer answer, and it only applies if the property is absent.
      root.style.removeProperty(COMPOSER_CLEARANCE_VAR);
    };
  }, [ref]);
}
