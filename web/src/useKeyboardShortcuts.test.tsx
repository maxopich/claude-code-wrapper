// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ShortcutDescriptor } from './shortcutRegistry';
import { findShortcut, useKeyboardShortcuts } from './useKeyboardShortcuts';

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

// A throwaway descriptor; the hook only consults keyMatch / when / handler.
function descriptor(over: Partial<ShortcutDescriptor> = {}): ShortcutDescriptor {
  return {
    id: 'test.binding',
    section: 'Help',
    keyDisplay: ['x'],
    description: 'test',
    keyMatch: (e) => e.key === 'x',
    documentationOnly: false,
    ...over,
  };
}

function Harness({ bindings }: { bindings: ReadonlyArray<readonly [ShortcutDescriptor, () => void]> }) {
  useKeyboardShortcuts(bindings);
  return null;
}

function pressKey(init: KeyboardEventInit) {
  document.dispatchEvent(new KeyboardEvent('keydown', init));
}

describe('useKeyboardShortcuts — dispatch', () => {
  test('fires the handler when a registered descriptor matches', () => {
    const fn = vi.fn();
    act(() => {
      root.render(<Harness bindings={[[descriptor(), fn]]} />);
    });
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire when the key does not match', () => {
    const fn = vi.fn();
    act(() => {
      root.render(<Harness bindings={[[descriptor(), fn]]} />);
    });
    act(() => {
      pressKey({ key: 'y' });
    });
    expect(fn).not.toHaveBeenCalled();
  });

  test('first descriptor wins (registry order)', () => {
    const a = vi.fn();
    const b = vi.fn();
    const both: ReadonlyArray<readonly [ShortcutDescriptor, () => void]> = [
      [descriptor({ id: 'a', keyMatch: (e) => e.key === 'x' }), a],
      [descriptor({ id: 'b', keyMatch: (e) => e.key === 'x' }), b],
    ];
    act(() => {
      root.render(<Harness bindings={both} />);
    });
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  test('documentationOnly descriptors are skipped entirely', () => {
    const handler = vi.fn();
    const docOnly = descriptor({
      documentationOnly: true,
      // intentionally matches to prove documentationOnly wins
      keyMatch: () => true,
    });
    act(() => {
      root.render(<Harness bindings={[[docOnly, handler]]} />);
    });
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test('when predicate gates dispatch', () => {
    const fn = vi.fn();
    let ok = false;
    const gated = descriptor({
      when: () => ok,
    });
    act(() => {
      root.render(<Harness bindings={[[gated, fn]]} />);
    });
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(fn).not.toHaveBeenCalled();
    ok = true;
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('unmount removes the document listener', () => {
    const fn = vi.fn();
    act(() => {
      root.render(<Harness bindings={[[descriptor(), fn]]} />);
    });
    act(() => {
      root.unmount();
    });
    // Re-attach a fresh root so the afterEach can unmount cleanly.
    root = createRoot(container);
    act(() => {
      pressKey({ key: 'x' });
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('findShortcut', () => {
  test('returns the descriptor by id', () => {
    const list = [descriptor({ id: 'a' }), descriptor({ id: 'b' })];
    expect(findShortcut(list, 'b').id).toBe('b');
  });

  test('throws on unknown id', () => {
    const list = [descriptor({ id: 'a' })];
    expect(() => findShortcut(list, 'z')).toThrow(/unknown shortcut id/);
  });
});
