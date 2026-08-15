/**
 * Narrow-tier drawer state.
 *
 * At the narrow tier the sidebar and the inspector are full-width overlays
 * sharing one scrim, so only one can sensibly be open. Nothing enforced that:
 * the toggles were two independent `setState` calls, and the reason nobody
 * ever saw both open at once is that the scrim (`z-index: 55`) sat *above* the
 * toggles (`z-index: 45`) and ate the second click. Register U25 raises the
 * toggles above the scrim — which fixes the click and, on its own, would newly
 * let a mouse reach a state the layout was never designed for.
 *
 * (A keyboard could already reach it: `pointer-events: none` blocks a pointer
 * and does nothing to focus, so Tab + Enter opened the second drawer even
 * before this change. That divergence between the two input methods is the
 * thing this PR is about, so the fix is to make them agree — not to leave the
 * mouse blocked.)
 *
 * Extracted as a pure function rather than inlined into `App.tsx` so the
 * invariant is a test rather than a comment. Same shape as `theme.ts` and
 * `shortcutRegistry.ts`: a small module beside its own spec.
 */

export type DrawerState = {
  /** Sidebar drawer is on-screen. */
  nav: boolean;
  /** Inspector drawer is on-screen. */
  insp: boolean;
};

export type Drawer = keyof DrawerState;

export const DRAWERS_CLOSED: DrawerState = { nav: false, insp: false };

/**
 * Toggle one drawer. Opening it closes the other; closing it leaves the other
 * alone (it is already closed by the invariant, but expressing it as "only the
 * open path is exclusive" keeps the function honest if that ever changes).
 */
export function toggleDrawer(state: DrawerState, drawer: Drawer): DrawerState {
  const opening = !state[drawer];
  if (!opening) return { ...state, [drawer]: false };
  return { nav: drawer === 'nav', insp: drawer === 'insp' };
}

/** Close every drawer — the scrim's click, and the tier-change cleanup. */
export function closeDrawers(): DrawerState {
  return DRAWERS_CLOSED;
}
