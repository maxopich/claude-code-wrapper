// @vitest-environment jsdom
//
// The keyboard model, tested once instead of once per picker — which is the
// reason this component exists at all.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { CardRadioGroup } from './CardRadioGroup';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const OPTS = [
  { key: 'a', value: null as string | null, label: 'Alpha', description: 'first' },
  { key: 'b', value: 'b', label: 'Bravo' },
  { key: 'c', value: 'c', label: 'Charlie', description: 'third' },
];

function render(value: string | null, disabled = false) {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <CardRadioGroup
        options={OPTS}
        value={value}
        onChange={onChange}
        ariaLabel="Test group"
        testIdPrefix="opt"
        disabled={disabled}
      />,
    );
  });
  return { onChange };
}

const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
const group = () => container.querySelector<HTMLElement>('[role="radiogroup"]')!;
const arrow = (key: string) =>
  act(() => {
    group().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('CardRadioGroup', () => {
  test('is a named radiogroup of radios', () => {
    render(null);
    expect(group().getAttribute('aria-label')).toBe('Test group');
    expect(radios()).toHaveLength(3);
  });

  test('[a11y] a radiogroup contains only radios', () => {
    // `widgetKeyboard.test.ts` enforces this for rendered specs; asserting it
    // here too means a future extra child (a hint, a divider) is caught in the
    // component's own file rather than in a distant gate.
    render(null);
    const children = [...group().children];
    expect(children.every((c) => c.getAttribute('role') === 'radio')).toBe(true);
  });

  test('[a11y] exactly one radio is tabbable, and it is the checked one', () => {
    render('c');
    expect(radios().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  test('arrows select as they move, and wrap in both directions', () => {
    const { onChange } = render(null);
    arrow('ArrowDown');
    expect(onChange).toHaveBeenLastCalledWith('b');
    arrow('ArrowUp');
    // Wraps to the last rather than dead-ending at the first.
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  test('Home and End reach the ends', () => {
    const { onChange } = render('b');
    arrow('End');
    expect(onChange).toHaveBeenLastCalledWith('c');
    arrow('Home');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  test('an unmatched value falls back to the first, keeping the group reachable', () => {
    // Not cosmetic: with no match and no floor, every tabIndex would be -1 and
    // the whole group would drop out of the tab order.
    render('a-value-that-is-not-here');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  test('null is a real value, distinguishable from "no match"', () => {
    // The reason this component is generic rather than string-keyed: both
    // callers use null for "no explicit choice", and it must select its row.
    render(null);
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true');
  });

  test('a keystroke that is not navigation is ignored', () => {
    const { onChange } = render(null);
    arrow('a');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('disabled blocks clicks and arrows alike', () => {
    const { onChange } = render(null, true);
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="opt-c"]')!.click();
    });
    arrow('ArrowDown');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a description renders only when present', () => {
    render(null);
    expect(container.querySelectorAll('.card-radio-desc')).toHaveLength(2);
  });
});
