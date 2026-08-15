import { describe, expect, test } from 'vitest';
import { nextIndex } from './listNavigation';

/**
 * The arrow-key contract, in one place instead of five.
 *
 * Each caller picks a policy from the APG pattern its role claims — menus and
 * radio groups wrap, listboxes and grids clamp — so the two behaviours at the
 * ENDS of the list are what actually matter here. The middle of a list is
 * uninteresting and identical either way.
 *
 * NOT covered: anything about the DOM. Which element gets `.focus()`, and
 * whether selection follows focus, is the caller's business and differs per
 * widget (a combobox focuses nothing at all and moves
 * `aria-activedescendant`). This module only answers "which index".
 */

describe('nextIndex — movement', () => {
  test('moves forward and back in the middle of a list', () => {
    expect(nextIndex({ key: 'ArrowDown', current: 2, count: 5 })).toBe(3);
    expect(nextIndex({ key: 'ArrowUp', current: 2, count: 5 })).toBe(1);
  });

  test('Home and End jump to the ends regardless of policy', () => {
    expect(nextIndex({ key: 'Home', current: 3, count: 5 })).toBe(0);
    expect(nextIndex({ key: 'End', current: 3, count: 5 })).toBe(4);
    expect(nextIndex({ key: 'Home', current: 3, count: 5, wrap: true })).toBe(0);
    expect(nextIndex({ key: 'End', current: 3, count: 5, wrap: true })).toBe(4);
  });
});

describe('nextIndex — the ends, which is the whole point', () => {
  test('clamping stops at the last and first item (listbox, grid)', () => {
    expect(nextIndex({ key: 'ArrowDown', current: 4, count: 5 })).toBe(4);
    expect(nextIndex({ key: 'ArrowUp', current: 0, count: 5 })).toBe(0);
  });

  test('wrapping cycles past both ends (menu, radiogroup)', () => {
    expect(nextIndex({ key: 'ArrowDown', current: 4, count: 5, wrap: true })).toBe(0);
    expect(nextIndex({ key: 'ArrowUp', current: 0, count: 5, wrap: true })).toBe(4);
  });

  test('a single-item list goes nowhere under either policy', () => {
    expect(nextIndex({ key: 'ArrowDown', current: 0, count: 1 })).toBe(0);
    expect(nextIndex({ key: 'ArrowDown', current: 0, count: 1, wrap: true })).toBe(0);
    expect(nextIndex({ key: 'ArrowUp', current: 0, count: 1, wrap: true })).toBe(0);
  });
});

describe('nextIndex — orientation', () => {
  test('vertical (the default) ignores Left and Right', () => {
    expect(nextIndex({ key: 'ArrowRight', current: 1, count: 5 })).toBeNull();
    expect(nextIndex({ key: 'ArrowLeft', current: 1, count: 5 })).toBeNull();
  });

  test('horizontal ignores Up and Down', () => {
    expect(nextIndex({ key: 'ArrowDown', current: 1, count: 5, orientation: 'horizontal' })).toBe(
      null,
    );
    expect(nextIndex({ key: 'ArrowRight', current: 1, count: 5, orientation: 'horizontal' })).toBe(
      2,
    );
  });

  test("'both' takes all four, which is what a wrapped card grid needs", () => {
    const o = { count: 4, orientation: 'both' as const, wrap: true };
    expect(nextIndex({ ...o, key: 'ArrowRight', current: 0 })).toBe(1);
    expect(nextIndex({ ...o, key: 'ArrowDown', current: 0 })).toBe(1);
    expect(nextIndex({ ...o, key: 'ArrowLeft', current: 0 })).toBe(3);
    expect(nextIndex({ ...o, key: 'ArrowUp', current: 0 })).toBe(3);
  });
});

describe('nextIndex — the null cases, which keep the rest of the keyboard working', () => {
  test('a key it does not handle returns null, so the caller leaves it alone', () => {
    // If this ever returned a number, the callers would preventDefault() on
    // it — and typing, Tab and Escape would stop working inside the widget.
    for (const key of ['Enter', 'Escape', 'Tab', 'a', ' ', 'PageDown']) {
      expect(nextIndex({ key, current: 1, count: 5 }), key).toBeNull();
    }
  });

  test('an empty list returns null for every key', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(nextIndex({ key, current: 0, count: 0 }), key).toBeNull();
    }
  });
});

describe('nextIndex — out-of-range current, which happens for real', () => {
  test('-1 ("nothing active yet") starts at the near end', () => {
    // The combobox sits at -1 before the first result lands; a menu sits at
    // -1 whenever focus is somewhere the item list does not contain.
    expect(nextIndex({ key: 'ArrowDown', current: -1, count: 5 })).toBe(0);
    expect(nextIndex({ key: 'ArrowUp', current: -1, count: 5 })).toBe(0);
    expect(nextIndex({ key: 'ArrowUp', current: -1, count: 5, wrap: true })).toBe(4);
  });

  test('an index left over from a longer list lands inside the new one', () => {
    // Results churn as the operator types; a stale index must not produce a
    // number that is also out of range.
    expect(nextIndex({ key: 'ArrowUp', current: 9, count: 3 })).toBe(2);
    expect(nextIndex({ key: 'ArrowDown', current: 9, count: 3 })).toBe(2);
    expect(nextIndex({ key: 'ArrowDown', current: 9, count: 3, wrap: true })).toBe(0);
  });
});

describe('nextIndex — Home/End belong to the caret in a text field', () => {
  test('by default they jump to the ends', () => {
    expect(nextIndex({ key: 'Home', current: 3, count: 5 })).toBe(0);
    expect(nextIndex({ key: 'End', current: 0, count: 5 })).toBe(4);
  });

  test('homeEnd:false declines them, without touching the arrows', () => {
    // A combobox binds its handler to the search INPUT, so a non-null return
    // here makes the caller `preventDefault()` and the text cursor stops
    // moving. `SessionSearchModal` adopted this helper and silently lost
    // "jump to start of query" that way; the arrows must keep working.
    expect(nextIndex({ key: 'Home', current: 3, count: 5, homeEnd: false })).toBeNull();
    expect(nextIndex({ key: 'End', current: 3, count: 5, homeEnd: false })).toBeNull();
    expect(nextIndex({ key: 'ArrowDown', current: 3, count: 5, homeEnd: false })).toBe(4);
    expect(nextIndex({ key: 'ArrowUp', current: 3, count: 5, homeEnd: false })).toBe(2);
  });

  test('an empty list declines them either way', () => {
    expect(nextIndex({ key: 'Home', current: -1, count: 0 })).toBeNull();
    expect(nextIndex({ key: 'End', current: -1, count: 0, homeEnd: false })).toBeNull();
  });
});
