// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MultiAgentDraftFooter } from './MultiAgentTab';
import { COMPOSER_CLEARANCE_VAR } from './useComposerClearance';

/**
 * `Cebab-xqad`: the multi-agent (and chain) draft composer did NOT publish
 * `--composer-clearance`, so on those tabs the property was empty and the
 * notification dock sat at its default bottom — on top of the Start button.
 * The fix is a shared hook (`useComposerClearance`) both the single-agent
 * `InputBox` and the draft footer call.
 *
 * `Cebab-7jcq`: the hook then measured only the composer's own `.input-box`
 * wrap, but the validation warning and the [Inspect authority] row sit ABOVE
 * the composer — so the dock cleared the composer while still covering the
 * inspect button (measured live at 1024x768: `elementFromPoint` at the button's
 * centre returned `div.notif-message`). The ref moved up to the footer wrapper
 * (`MultiAgentDraftFooter`) that holds all three, so the published height clears
 * the whole footer. Still a SINGLE hook caller.
 *
 * As with `InputBox.clearance.test.tsx`, jsdom performs no layout and applies
 * no stylesheet, so `elementFromPoint` / `getBoundingClientRect` are meaningless
 * here — the browser hit-test is the Playground's job. These pin the MECHANISM
 * that makes the layout right:
 *   - the footer publishes its own MEASURED height, not a constant;
 *   - the observed element is the WHOLE footer (warning + inspect row +
 *     composer), not just the composer — so the dock clears the inspect button;
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

function mount(
  opts: {
    mode?: 'chain' | 'orchestrator';
    validation?: string | null;
    participantIds?: number[];
  } = {},
) {
  act(() => {
    root.render(
      <MultiAgentDraftFooter
        mode={opts.mode ?? 'orchestrator'}
        validation={opts.validation ?? null}
        participantIds={opts.participantIds ?? [1]}
        value=""
        onChange={() => {}}
        onStart={() => {}}
        pending={false}
        disabled={false}
      />,
    );
  });
}

describe('multi-agent draft footer clearance (Cebab-xqad / Cebab-7jcq)', () => {
  test('orchestrator draft publishes its measured height, and observes the footer wrap', () => {
    fakeHeight = 96;
    mount({ mode: 'orchestrator' });
    expect(clearance()).toBe('96px');
    // Observe the FOOTER wrap, not nothing — otherwise the first value is right
    // and every later one is stale (the box grows as the operator types, then
    // Start dies under the toast).
    expect(observed.length).toBe(1);
    expect((observed[0] as HTMLElement).className).toContain('multi-agent-draft-footer');
  });

  test('Cebab-7jcq: the measured element wraps the inspect row + warning, not just the composer', () => {
    // The regression: if the ref were back on the composer's own `.input-box`
    // wrap, the observed element would be `.multi-agent-composer` and would NOT
    // contain the inspect button or the warning — so the dock would clear the
    // composer while still covering them. The whole footer must be measured.
    fakeHeight = 96;
    mount({ validation: 'Fix this before starting.', participantIds: [1, 2] });
    const footer = observed[0] as HTMLElement;
    expect(footer.className).toContain('multi-agent-draft-footer');
    expect(footer.className).not.toContain('multi-agent-composer');
    expect(footer.querySelector('.multi-agent-inspect-btn')).not.toBeNull();
    expect(footer.querySelector('.multi-agent-warning-composer')).not.toBeNull();
    // The composer still lives INSIDE the measured footer.
    expect(footer.querySelector('.multi-agent-composer')).not.toBeNull();
  });

  test('chain draft publishes it too — same shape, same hook', () => {
    fakeHeight = 120;
    mount({ mode: 'chain' });
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

  test('follows the footer as the draft grows', () => {
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
