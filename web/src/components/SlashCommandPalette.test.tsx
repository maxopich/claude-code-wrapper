// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SlashCommandPalette } from './SlashCommandPalette';

// Cluster E Phase 1 — SlashCommandPalette contract:
//   - Renders as role=dialog, contains its own filter input + listbox
//   - Filter input is autofocused on mount
//   - Sections render: Cebab quick commands + (when sdkCommands given)
//     Discovered from session
//   - Typing filters across both sections
//   - ArrowDown/ArrowUp navigate the flat list (wraps at boundaries)
//   - Enter activates highlighted row → onSelect(command)
//   - Esc → onClose()
//   - Click on a row → onSelect(command)
//   - Empty filter result renders the no-commands-match message
//   - SDK commands de-duped against Cebab list (verified at registry layer
//     too; smoke-checked here)

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
  vi.useRealTimers();
});

type Props = React.ComponentProps<typeof SlashCommandPalette>;

function render(over: Partial<Props> = {}) {
  const onSelect = (over.onSelect ?? vi.fn()) as Props['onSelect'];
  const onClose = (over.onClose ?? vi.fn()) as Props['onClose'];
  const { onSelect: _s, onClose: _c, ...rest } = over;
  void _s;
  void _c;
  const props: Props = { ...rest, onSelect, onClose };
  act(() => {
    root.render(<SlashCommandPalette {...props} />);
  });
  return { onSelect, onClose };
}

function findInput(): HTMLInputElement {
  return document.querySelector('.slash-palette-input') as HTMLInputElement;
}
function findRows(): HTMLLIElement[] {
  return Array.from(document.querySelectorAll<HTMLLIElement>('.slash-palette-row'));
}
function findRowByCommand(cmd: string): HTMLLIElement | null {
  return findRows().find((r) => r.querySelector('code')?.textContent === cmd) ?? null;
}
function activeRow(): HTMLLIElement | null {
  return document.querySelector('.slash-palette-row.is-active') as HTMLLIElement | null;
}

// React tracks .value internally — use the prototype setter to invalidate.
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function keydownOnInput(key: string) {
  findInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('SlashCommandPalette — render', () => {
  test('renders dialog scaffold with filter input + listbox', () => {
    render();
    expect(document.querySelector('.slash-palette')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(findInput()).not.toBeNull();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  test('autofocuses the filter input on mount', () => {
    render();
    expect(document.activeElement).toBe(findInput());
  });

  test('renders Cebab section with all 5 quick commands by default', () => {
    render();
    const rows = findRows();
    const cmds = rows.map((r) => r.querySelector('code')?.textContent);
    expect(cmds).toContain('/context');
    expect(cmds).toContain('/compact');
    expect(cmds).toContain('/skills');
    expect(cmds).toContain('/mcp');
    expect(cmds).toContain('/cost');
  });

  test('renders SDK section when sdkCommands provided', () => {
    render({ sdkCommands: ['/ide', '/init'] });
    const sectionTitles = Array.from(document.querySelectorAll('.slash-palette-section-title')).map(
      (e) => e.textContent,
    );
    expect(sectionTitles).toContain('Discovered from session');
    expect(findRowByCommand('/ide')).not.toBeNull();
    expect(findRowByCommand('/init')).not.toBeNull();
  });

  test('de-dupes SDK commands that collide with Cebab', () => {
    render({ sdkCommands: ['compact', 'mcp', '/ide'] });
    const cmds = findRows().map((r) => r.querySelector('code')?.textContent);
    // /compact + /mcp only appear once each (Cebab source — the SDK
    // copies were dropped by buildSdkSlashCommands).
    expect(cmds.filter((c) => c === '/compact')).toHaveLength(1);
    expect(cmds.filter((c) => c === '/mcp')).toHaveLength(1);
    expect(cmds).toContain('/ide');
  });
});

describe('SlashCommandPalette — filter', () => {
  test('filtering narrows the rendered rows', () => {
    render({ sdkCommands: ['/ide', '/init'] });
    act(() => {
      typeInto(findInput(), 'ide');
    });
    const cmds = findRows().map((r) => r.querySelector('code')?.textContent);
    expect(cmds).toEqual(['/ide']);
  });

  test('no match → empty state message', () => {
    render();
    act(() => {
      typeInto(findInput(), 'zzzzzz');
    });
    expect(findRows()).toHaveLength(0);
    expect(document.querySelector('.slash-palette-empty')).not.toBeNull();
  });

  test('case insensitive filter', () => {
    render();
    act(() => {
      typeInto(findInput(), 'CONTEXT');
    });
    const cmds = findRows().map((r) => r.querySelector('code')?.textContent);
    expect(cmds).toContain('/context');
  });
});

describe('SlashCommandPalette — keyboard navigation', () => {
  test('ArrowDown moves highlight to the next row', () => {
    render();
    // First row is highlighted by default
    expect(activeRow()).toBe(findRows()[0]);
    act(() => {
      keydownOnInput('ArrowDown');
    });
    expect(activeRow()).toBe(findRows()[1]);
  });

  test('ArrowUp from first row wraps to last', () => {
    render();
    expect(activeRow()).toBe(findRows()[0]);
    act(() => {
      keydownOnInput('ArrowUp');
    });
    expect(activeRow()).toBe(findRows()[findRows().length - 1]);
  });

  test('Enter activates the highlighted row → onSelect', () => {
    const onSelect = vi.fn();
    render({ onSelect });
    // Default highlight is row 0 (/context — first in Cebab order)
    act(() => {
      keydownOnInput('Enter');
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatch(/^\/[a-z]/);
  });

  test('Enter on empty filter result does nothing', () => {
    const onSelect = vi.fn();
    render({ onSelect });
    act(() => {
      typeInto(findInput(), 'zzzz');
    });
    expect(findRows()).toHaveLength(0);
    act(() => {
      keydownOnInput('Enter');
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('Esc calls onClose', () => {
    const onClose = vi.fn();
    render({ onClose });
    act(() => {
      keydownOnInput('Escape');
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SlashCommandPalette — mouse', () => {
  test('mousedown on a row calls onSelect with that command', () => {
    const onSelect = vi.fn();
    render({ onSelect });
    const row = findRowByCommand('/compact');
    expect(row).not.toBeNull();
    act(() => {
      row!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('/compact');
  });
});
