// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { SHORTCUTS } from '../shortcutRegistry';

// Cluster E Phase 4 — KeyboardShortcutsModal contract:
//   - Renders as a role=dialog with the cheatsheet title
//   - Filter input autofocuses on mount
//   - Each registry row appears as a <li> with .kbd chips
//   - Sectioned by ShortcutSection
//   - Filter narrows rows; empty matches show the "no shortcuts match" state
//   - Esc closes
//   - Click outside (backdrop) closes
//   - The footer hints at editing shortcutRegistry.ts

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

function render(onClose = vi.fn()) {
  act(() => {
    root.render(<KeyboardShortcutsModal onClose={onClose} />);
  });
  return onClose;
}

function findFilterInput(): HTMLInputElement {
  return document.querySelector('.keyboard-shortcuts-modal-filter') as HTMLInputElement;
}
function findRows(): HTMLLIElement[] {
  return Array.from(document.querySelectorAll<HTMLLIElement>('.keyboard-shortcuts-modal-row'));
}
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('KeyboardShortcutsModal — render', () => {
  test('renders as a dialog with the cheatsheet title', () => {
    render();
    expect(document.querySelector('.keyboard-shortcuts-modal')).not.toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('#keyboard-shortcuts-modal-title')?.textContent).toContain(
      'Keyboard shortcuts',
    );
  });

  test('filter input is autofocused on mount', () => {
    render();
    expect(document.activeElement).toBe(findFilterInput());
  });

  test('renders one row per registry entry', () => {
    render();
    const rows = findRows();
    expect(rows.length).toBe(SHORTCUTS.length);
  });

  test('each row contains at least one .kbd chip', () => {
    render();
    for (const row of findRows()) {
      expect(row.querySelectorAll('.kbd').length).toBeGreaterThan(0);
    }
  });

  test('sections render with their title heading', () => {
    render();
    const titles = Array.from(
      document.querySelectorAll('.keyboard-shortcuts-modal-section-title'),
    ).map((e) => e.textContent);
    // The registry currently has Help, Session, Composer entries; assert
    // those at least are present.
    expect(titles).toContain('Help');
    expect(titles).toContain('Session');
    expect(titles).toContain('Composer');
  });
});

describe('KeyboardShortcutsModal — filter', () => {
  test('typing narrows the rendered rows', () => {
    render();
    act(() => {
      typeInto(findFilterInput(), 'cheatsheet');
    });
    const rows = findRows();
    // At least one cheatsheet row survives; non-matching Composer rows
    // should be gone.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.textContent?.toLowerCase()).toContain('cheatsheet');
    }
  });

  test('no match → empty-state message', () => {
    render();
    act(() => {
      typeInto(findFilterInput(), 'zzzz-no-such-binding');
    });
    expect(findRows()).toHaveLength(0);
    expect(document.querySelector('.keyboard-shortcuts-modal-empty')).not.toBeNull();
  });

  test('filter matches against keyDisplay too (e.g. "Cmd")', () => {
    render();
    act(() => {
      typeInto(findFilterInput(), 'cmd');
    });
    // Cmd appears in multiple bindings — at minimum the Cmd/Ctrl+. Stop
    // and Cmd/Ctrl+/ cheatsheet ones.
    expect(findRows().length).toBeGreaterThan(1);
  });
});

describe('KeyboardShortcutsModal — dismissal', () => {
  test('Esc closes the modal', () => {
    const onClose = render();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('backdrop mousedown closes', () => {
    const onClose = render();
    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('click on the modal surface does NOT close', () => {
    const onClose = render();
    const surface = document.querySelector('.modal-surface') as HTMLElement;
    act(() => {
      surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Close button calls onClose', () => {
    const onClose = render();
    const closeBtn = document.querySelector('.icon-btn') as HTMLButtonElement;
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('KeyboardShortcutsModal — footer hint', () => {
  test('footer mentions where to edit the registry', () => {
    render();
    const footer = document.querySelector('.keyboard-shortcuts-modal-footer');
    expect(footer?.textContent).toContain('shortcutRegistry');
  });
});
