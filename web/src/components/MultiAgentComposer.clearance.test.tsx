// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MultiAgentComposer } from './MultiAgentTab';
import { COMPOSER_CLEARANCE_VAR } from './useComposerClearance';

/**
 * `Cebab-xqad`: the multi-agent (and chain) draft composer did NOT publish
 * `--composer-clearance`, so on those tabs the property was empty and the
 * notification dock sat at its default bottom — on top of the Start button.
 * Measured live at 1024x768: `document.elementFromPoint` at the Start button's
 * centre returned `div.notif-message`, and the click did nothing. `InputBox`
 * (single-agent) was fixed for exactly this by `Cebab-aids`; the draft composer
 * forgot to. The fix is a shared hook (`useComposerClearance`) both call.
 *
 * As with `InputBox.clearance.test.tsx`, jsdom performs no layout and applies
 * no stylesheet, so `elementFromPoint` / `getBoundingClientRect` are meaningless
 * here — the browser hit-test is the Playground's job. These pin the MECHANISM
 * that makes the layout right:
 *   - the draft composer publishes its own MEASURED height, not a constant;
 *   - it keeps publishing as the textarea grows;
 *   - it cleans up on unmount, so a tab with no composer leaves no stale offset.
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

function mount(mode: 'chain' | 'orchestrator' = 'orchestrator') {
  act(() => {
    root.render(
      <MultiAgentComposer
        mode={mode}
        value=""
        onChange={() => {}}
        onStart={() => {}}
        pending={false}
        disabled={false}
      />,
    );
  });
}

describe('multi-agent composer clearance (Cebab-xqad)', () => {
  test('orchestrator draft publishes its measured height, and observes the composer', () => {
    fakeHeight = 96;
    mount('orchestrator');
    expect(clearance()).toBe('96px');
    // Observe the composer WRAP, not nothing — otherwise the first value is
    // right and every later one is stale (the box grows as the operator types,
    // then Start dies under the toast).
    expect(observed.length).toBe(1);
    expect((observed[0] as HTMLElement).className).toContain('multi-agent-composer');
  });

  test('chain draft publishes it too — same shape, same hook', () => {
    fakeHeight = 120;
    mount('chain');
    expect(clearance()).toBe('120px');
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
