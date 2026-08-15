// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { UserPromptInput } from './MultiAgentTab';

/**
 * Cebab-u0s — the bus composer must not eat a prompt it could not send.
 *
 * `submit()` used to be `props.onSend(trimmed); setText('')`. The send was
 * unchecked, so a message typed while the socket was reconnecting was cleared
 * from the box and never reached the run: the operator watched their own text
 * disappear, which reads exactly like a message that went through.
 *
 * `onSend` now reports whether it actually went out and the clear is gated on
 * it. These cases drive the real DOM path — type into the textarea, click Send
 * — so a pass says something about the component and not just about a helper.
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

function render(onSend: (text: string) => boolean) {
  act(() => {
    root.render(<UserPromptInput onSend={onSend} />);
  });
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function sendBtn(): HTMLButtonElement {
  return container.querySelector('.primary-btn') as HTMLButtonElement;
}

/**
 * React tracks the previous value internally, so assigning `.value` and firing
 * `input` does not reach `onChange`. Same prototype-setter trick the sibling
 * modal tests use.
 */
function type(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('UserPromptInput — a delivered prompt (control)', () => {
  test('clears the composer once the send reports success', () => {
    const onSend = vi.fn(() => true);
    render(onSend);
    type('route this to the reviewer');
    act(() => {
      sendBtn().click();
    });
    expect(onSend).toHaveBeenCalledWith('route this to the reviewer');
    expect(textarea().value).toBe('');
  });

  test('trims before sending, and still clears', () => {
    // Pins the pre-existing trim so the guard did not quietly change what the
    // run receives.
    const onSend = vi.fn(() => true);
    render(onSend);
    type('   padded   ');
    act(() => {
      sendBtn().click();
    });
    expect(onSend).toHaveBeenCalledWith('padded');
    expect(textarea().value).toBe('');
  });
});

describe('UserPromptInput — an undelivered prompt keeps the text (Cebab-u0s)', () => {
  test('does not clear the composer when the send reports failure', () => {
    const onSend = vi.fn(() => false);
    render(onSend);
    type('this one must survive');
    act(() => {
      sendBtn().click();
    });
    expect(onSend).toHaveBeenCalledWith('this one must survive');
    // The whole point: the operator still has what they wrote.
    expect(textarea().value).toBe('this one must survive');
  });

  test('the same text can be sent again once the socket is back', () => {
    // Guards the lazy fix: an early return that also disabled the button would
    // satisfy the case above while making the retry impossible. `disabled` is
    // bound to `text.trim().length === 0`, so a preserved box stays live.
    let deliverable = false;
    const onSend = vi.fn(() => deliverable);
    render(onSend);
    type('retry me');
    act(() => {
      sendBtn().click();
    });
    expect(textarea().value).toBe('retry me');
    expect(sendBtn().disabled).toBe(false);

    deliverable = true;
    act(() => {
      sendBtn().click();
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('retry me');
    expect(textarea().value).toBe('');
  });

  test('an empty box still sends nothing, delivered or not', () => {
    // Negative control: the guard must not have turned the whitespace check
    // into a path that calls `onSend` with an empty string.
    const onSend = vi.fn(() => false);
    render(onSend);
    type('   ');
    act(() => {
      sendBtn().click();
    });
    expect(onSend).not.toHaveBeenCalled();
  });
});
