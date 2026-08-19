// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MutationCategory } from '@cebab/shared';
import type { MessageView } from '../store';
import { MessageBlock } from './MessageBlock';
import { DANGEROUS_ARM_MS } from './PermissionCards';

/**
 * Register U09 — the single-agent approval card.
 *
 * The card is the ask-mode path. It used to be described here as "the
 * untrusted-project path", on the grounds that `shouldAutoAllow` returned true
 * for every call in a Trusted project — true when written, and no longer
 * (Cebab-ws0.14): a trusted project in `default` mode now raises these cards
 * too. Either way the point stands and is what this file pins: when this
 * renders at all, a human is genuinely the last thing between the model and
 * the tool. It shipped with
 * `<button>Allow</button>` / `<button>Deny</button>` — no classes, no object in
 * the accessible name, and the affirmative one painted green by `:first-child`.
 * Allowing `Bash("rm -rf …")` cost the same single click as allowing a `Read`.
 *
 * What this pins:
 *   - both buttons name the tool, so "Allow" is never announced bare;
 *   - the classes exist, because the CSS keys the green on them now;
 *   - `dangerous` needs two clicks and sends NOTHING on the first;
 *   - `read` / `mutate` still send on the first — the friction is targeted,
 *     not blanket;
 *   - the armed state expires, so a card armed and abandoned can't be
 *     completed by a stray click later.
 *
 * Uses createRoot + act (no @testing-library) per project convention.
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
  vi.useRealTimers();
});

function permissionMessage(over: Partial<MessageView> = {}): MessageView {
  return {
    kind: 'permission_request',
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'rm -rf node_modules' },
    category: 'dangerous',
    summary: 'rm -rf node_modules',
    ...over,
  } as MessageView;
}

function render(message: MessageView, onDecide: (id: string, d: 'allow' | 'deny') => void): void {
  act(() => {
    root.render(<MessageBlock message={message} onPermissionDecide={onDecide} />);
  });
}

function button(cls: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`button.${cls}`);
  if (!el) throw new Error(`no button.${cls} rendered`);
  return el;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('permission card actions', () => {
  test('both buttons carry the tool name in their accessible name', () => {
    render(permissionMessage({ toolName: 'Write', category: 'mutate' }), vi.fn());
    expect(button('permission-allow').getAttribute('aria-label')).toBe('Allow Write');
    expect(button('permission-deny').getAttribute('aria-label')).toBe('Deny Write');
    // The visible text stays short — the name is for AT, not a relabelling.
    expect(button('permission-allow').textContent).toBe('Allow');
  });

  test.each(['read', 'mutate'] as MutationCategory[])(
    'a %s call is allowed on the first click',
    (category) => {
      const onDecide = vi.fn();
      render(permissionMessage({ category, toolName: 'Read' }), onDecide);
      click(button('permission-allow'));
      expect(onDecide).toHaveBeenCalledWith('req-1', 'allow');
    },
  );

  test('a dangerous call sends nothing on the first click', () => {
    const onDecide = vi.fn();
    render(permissionMessage(), onDecide);
    click(button('permission-allow'));
    expect(onDecide).not.toHaveBeenCalled();
    // …and says so, rather than looking like a dead button.
    expect(button('permission-allow').textContent).toBe('Confirm allow');
    expect(button('permission-allow').className).toContain('is-armed');
    expect(button('permission-allow').getAttribute('aria-label')).toBe('Confirm allowing Bash');
  });

  test('a dangerous call is allowed on the second click', () => {
    const onDecide = vi.fn();
    render(permissionMessage(), onDecide);
    click(button('permission-allow'));
    click(button('permission-allow'));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('req-1', 'allow');
  });

  test('the armed state expires', () => {
    vi.useFakeTimers();
    const onDecide = vi.fn();
    render(permissionMessage(), onDecide);
    click(button('permission-allow'));
    expect(button('permission-allow').className).toContain('is-armed');
    act(() => {
      vi.advanceTimersByTime(DANGEROUS_ARM_MS + 1);
    });
    expect(button('permission-allow').className).not.toContain('is-armed');
    // Disarmed means the next click arms again rather than allowing.
    click(button('permission-allow'));
    expect(onDecide).not.toHaveBeenCalled();
  });

  test('Deny is one click even for a dangerous call', () => {
    const onDecide = vi.fn();
    render(permissionMessage(), onDecide);
    click(button('permission-deny'));
    expect(onDecide).toHaveBeenCalledWith('req-1', 'deny');
  });

  test('the arm hint is only shown for dangerous calls', () => {
    render(permissionMessage({ category: 'read' }), vi.fn());
    expect(container.querySelector('.permission-arm-hint')).toBeNull();
    render(permissionMessage(), vi.fn());
    expect(container.querySelector('.permission-arm-hint')).not.toBeNull();
  });

  test('a decided card renders no actions at all', () => {
    render(permissionMessage({ decided: 'allow' } as Partial<MessageView>), vi.fn());
    expect(container.querySelector('button.permission-allow')).toBeNull();
    expect(container.querySelector('.decided')?.textContent).toContain('allow');
  });
});

/**
 * Register S06. A permission request that Cebab denied on the operator's
 * behalf — because the socket closed, or the turn was interrupted — used to
 * replay as a live card with working-looking buttons that did nothing. It now
 * replays as decided, and the card has to say WHO decided: "you denied this"
 * and "this was denied for you while you were gone" are different facts about
 * the same tool call, and only one of them is true.
 */
describe('a card decided by a drain says so', () => {
  const decidedCard = (over: Partial<MessageView>) =>
    permissionMessage({ decided: 'deny', ...over } as Partial<MessageView>);

  test('a disconnect-drained card names the disconnect', () => {
    render(decidedCard({ decidedReason: 'client_disconnected' } as Partial<MessageView>), vi.fn());
    const text = container.querySelector('.decided')?.textContent ?? '';
    expect(text).toContain('deny');
    expect(text).toContain('disconnected');
    // And it is still decided: no buttons come back.
    expect(container.querySelector('button.permission-deny')).toBeNull();
  });

  test('an interrupt-drained card names the interrupt', () => {
    render(decidedCard({ decidedReason: 'interrupted' } as Partial<MessageView>), vi.fn());
    expect(container.querySelector('.decided')?.textContent).toContain('interrupted');
  });

  test("an operator's own denial claims nothing extra", () => {
    // POSITIVE CONTROL. Both cases above assert extra copy appears; without
    // this one, a change that appended the automatic-denial wording to every
    // decided card would pass them and put the words in the operator's mouth
    // backwards — telling them they were away when they were not.
    render(decidedCard({}), vi.fn());
    const text = container.querySelector('.decided')?.textContent ?? '';
    expect(text).toContain('deny');
    expect(text).not.toContain('automatic');
    expect(text).not.toContain('disconnected');
    expect(text).not.toContain('interrupted');
  });
});
