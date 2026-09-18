// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { InputBox, COMPOSER_CLEARANCE_VAR } from './InputBox';

/**
 * `Cebab-aids`: the notification dock sat on top of the Send button and ate the
 * click. Measured live at 1280x900 — `document.elementFromPoint` at the Send
 * button's own centre returned `notif-message`, and three real clicks were
 * swallowed with no error and no visual response.
 *
 * WHAT THESE CAN AND CANNOT PIN, stated because the bead's acceptance asks for
 * a hit-test and a hit-test is NOT available here. jsdom performs no layout and
 * applies no stylesheet, so `elementFromPoint`, `getBoundingClientRect` and any
 * computed `bottom` are all meaningless in this environment — a test that
 * "asserted the button is clickable" would be asserting nothing.
 *
 * So these pin the MECHANISM that makes the layout right, and the hit-test is
 * done in a real browser against the Playground fixtures:
 *   - the composer publishes its own height, and keeps publishing as it grows;
 *   - it publishes a MEASURED value, not a constant;
 *   - it cleans up, so a tab with no composer does not leave the dock floating.
 */

let container: HTMLDivElement;
let root: Root;
let fakeHeight = 0;
let observed: Element[] = [];
let disconnects = 0;
let fireResize: (() => void) | null = null;

const realRect = Element.prototype.getBoundingClientRect;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

beforeEach(() => {
  fakeHeight = 0;
  observed = [];
  disconnects = 0;
  fireResize = null;
  // jsdom lays nothing out, so every rect is zero. The component's input is a
  // measured height; supplying one is what makes the assertions mean anything.
  Element.prototype.getBoundingClientRect = function rect() {
    return { ...realRect.call(this), height: fakeHeight } as DOMRect;
  };
  class FakeRO {
    constructor(cb: () => void) {
      fireResize = cb;
    }
    observe(el: Element) {
      observed.push(el);
    }
    disconnect() {
      disconnects += 1;
    }
    unobserve() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  Element.prototype.getBoundingClientRect = realRect;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  document.documentElement.style.removeProperty(COMPOSER_CLEARANCE_VAR);
});

const clearance = () => document.documentElement.style.getPropertyValue(COMPOSER_CLEARANCE_VAR);

function mount() {
  act(() => {
    root.render(<InputBox onSend={() => {}} />);
  });
}

describe('composer clearance (Cebab-aids)', () => {
  test('publishes its measured height, and observes itself', () => {
    fakeHeight = 96;
    mount();
    expect(clearance()).toBe('96px');
    // It must observe the composer WRAP — observing nothing would leave the
    // first value correct and every later one stale, which is the failure the
    // operator actually meets (the box grows as they type, then Send dies).
    expect(observed.length).toBe(1);
    expect((observed[0] as HTMLElement).className).toContain('input-box');
  });

  test('ANTI-VACUITY: the value tracks the measurement, it is not a constant', () => {
    // If the implementation wrote a fixed offset, both mounts would agree and
    // the test above would still pass.
    fakeHeight = 96;
    mount();
    const first = clearance();
    act(() => {
      root.unmount();
    });
    act(() => {
      root = createRoot(container);
    });
    fakeHeight = 240;
    mount();
    expect(clearance()).toBe('240px');
    expect(clearance()).not.toBe(first);
  });

  test('follows the composer as the draft grows', () => {
    fakeHeight = 96;
    mount();
    expect(clearance()).toBe('96px');
    fakeHeight = 310;
    act(() => {
      fireResize?.();
    });
    expect(clearance()).toBe('310px');
  });

  test('removes the property on unmount and stops observing', () => {
    fakeHeight = 96;
    mount();
    expect(clearance()).toBe('96px');
    act(() => {
      root.unmount();
    });
    // Removed, not zeroed: the stylesheet's `var(..., 0px)` fallback only
    // applies when the property is ABSENT, and a stale offset would leave the
    // dock floating over the transcript on a tab with no composer.
    expect(clearance()).toBe('');
    expect(disconnects).toBe(1);
    act(() => {
      root = createRoot(container);
    });
  });

  test('a rounded-up whole pixel, never a fraction', () => {
    // Sub-pixel heights are normal for a grown textarea. `calc()` handles a
    // fraction fine, but rounding DOWN could leave the dock a fraction low and
    // re-open the overlap by a hair, which is unfalsifiable by eye.
    fakeHeight = 96.2;
    mount();
    expect(clearance()).toBe('97px');
  });
});
