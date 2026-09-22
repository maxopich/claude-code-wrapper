// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { UserPromptInput } from './MultiAgentTab';
import { COMPOSER_CLEARANCE_VAR } from './InputBox';

/**
 * `Cebab-ame0`: the active-run "Send a prompt" composer never published
 * `--composer-clearance`, so the notification dock (fixed bottom-right) could
 * sit on top of its Send button and eat the click — the same hazard `Cebab-aids`
 * fixed for the single-agent composer and `Cebab-xqad` for the draft one. It was
 * left out then because this section scrolled with the content; the CSS now pins
 * it to the viewport bottom (`.multi-agent-input-section { position: sticky }`),
 * so its measured height is a correct dock offset at every scroll position.
 *
 * As with `InputBox.clearance.test.tsx`, jsdom performs no layout and applies no
 * stylesheet, so `elementFromPoint` / `getBoundingClientRect` / computed
 * `bottom` are all meaningless here — the browser hit-test is the Playground's
 * job. These pin the MECHANISM that makes the layout right:
 *   - the composer publishes its own MEASURED height, not a constant;
 *   - it keeps publishing as the textarea grows;
 *   - it cleans up on unmount, so a view with no composer leaves no stale offset.
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
    root.render(<UserPromptInput onSend={() => true} />);
  });
}

describe('active-run composer clearance (Cebab-ame0)', () => {
  test('publishes its measured height, and observes the composer section', () => {
    fakeHeight = 96;
    mount();
    expect(clearance()).toBe('96px');
    // Observe the composer WRAP, not nothing — otherwise the first value is
    // right and every later one is stale (the box grows as the operator types,
    // then Send dies under the toast).
    expect(observed.length).toBe(1);
    expect((observed[0] as HTMLElement).className).toContain('multi-agent-input-section');
  });

  test('ANTI-VACUITY: the value tracks the measurement, it is not a constant', () => {
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
    // Removed, not zeroed: the stylesheet's `var(..., 0px)` fallback only applies
    // when the property is ABSENT, and a stale offset would leave the dock
    // floating over the transcript on a view with no composer.
    expect(clearance()).toBe('');
    expect(disconnects).toBe(1);
    act(() => {
      root = createRoot(container);
    });
  });

  test('a rounded-up whole pixel, never a fraction', () => {
    fakeHeight = 96.2;
    mount();
    expect(clearance()).toBe('97px');
  });
});
