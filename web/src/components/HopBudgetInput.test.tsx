// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { HopBudgetInput } from './HopBudgetInput';

// Cluster F Phase D9 — HopBudgetInput contract:
//   - Renders a number input + label + hint
//   - When value=null, input is empty AND placeholder shows the default
//   - "(from template)" tag visible iff source='template' AND value !== null
//   - Tag hidden when source='user' or null
//   - Typing a positive integer fires onChange(value)
//   - Typing an empty string fires onChange(null)
//   - Out-of-range typing fires onChange(null) (clamps to null, not an
//     invalid number)

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

type Props = React.ComponentProps<typeof HopBudgetInput>;
function render(over: Partial<Props> = {}) {
  const onChange = (over.onChange ?? vi.fn()) as Props['onChange'];
  const { onChange: _o, ...rest } = over;
  void _o;
  const props: Props = {
    value: null,
    source: null,
    defaultValue: 100,
    ...rest,
    onChange,
  };
  act(() => {
    root.render(<HopBudgetInput {...props} />);
  });
  return { onChange };
}

function getInput(): HTMLInputElement {
  return container.querySelector('.ma-hop-budget-input') as HTMLInputElement;
}
function getTag(): HTMLElement | null {
  return container.querySelector('[data-testid="hop-budget-source-tag"]');
}
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HopBudgetInput — render', () => {
  test('renders the label + input + hint', () => {
    render();
    expect(container.querySelector('.ma-hop-budget-input-label')).not.toBeNull();
    expect(getInput()).not.toBeNull();
    expect(container.querySelector('.ma-hop-budget-input-hint')).not.toBeNull();
  });

  test('value=null → input is empty', () => {
    render({ value: null });
    expect(getInput().value).toBe('');
  });

  test('value=50 → input shows 50', () => {
    render({ value: 50 });
    expect(getInput().value).toBe('50');
  });

  test('placeholder includes server default + "(server default)" hint', () => {
    render({ defaultValue: 80 });
    expect(getInput().placeholder).toBe('80 (server default)');
  });
});

describe('HopBudgetInput — source attribution tag', () => {
  test('source=template + value set → tag visible', () => {
    render({ source: 'template', value: 42 });
    expect(getTag()).not.toBeNull();
    expect(getTag()?.textContent).toContain('from template');
  });

  test('source=template + value=null → tag hidden (no template hop budget)', () => {
    render({ source: 'template', value: null });
    expect(getTag()).toBeNull();
  });

  test('source=user + value set → tag hidden', () => {
    render({ source: 'user', value: 42 });
    expect(getTag()).toBeNull();
  });

  test('source=null → tag hidden', () => {
    render({ source: null, value: 42 });
    expect(getTag()).toBeNull();
  });
});

describe('HopBudgetInput — onChange', () => {
  test('typing a valid integer fires onChange(value)', () => {
    const onChange = vi.fn();
    render({ onChange });
    act(() => {
      typeInto(getInput(), '75');
    });
    expect(onChange).toHaveBeenCalledWith(75);
  });

  test('clearing the input fires onChange(null)', () => {
    const onChange = vi.fn();
    render({ value: 75, onChange });
    act(() => {
      typeInto(getInput(), '');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  // Whitespace-only and non-numeric strings aren't reachable through
  // a browser `<input type="number">` (the browser silently rejects
  // non-numeric input before it would land in onChange), but the
  // component's parser handles them defensively. The negative /
  // out-of-range / above-max tests below cover all the value-shape
  // edge cases that ARE reachable.
  test('negative numbers clamp to null', () => {
    const onChange = vi.fn();
    render({ onChange });
    act(() => {
      typeInto(getInput(), '-5');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('zero clamps to null (below min)', () => {
    const onChange = vi.fn();
    render({ onChange });
    act(() => {
      typeInto(getInput(), '0');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('above-max clamps to null', () => {
    const onChange = vi.fn();
    render({ onChange });
    act(() => {
      typeInto(getInput(), '5000');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('HopBudgetInput — disabled', () => {
  test('disabled prop disables the input', () => {
    render({ disabled: true });
    expect(getInput().disabled).toBe(true);
  });
});
