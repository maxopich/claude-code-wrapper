// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useRef } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { AssistantProvider } from './AssistantContext';
import { AssistantDock } from './AssistantDock';

// Cebab-8x8.3.2 (acceptance):
//   - Renders nothing until `settings` reports an assistantProjectId.
//   - Click toggles aria-expanded and mounts a role=dialog panel.
//   - Esc closes and returns focus to the trigger.
//   - While open: no [inert] anywhere, body scroll NOT locked (it's a popover).
//   - send receives exactly {type:'send_message', projectId, text} — no maxTurns.
//   - A permission_request for the assistant session renders NO approval card.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ASSISTANT_PID = 99;
const SID = 'sess-assistant-1';

let container: HTMLElement;
let root: Root;
let sent: ClientMsg[];
let handler: (msg: ServerMsg) => void;

function settingsMsg(assistantProjectId?: number): ServerMsg {
  return {
    type: 'settings',
    workspaceRoot: null,
    workspaceRootValid: true,
    defaultWorkspaceRoot: '/home/op/agents',
    defaultHopBudget: 30,
    ...(assistantProjectId !== undefined ? { assistantProjectId } : {}),
  };
}

// Test host: mirrors the App.tsx wiring — a handlerRef the provider populates,
// captured here so the test can feed ServerMsgs the way onMessage does.
function Host() {
  const handlerRef = useRef<((msg: ServerMsg) => void) | null>(null);
  handler = (msg) => handlerRef.current?.(msg);
  return (
    <AssistantProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
      <AssistantDock />
    </AssistantProvider>
  );
}

function mount() {
  act(() => {
    root.render(<Host />);
  });
}

function feed(msg: ServerMsg) {
  act(() => {
    handler(msg);
  });
}

function trigger(): HTMLButtonElement | null {
  return container.querySelector('.assistant-dock-trigger');
}

beforeEach(() => {
  sent = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('AssistantDock / render gate', () => {
  test('renders nothing when assistantProjectId is absent', () => {
    mount();
    expect(trigger()).toBeNull();
    // Even after a settings msg that omits the id.
    feed(settingsMsg());
    expect(trigger()).toBeNull();
  });

  test('renders the trigger once settings reports an assistantProjectId', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    expect(trigger()).not.toBeNull();
  });
});

describe('AssistantDock / popover open + close', () => {
  test('click toggles aria-expanded and mounts a role=dialog panel', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const btn = trigger()!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('Esc closes and returns focus to the trigger', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const btn = trigger()!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  test('while open there is no [inert] anywhere and body scroll is NOT locked', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const btn = trigger()!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelectorAll('[inert]').length).toBe(0);
    expect(document.body.style.overflow).toBe('');
  });
});

describe('AssistantDock / send shape', () => {
  test('sending a chip question ships exactly {type,projectId,text} with no maxTurns', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const btn = trigger()!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The empty state renders the four suggested-question chips.
    const chip = container.querySelector<HTMLButtonElement>('.assistant-chip');
    expect(chip).not.toBeNull();
    act(() => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg).toEqual({
      type: 'send_message',
      projectId: ASSISTANT_PID,
      text: chip!.textContent,
    });
    expect('maxTurns' in msg).toBe(false);
    expect('sessionId' in msg).toBe(false);
  });
});

describe('AssistantDock / permission_request renders no approval card', () => {
  test('a permission_request for the assistant session shows no approval card', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    // Adopt the session, then deliver a permission_request on it.
    feed({
      type: 'session_started',
      sessionId: SID,
      projectId: ASSISTANT_PID,
      model: 'm',
      tools: [],
    });
    feed({
      type: 'permission_request',
      sessionId: SID,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      category: 'dangerous',
    });
    const btn = trigger()!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The transcript filters permission_request out entirely — no permission
    // card, and therefore no approve/deny actions to click.
    expect(container.querySelector('.permission')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
