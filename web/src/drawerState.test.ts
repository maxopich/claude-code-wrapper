import { describe, expect, test } from 'vitest';
import { closeDrawers, DRAWERS_CLOSED, toggleDrawer, type DrawerState } from './drawerState';

/**
 * Register U25 — the narrow-tier drawers are mutually exclusive.
 *
 * They always were in practice, but only by accident: the scrim sat above the
 * toggles in the stacking order and ate the second click. Raising the toggles
 * (so the mouse can operate the control it can see) removes that accident, so
 * the invariant has to be stated somewhere. It is stated here rather than in a
 * comment above two `setState` calls.
 *
 * Worth noting what the accident was hiding: `pointer-events` blocks a pointer
 * and does nothing to focus, so Tab + Enter could already open both drawers
 * before any of this changed. The two input methods disagreed; making them
 * agree is the point of the change, not a side effect of it.
 */

const OPEN_NAV: DrawerState = { nav: true, insp: false };
const OPEN_INSP: DrawerState = { nav: false, insp: true };

describe('toggleDrawer', () => {
  test('opens a drawer from the closed state', () => {
    expect(toggleDrawer(DRAWERS_CLOSED, 'nav')).toEqual(OPEN_NAV);
    expect(toggleDrawer(DRAWERS_CLOSED, 'insp')).toEqual(OPEN_INSP);
  });

  test('opening one drawer closes the other', () => {
    expect(toggleDrawer(OPEN_NAV, 'insp')).toEqual(OPEN_INSP);
    expect(toggleDrawer(OPEN_INSP, 'nav')).toEqual(OPEN_NAV);
  });

  test('toggling the open drawer closes it and opens nothing', () => {
    expect(toggleDrawer(OPEN_NAV, 'nav')).toEqual(DRAWERS_CLOSED);
    expect(toggleDrawer(OPEN_INSP, 'insp')).toEqual(DRAWERS_CLOSED);
  });

  test('two toggles of the same drawer return to the start', () => {
    for (const drawer of ['nav', 'insp'] as const) {
      expect(toggleDrawer(toggleDrawer(DRAWERS_CLOSED, drawer), drawer)).toEqual(DRAWERS_CLOSED);
    }
  });

  test('never yields both drawers open, from any state and any input', () => {
    // Exhaustive over the whole (4 states × 2 drawers) space — small enough
    // that sampling would be the lazier option, not the cheaper one.
    const states: DrawerState[] = [
      { nav: false, insp: false },
      { nav: true, insp: false },
      { nav: false, insp: true },
      // Not reachable through this module, but assert the function repairs it
      // rather than propagating it — it is reachable in a stale React state
      // snapshot if anything else ever writes the pair.
      { nav: true, insp: true },
    ];
    for (const state of states) {
      for (const drawer of ['nav', 'insp'] as const) {
        const next = toggleDrawer(state, drawer);
        expect({ state, drawer, both: next.nav && next.insp }).toEqual({
          state,
          drawer,
          both: false,
        });
      }
    }
  });

  test('does not mutate its input', () => {
    const state: DrawerState = { nav: true, insp: false };
    toggleDrawer(state, 'insp');
    expect(state).toEqual({ nav: true, insp: false });
  });
});

describe('closeDrawers', () => {
  test('closes everything — the scrim click and the tier-change cleanup', () => {
    expect(closeDrawers()).toEqual(DRAWERS_CLOSED);
  });
});
