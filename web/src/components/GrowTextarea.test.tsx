// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GrowTextarea } from './GrowTextarea';

/**
 * Register U38: the resize handle declared `role="separator"` with
 * `aria-label="Resize input"` — so a screen reader announced a control — and
 * was operable only by a pointer drag. No `tabIndex`, no key handler, no
 * value. Announcing a control the operator cannot reach is worse than not
 * announcing it: they go looking for something that is not there.
 *
 * The fix implements the role rather than deleting it, which costs one tab
 * stop just before the composer. These tests are what make that trade real —
 * if the keys stop working, the tab stop is pure cost.
 *
 * jsdom has no layout, so `scrollHeight`/`offsetHeight` are 0 unless stubbed.
 * The floor the component computes from content height is therefore 0 here,
 * which is fine: what these assert is the key→value contract, not px fidelity.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount(props: Partial<Parameters<typeof GrowTextarea>[0]> = {}) {
  act(() => {
    root.render(
      <GrowTextarea
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        ariaLabel="Message"
        {...props}
      />,
    );
  });
}

const handle = () => container.querySelector('[role="separator"]') as HTMLElement;
const valueNow = () => Number(handle().getAttribute('aria-valuenow'));

function key(el: HTMLElement, k: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

describe('GrowTextarea — the resize separator is operable by keyboard (U38)', () => {
  test('the handle is in the tab order and names itself', () => {
    mount();
    expect(handle()).not.toBeNull();
    expect(handle().getAttribute('tabindex')).toBe('0');
    expect(handle().getAttribute('aria-label')).toBe('Resize input');
    expect(handle().getAttribute('aria-orientation')).toBe('horizontal');
  });

  test('a focusable separator reports a value within its declared range', () => {
    mount({ maxHeightPx: 320 });
    expect(handle().getAttribute('aria-valuenow')).not.toBeNull();
    expect(Number(handle().getAttribute('aria-valuemin'))).toBe(0);
    expect(Number(handle().getAttribute('aria-valuemax'))).toBe(320);
  });

  test('ArrowUp grows and ArrowDown shrinks, matching the drag direction', () => {
    mount({ maxHeightPx: 320 });
    const start = valueNow();
    key(handle(), 'ArrowUp');
    const grown = valueNow();
    expect(grown).toBeGreaterThan(start);
    key(handle(), 'ArrowDown');
    expect(valueNow()).toBeLessThan(grown);
  });

  test('End goes to the ceiling and Home back to the content floor', () => {
    mount({ maxHeightPx: 320 });
    key(handle(), 'End');
    expect(valueNow()).toBe(320);
    key(handle(), 'Home');
    expect(valueNow()).toBeLessThan(320);
  });

  test('arrowing past the ceiling does not bank invisible height', () => {
    mount({ maxHeightPx: 200 });
    for (let i = 0; i < 40; i++) key(handle(), 'ArrowUp');
    expect(valueNow()).toBe(200);

    // The property here is not "the value stays in range" — the layout effect
    // caps the rendered height on its own, so that assertion passed even with
    // the handler's bounds removed, which is how it was caught. What matters
    // is that the handler steps from the PAINTED height: step from the stored
    // one and it banks to ~960 while the box sits at 200, and the operator
    // then presses ArrowDown thirty times before anything moves. One press
    // must move it.
    key(handle(), 'ArrowDown');
    expect(valueNow()).toBeLessThan(200);
  });

  test('the same holds at the floor', () => {
    mount({ maxHeightPx: 200 });
    for (let i = 0; i < 40; i++) key(handle(), 'ArrowDown');
    const atFloor = valueNow();
    key(handle(), 'ArrowUp');
    expect(valueNow()).toBeGreaterThan(atFloor);
  });

  test('resize keys are claimed; everything else is left alone', () => {
    // `preventDefault` on the arrows stops the page scrolling out from under
    // the composer. Claiming anything more would break typing and Tab — the
    // failure `nextIndex`'s null return exists to prevent, one widget over.
    mount();
    for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect({ k, prevented: key(handle(), k).defaultPrevented }).toEqual({ k, prevented: true });
    }
    for (const k of ['Tab', 'Enter', 'a', 'Escape']) {
      expect({ k, prevented: key(handle(), k).defaultPrevented }).toEqual({ k, prevented: false });
    }
  });

  test('the textarea keeps its own contract', () => {
    // The handle sits immediately before the textarea in the tab order, so a
    // regression that swallowed keys here would be felt on every message.
    const onSubmit = vi.fn();
    mount({ onSubmit });
    const ta = container.querySelector('textarea')!;
    key(ta, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
