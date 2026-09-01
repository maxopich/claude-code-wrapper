// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { useModalKeys } from './useModalKeys';

/**
 * Register U13 — Enter must not override the control the operator chose.
 *
 * `useModalKeys` binds `keydown` on `document` and, for any Enter that wasn't
 * in a `<textarea>`, ran the modal's primary action and swallowed the default.
 * Focus the **Cancel** button of the Settings modal, press Enter, and the
 * change you meant to discard was saved instead. Same for the "Save as
 * template" modal — the two surfaces that pass `onConfirm`.
 *
 * The IME case isn't in the register and is the same bug wearing a different
 * hat: committing a Japanese/Chinese candidate with Enter inside the workspace
 * folder field fired `keydown` with `isComposing: true`, so the modal saved and
 * closed mid-word.
 *
 * These tests drive the real hook through a mounted component and dispatch
 * genuine `KeyboardEvent`s at `document`, because the bug lived in the
 * interaction between the document-level listener and the focused element —
 * calling the handler directly would have proved nothing.
 */

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

type Opts = Parameters<typeof useModalKeys>[0];

function mount(opts: Opts): void {
  function Harness() {
    useModalKeys(opts);
    return null;
  }
  act(() => {
    root.render(createElement(Harness));
  });
}

/** Dispatch a real keydown from `target`, returning whether the default was
 *  prevented (the hook's other side effect, and the reason a focused button
 *  never got to activate itself). */
function press(
  key: string,
  target: EventTarget,
  init: KeyboardEventInit = {},
): { defaultPrevented: boolean } {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return { defaultPrevented: e.defaultPrevented };
}

function element(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  container.appendChild(el);
  return el;
}

describe('useModalKeys — Enter', () => {
  test('confirms from a plain text input (the shortcut this exists for)', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    const { defaultPrevented } = press('Enter', element('input', { type: 'text' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(defaultPrevented).toBe(true);
  });

  test('does NOT confirm when a button is the target — the U13 regression', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    const { defaultPrevented } = press('Enter', element('button'));
    expect(onConfirm).not.toHaveBeenCalled();
    // The button must also keep its own activation behaviour.
    expect(defaultPrevented).toBe(false);
  });

  test('does NOT confirm from a link, summary, select or role=button', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    for (const target of [
      element('a', { href: '#x' }),
      element('summary'),
      element('select'),
      element('div', { role: 'button' }),
    ]) {
      press('Enter', target);
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('still confirms from an anchor with no href (not a link)', () => {
    // `<a>` without href isn't interactive and doesn't activate on Enter, so
    // the shortcut is not overriding anything.
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    press('Enter', element('a'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('does NOT confirm from a textarea (pre-existing contract, kept)', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    press('Enter', element('textarea'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('does NOT confirm mid-IME-composition', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: true });
    const input = element('input', { type: 'text' });
    press('Enter', input, { isComposing: true });
    expect(onConfirm).not.toHaveBeenCalled();
    // …and still confirms once composition has ended.
    press('Enter', input);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('respects Shift+Enter and canConfirm=false', () => {
    const onConfirm = vi.fn();
    mount({ onClose: vi.fn(), onConfirm, canConfirm: false });
    press('Enter', element('input', { type: 'text' }));
    expect(onConfirm).not.toHaveBeenCalled();

    const onConfirm2 = vi.fn();
    mount({ onClose: vi.fn(), onConfirm: onConfirm2, canConfirm: true });
    press('Enter', element('input', { type: 'text' }), { shiftKey: true });
    expect(onConfirm2).not.toHaveBeenCalled();
  });
});

describe('useModalKeys — Escape', () => {
  test('closes from any target, including a focused button', () => {
    const onClose = vi.fn();
    mount({ onClose, onConfirm: vi.fn(), canConfirm: true });
    press('Escape', element('button'));
    press('Escape', element('input', { type: 'text' }));
    press('Escape', element('textarea'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('useModalKeys — nested modals (Cebab-ygu.29)', () => {
  /**
   * A ConfirmGateModal opened inside SettingsModal/LogsModal shares the
   * `document` listener with its host. The host modal is already open when the
   * operator triggers the gate, so the host's listener is registered first;
   * before the topmost-only guard Escape ran the host's onClose (closing
   * Settings and reverting its theme snapshot) and Enter in the gate's text
   * field reached the host's onConfirm (saving what the operator was abandoning).
   * Only the topmost (last-mounted) modal may act on a key.
   *
   * These tests model the real sequence — host mounts first, gate mounts later
   * as a child component — because effect order alone would otherwise mislead:
   * a child component's effect runs BEFORE its parent's, so mounting both in one
   * render would register the child first and invert what "topmost" means.
   */
  let parentClose: Mock<() => void>;
  let parentConfirm: Mock<() => void>;
  let childClose: Mock<() => void>;
  let childConfirm: Mock<() => void>;

  function Gate() {
    // Mirrors ConfirmGateModal: the gate passes no onConfirm to useModalKeys,
    // so its confirm path lives on a focused field, not this document listener.
    useModalKeys({ onClose: childClose, onConfirm: childConfirm, canConfirm: true });
    return null;
  }
  function Host({ gateOpen }: { gateOpen: boolean }) {
    useModalKeys({ onClose: parentClose, onConfirm: parentConfirm, canConfirm: true });
    return gateOpen ? createElement(Gate) : null;
  }

  /** Open the host, then (in a later commit) the nested gate — mount order the
   *  same as the running app. */
  function openHostThenGate(): void {
    act(() => {
      root.render(createElement(Host, { gateOpen: false }));
    });
    act(() => {
      root.render(createElement(Host, { gateOpen: true }));
    });
  }

  beforeEach(() => {
    parentClose = vi.fn();
    parentConfirm = vi.fn();
    childClose = vi.fn();
    childConfirm = vi.fn();
  });

  test('Escape closes only the topmost (gate), not the host', () => {
    openHostThenGate();
    press('Escape', element('input', { type: 'text' }));
    expect(childClose).toHaveBeenCalledTimes(1);
    expect(parentClose).not.toHaveBeenCalled();
  });

  test("Enter in the gate's text field does not reach the host's onConfirm", () => {
    openHostThenGate();
    press('Enter', element('input', { type: 'text' }));
    expect(parentConfirm).not.toHaveBeenCalled();
    expect(childConfirm).toHaveBeenCalledTimes(1);
  });

  test('once the gate closes, the host handles keys again', () => {
    openHostThenGate();
    press('Escape', element('input', { type: 'text' }));
    expect(childClose).toHaveBeenCalledTimes(1);
    expect(parentClose).not.toHaveBeenCalled();

    // Gate unmounts; the host is topmost again and now handles Escape.
    act(() => {
      root.render(createElement(Host, { gateOpen: false }));
    });
    press('Escape', element('input', { type: 'text' }));
    expect(parentClose).toHaveBeenCalledTimes(1);
    expect(childClose).toHaveBeenCalledTimes(1);
  });
});
