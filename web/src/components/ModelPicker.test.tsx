// @vitest-environment jsdom
//
// The picker's job is small and its two failure modes are specific:
//   1. "Default" must always be reachable AND must mean `null`, so that
//      choosing it and never choosing produce the same spawn. The CLI's own
//      catalogue ships a row whose value is the string 'default'; if that row
//      were rendered as an ordinary option, picking it would store 'default'
//      and every turn would carry a model key the operator thought they had
//      declined.
//   2. An EMPTY catalogue must still render a usable control. It is a normal
//      state (nothing probed yet), and it is the state most likely to ship
//      broken because it is the one nobody looks at.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ModelCatalogueEntry } from '@cebab/shared/protocol';
import { ModelPicker, modelPickerRows } from './ModelPicker';

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

const CLI: ModelCatalogueEntry[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus 5 · everyday',
    resolvedModel: 'x-1',
  },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Faster' },
  { value: 'haiku', displayName: 'Haiku', description: 'Cheapest' },
];

function render(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onChange = vi.fn();
  act(() => {
    root.render(<ModelPicker entries={CLI} value={null} onChange={onChange} {...props} />);
  });
  return { onChange };
}

const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];

describe('modelPickerRows', () => {
  test("the CLI's own 'default' row becomes the null row, not a second option", () => {
    const rows = modelPickerRows(CLI);
    expect(rows.map((r) => r.value)).toEqual([null, 'sonnet', 'haiku']);
    // Its label and blurb are borrowed — better copy than anything we could
    // author, and it tracks the CLI instead of rotting.
    expect(rows[0]!.label).toBe('Default (recommended)');
    expect(rows[0]!.description).toBe('Opus 5 · everyday');
  });

  test('an empty catalogue still yields exactly one row, and it is Default', () => {
    const rows = modelPickerRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(null);
    expect(rows[0]!.label).toBe('Default');
  });

  test('a catalogue with no default row still gets one, synthesised', () => {
    const rows = modelPickerRows([{ value: 'sonnet', displayName: 'Sonnet', description: '' }]);
    expect(rows.map((r) => r.value)).toEqual([null, 'sonnet']);
  });
});

describe('ModelPicker', () => {
  test('renders one radio per row with the current one checked', () => {
    render({ value: 'sonnet' });
    expect(radios()).toHaveLength(3);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  test('choosing Default emits null, not the string "default"', () => {
    const { onChange } = render({ value: 'sonnet' });
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="model-option-__default__"]')!.click();
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('choosing a model emits its value verbatim', () => {
    const { onChange } = render();
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="model-option-haiku"]')!.click();
    });
    expect(onChange).toHaveBeenCalledWith('haiku');
  });

  test('an unrecognised stored value falls back to Default rather than checking nothing', () => {
    // A model retired since it was chosen. Checking no radio at all would make
    // the group unreachable by keyboard (every tabIndex would be -1).
    render({ value: 'a-model-that-no-longer-exists' });
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  test('exactly one radio is tabbable (roving tabindex)', () => {
    render({ value: 'haiku' });
    expect(radios().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  test('arrow keys move the selection and wrap', () => {
    const { onChange } = render({ value: null });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith('sonnet');
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    // Wraps from the first row to the last rather than dead-ending.
    expect(onChange).toHaveBeenLastCalledWith('haiku');
  });

  test('an empty catalogue renders a usable control and says why it is bare', () => {
    render({ entries: [] });
    expect(radios()).toHaveLength(1);
    expect(container.textContent).toContain('No model list captured yet');
  });

  test('a non-empty catalogue does not claim to be empty', () => {
    render();
    expect(container.textContent).not.toContain('No model list captured yet');
  });

  test('Refresh is hidden without a handler and disabled while in flight', () => {
    render();
    expect(container.querySelector('.model-picker-refresh')).toBe(null);

    const onRefresh = vi.fn();
    act(() => {
      root.render(
        <ModelPicker
          entries={CLI}
          value={null}
          onChange={() => {}}
          onRefresh={onRefresh}
          refreshing
        />,
      );
    });
    const btn = container.querySelector<HTMLButtonElement>('.model-picker-refresh')!;
    expect(btn.disabled).toBe(true);
    act(() => {
      btn.click();
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test('disabled blocks both click and arrow selection', () => {
    const { onChange } = render({ disabled: true });
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="model-option-haiku"]')!.click();
      container
        .querySelector<HTMLElement>('[role="radiogroup"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
