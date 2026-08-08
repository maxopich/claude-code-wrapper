// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmGateModal } from './ConfirmGateModal';

/**
 * The contract every confirmation in the app now inherits (register U16).
 *
 * Worth pinning here rather than at each call site: this component is the only
 * thing standing between a misclick and an irreversible action at four (soon
 * more) places, and the properties that matter are the ones that are easy to
 * lose in a refactor — where focus lands, whether the destructive button is
 * genuinely inert before the token matches, and whether confirm can fire
 * twice.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<Parameters<typeof ConfirmGateModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <ConfirmGateModal
        title="Delete everything?"
        body={<p>This cannot be undone.</p>}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />,
    );
  });
  return { onConfirm, onCancel };
}

const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.gate-modal-btn'));
const byLabel = (label: string) => buttons().find((b) => b.textContent?.trim() === label) ?? null;
const ackInput = () => container.querySelector<HTMLInputElement>('.gate-modal-input-ack');

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ConfirmGateModal — dialog semantics', () => {
  test('is a labelled modal dialog', () => {
    render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Delete everything?');
  });

  test('renders the body as markup, so the target can be named', () => {
    render({
      body: (
        <p>
          Deleting from <strong>Cebab</strong>.
        </p>
      ),
    });
    expect(container.querySelector('.gate-modal-help strong')?.textContent).toBe('Cebab');
  });
});

describe('ConfirmGateModal — the safe default', () => {
  test('focus lands on Cancel, not on the destructive button', () => {
    // So a reflexive Enter on open cancels. Same posture as the two gates this
    // component was lifted from.
    render({ confirmLabel: 'Delete' });
    expect(document.activeElement).toBe(byLabel('Cancel'));
    expect(document.activeElement).not.toBe(byLabel('Delete'));
  });

  test('Esc cancels', () => {
    const { onCancel, onConfirm } = render();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('clicking the backdrop cancels; clicking the card does not', () => {
    const { onCancel } = render();
    const overlay = container.querySelector('.gate-modal-overlay')!;
    act(() => {
      container
        .querySelector('.gate-modal')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
    act(() => {
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmGateModal — plain confirm', () => {
  test('no typed field, and Confirm fires immediately', () => {
    const { onConfirm } = render();
    expect(ackInput()).toBeNull();
    expect(byLabel('Confirm')?.disabled).toBe(false);
    act(() => byLabel('Confirm')!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmGateModal — typed acknowledgment', () => {
  test('the destructive button is inert until the token matches exactly', () => {
    const { onConfirm } = render({ requireTyped: 'delete', confirmLabel: 'Delete' });
    const input = ackInput();
    expect(input).not.toBeNull();
    expect(byLabel('Delete')?.disabled).toBe(true);

    // Clicking it while disabled must not fire — `disabled` is the real
    // guard, not just a visual state.
    act(() => byLabel('Delete')!.click());
    expect(onConfirm).not.toHaveBeenCalled();

    setInputValue(input!, 'Delete'); // case matters
    expect(byLabel('Delete')?.disabled).toBe(true);

    setInputValue(input!, 'delete');
    expect(byLabel('Delete')?.disabled).toBe(false);
    act(() => byLabel('Delete')!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('the input never carries a placeholder (U29)', () => {
    render({ requireTyped: 'delete' });
    expect(ackInput()!.getAttribute('placeholder')).toBeNull();
    // ...and the token IS named, in a label the input points at — the
    // distinction the whole finding turns on.
    const label = container.querySelector('.gate-modal-label');
    expect(label?.textContent).toContain('delete');
  });

  test('Enter in the field confirms only once armed', () => {
    const { onConfirm } = render({ requireTyped: 'delete' });
    const input = ackInput()!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();

    setInputValue(input, 'delete');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('the typed field is not autofilled or spellchecked', () => {
    render({ requireTyped: 'delete' });
    expect(ackInput()!.getAttribute('autocomplete')).toBe('off');
    expect(ackInput()!.getAttribute('spellcheck')).toBe('false');
  });
});
