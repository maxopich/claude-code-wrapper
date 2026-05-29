// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MaxTurnsInput } from './MaxTurnsInput';

// Cluster F Phase A1b — covers the per-turn override input that lives in
// the chat header. Validates:
//   - placeholder reflects the resolved default (or '50' fallback)
//   - onChange normalizes empty/non-finite/out-of-range to null
//   - onChange forwards positive integers verbatim
//   - disabled prop forwards to the input

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

type Props = React.ComponentProps<typeof MaxTurnsInput>;
function render(over: Partial<Props> = {}) {
  const onChange = (over.onChange ?? vi.fn()) as Props['onChange'];
  const { onChange: _o, ...rest } = over;
  void _o;
  const props: Props = { value: null, ...rest, onChange };
  act(() => {
    root.render(<MaxTurnsInput {...props} />);
  });
  return { onChange };
}

function getInput(): HTMLInputElement {
  return container.querySelector('.max-turns-input') as HTMLInputElement;
}
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('MaxTurnsInput — render', () => {
  test('renders with empty value showing the default as placeholder', () => {
    render({ defaultValue: 50 });
    const input = getInput();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('50');
  });

  test('falls back to "50" placeholder when defaultValue is undefined', () => {
    // E.g. before the settings ServerMsg lands, or against an older server.
    render();
    expect(getInput().placeholder).toBe('50');
  });

  test('renders with a number value', () => {
    render({ value: 75, defaultValue: 50 });
    expect(getInput().value).toBe('75');
  });

  test('disabled forwards to the input element', () => {
    render({ defaultValue: 50, disabled: true });
    expect(getInput().disabled).toBe(true);
  });
});

describe('MaxTurnsInput — onChange', () => {
  test('fires with parsed integer for a valid number', () => {
    const { onChange } = render({ defaultValue: 50 });
    act(() => {
      typeInto(getInput(), '100');
    });
    expect(onChange).toHaveBeenCalledWith(100);
  });

  test('clamps zero (below MIN) to null', () => {
    const { onChange } = render({ defaultValue: 50 });
    act(() => {
      typeInto(getInput(), '0');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('clamps values above MAX (1000) to null', () => {
    const { onChange } = render({ defaultValue: 50 });
    act(() => {
      typeInto(getInput(), '5000');
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
