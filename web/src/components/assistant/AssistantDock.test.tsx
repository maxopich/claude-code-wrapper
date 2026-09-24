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
let fireConnLost: () => void;

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
  const connLostRef = useRef<(() => void) | null>(null);
  handler = (msg) => handlerRef.current?.(msg);
  fireConnLost = () => connLostRef.current?.();
  return (
    <AssistantProvider send={(m) => sent.push(m)} handlerRef={handlerRef} connLostRef={connLostRef}>
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

/** Type into the composer and press its send button. The native value setter +
 *  `input` event is the standard way to drive a CONTROLLED React textarea from
 *  jsdom — assigning `.value` alone does not notify React. */
function sendViaComposer(text: string) {
  const ta = container.querySelector<HTMLTextAreaElement>('.assistant-composer textarea');
  if (!ta) throw new Error('composer textarea not mounted');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no native value setter');
  act(() => {
    setValue.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const btn = container.querySelector<HTMLButtonElement>('.assistant-send');
  if (!btn) throw new Error('send button not mounted');
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The single button at the end of the composer row — Send when idle, Stop
 *  while an answer runs (both carry the `.assistant-send` class; they are told
 *  apart by aria-label). */
function composerButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('.assistant-send');
  if (!btn) throw new Error('composer button not mounted');
  return btn;
}

/** Type into the composer WITHOUT clicking Send (the standard native-setter +
 *  input-event dance for a controlled React textarea). */
function typeComposer(text: string) {
  const ta = container.querySelector<HTMLTextAreaElement>('.assistant-composer textarea');
  if (!ta) throw new Error('composer textarea not mounted');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no native value setter');
  act(() => {
    setValue.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Press Enter in the composer textarea (GrowTextarea submits on Enter). */
function pressEnter() {
  const ta = container.querySelector<HTMLTextAreaElement>('.assistant-composer textarea');
  if (!ta) throw new Error('composer textarea not mounted');
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function openPanel() {
  act(() => {
    trigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The server adopts a real session id for the in-flight turn. */
function startedMsg(sessionId = SID): ServerMsg {
  return { type: 'session_started', sessionId, projectId: ASSISTANT_PID, model: 'm', tools: [] };
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

describe('AssistantDock / help widget chrome (Cebab-i6fl)', () => {
  test('the trigger is found by the label "Cebab help"', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const byLabel = container.querySelector<HTMLButtonElement>('[aria-label="Cebab help"]');
    expect(byLabel).not.toBeNull();
    expect(byLabel).toBe(trigger());
    expect(byLabel!.getAttribute('title')).toBe('Cebab help');
  });

  test('data-open flips false -> true -> false as the panel opens and closes', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    const dock = container.querySelector<HTMLElement>('.assistant-dock');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('data-open')).toBe('false');

    const btn = trigger()!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dock!.getAttribute('data-open')).toBe('true');

    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dock!.getAttribute('data-open')).toBe('false');
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
    // Scoped to the FIRST send deliberately. No session exists yet, so there is
    // no id to carry and the server is meant to mint one. This is the control
    // for the follow-up case below: it proves the fix did not simply start
    // always sending a sessionId. Cebab-rn3.
    expect('sessionId' in msg).toBe(false);
  });

  // Cebab-rn3. `runOneTurn` does `msg.sessionId ?? randomUUID()` and passes
  // `resume: msg.sessionId`, so a follow-up WITHOUT the id mints a second
  // session and spawns with no `--resume` — the agent restarts cold while
  // `assistantReducer` keeps the scrollback, hiding it from the operator.
  test('a follow-up carries the sessionId the server handed back, so the turn resumes', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    act(() => {
      trigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const chip = container.querySelector<HTMLButtonElement>('.assistant-chip');
    act(() => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The server answers by adopting a real session id.
    feed({
      type: 'session_started',
      sessionId: SID,
      projectId: ASSISTANT_PID,
      model: 'm',
      tools: [],
    });
    // Cebab-eo71: the first turn must END before a follow-up can be sent — Send
    // is replaced by Stop while an answer runs. End it with a result.
    feed({ type: 'result', sessionId: SID, subtype: 'success', totalCostUsd: 0.01, durationMs: 5 });

    sendViaComposer('and how do I run one?');

    expect(sent).toHaveLength(2);
    const first = sent[0] as { sessionId?: string };
    const second = sent[1] as { type: string; sessionId?: string; text?: string };
    expect(first.sessionId).toBeUndefined();
    expect(second.type).toBe('send_message');
    expect(second.text).toBe('and how do I run one?');
    expect(second.sessionId).toBe(SID);
  });

  // The placeholder is this component's own invention. Sending it would make the
  // server resume a session id it never issued. Cebab-eo71: a second send before
  // session_started is now BLOCKED (the first turn is still running, so Send is
  // replaced by a disabled Stop), which upholds the same guarantee a stricter
  // way — the one send that goes out carries no sessionId at all.
  test('a second send BEFORE session_started never ships the pending placeholder', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    act(() => {
      trigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    sendViaComposer('first');
    // Second attempt while the first is still running — the composer button is
    // now Stop (disabled, no id yet) and Enter can't submit.
    typeComposer('second');
    pressEnter();
    const sends = sent.filter((m) => m.type === 'send_message');
    expect(sends).toHaveLength(1);
    expect((sends[0] as { sessionId?: string }).sessionId).toBeUndefined();
  });
});

describe('AssistantDock / stop, reset, failures, connection loss (Cebab-eo71)', () => {
  test('while an answer runs, Stop ships exactly { type: interrupt, sessionId } for the adopted id', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('how do I copy an agent?');
    feed(startedMsg());
    // Send has been replaced by Stop, now enabled (the id is known).
    const btn = composerButton();
    expect(btn.getAttribute('aria-label')).toBe('Stop the answer');
    expect(btn.disabled).toBe(false);
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const interrupts = sent.filter((m) => m.type === 'interrupt');
    expect(interrupts).toEqual([{ type: 'interrupt', sessionId: SID }]);
  });

  test('Stop is disabled before the server hands back a session id', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('question');
    // Running, but only the optimistic placeholder id exists.
    const btn = composerButton();
    expect(btn.getAttribute('aria-label')).toBe('Stop the answer');
    expect(btn.disabled).toBe(true);
  });

  test('after a failure, Send is shown and enabled again', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('question');
    feed(startedMsg());
    feed({ type: 'wrapper_error', sessionId: SID, kind: 'process_crashed', message: 'boom' });
    // Not running any more → Send returns, and enabled once there is text.
    typeComposer('another question');
    const btn = composerButton();
    expect(btn.getAttribute('aria-label')).toBe('Send message');
    expect(btn.disabled).toBe(false);
  });

  test('after New conversation, the next send carries no sessionId key', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('first question');
    feed(startedMsg());
    // End the turn so reset() is allowed (it is a no-op while running).
    feed({ type: 'result', sessionId: SID, subtype: 'success', totalCostUsd: 0.01, durationMs: 5 });
    const newConv = container.querySelector<HTMLButtonElement>('.assistant-panel-newconv');
    expect(newConv).not.toBeNull();
    expect(newConv!.disabled).toBe(false);
    act(() => {
      newConv!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    sendViaComposer('fresh start');
    const last = sent[sent.length - 1] as { type: string; sessionId?: string };
    expect(last.type).toBe('send_message');
    expect('sessionId' in last).toBe(false);
  });

  test('connection_lost ends a running answer with the connection line', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('question');
    feed(startedMsg());
    act(() => {
      fireConnLost();
    });
    expect(container.textContent).toContain(
      'Connection lost. This answer was cut off; ask again once Cebab reconnects.',
    );
    // The turn is over — Send is back.
    expect(composerButton().getAttribute('aria-label')).toBe('Send message');
  });

  test('a second send_message cannot be shipped while an answer runs', () => {
    mount();
    feed(settingsMsg(ASSISTANT_PID));
    openPanel();
    sendViaComposer('first question');
    feed(startedMsg());
    // Enter while running must not ship a second send_message (the composer's
    // submit early-returns; the button is Stop, not Send).
    typeComposer('second question');
    pressEnter();
    expect(sent.filter((m) => m.type === 'send_message')).toHaveLength(1);
  });
});

describe('AssistantDock / permission_request renders no approval card', () => {
  // Cebab-eo71: the assistant runs UNTRUSTED and the server refuses every tool
  // call it is asked about, so no permission_request is emitted in the normal
  // case; the transcript filter is a defence. A permission_request that did
  // arrive must never render an approval card the operator can't answer here.
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
