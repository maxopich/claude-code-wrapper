// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatView } from './ChatView';
import type { MessageView, SessionView } from '../store';

/**
 * `Cebab-ibb4`: what the quiet chat actually puts on screen.
 *
 * `quietChat.test.ts` pins the grouping and the pin table as pure functions.
 * This file asserts the part those cannot: that the rows they select are the
 * rows the DOM ends up with, that the toggle brings the rest back, and — the
 * case worth the file on its own — that a permission card is still THERE.
 * A collapse that swallowed a permission card would look calm and leave the
 * agent waiting forever on a question the operator was never shown.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
type MaybeScrollTo = { scrollTo?: unknown };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom ships no `Element.prototype.scrollTo`, and ChatView's mount effect
  // calls it — see `ChatView.test.tsx`'s header.
  (Element.prototype as MaybeScrollTo).scrollTo = () => {};
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (Element.prototype as MaybeScrollTo).scrollTo;
});

const TURN: MessageView[] = [
  { kind: 'user', id: 'm1', text: 'what changed?' },
  { kind: 'system', id: 'm2', subtype: 'init', text: 'session abc • model opus • 14 tools' },
  {
    kind: 'assistant',
    id: 'm3',
    blocks: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git diff --stat' } },
    ],
  },
  {
    kind: 'system',
    id: 'm4',
    subtype: 'tool_result',
    text: 'ONE-VERY-DISTINCTIVE-LINE',
    toolName: 'Bash',
  },
  { kind: 'assistant', id: 'm5', blocks: [{ type: 'text', text: 'Two files moved.' }] },
  { kind: 'result', id: 'm6', subtype: 'success', cost: 0.12 },
];

function mkSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    projectId: 1,
    status: 'done',
    messages: TURN,
    streamingText: '',
    runStartedAt: null,
    heldMessages: [],
    ...overrides,
  };
}

function render(session: SessionView, quiet: boolean) {
  act(() => {
    root.render(
      <ChatView
        session={session}
        isLive={false}
        onPermissionDecide={() => {}}
        onAskUserAnswer={() => {}}
        quiet={quiet}
      />,
    );
  });
}

const toggle = () => container.querySelector('.quiet-steps-toggle') as HTMLButtonElement | null;
const text = () => container.textContent ?? '';

describe('ChatView in the quiet view', () => {
  test('the prompt and the answer survive; the command and its output do not', () => {
    render(mkSession(), true);
    expect(text()).toContain('what changed?');
    expect(text()).toContain('Two files moved.');
    expect(text()).not.toContain('ONE-VERY-DISTINCTIVE-LINE');
    expect(text()).not.toContain('git diff --stat');
    expect(container.querySelector('.msg.tool-result')).toBeNull();
    expect(container.querySelector('.block-tool-use')).toBeNull();
  });

  test('the preamble goes with the step it belongs to, not with the answer', () => {
    // `let me look` is text, but it is text the agent said on its way to a tool
    // call. Keeping it would make the quiet view a shorter transcript rather
    // than an answer.
    render(mkSession(), true);
    expect(text()).not.toContain('let me look');
  });

  test('CONTROL: with the quiet view off, every one of those is on screen', () => {
    // The anti-vacuity pair. Without it, a ChatView that rendered nothing at
    // all would satisfy every `not.toContain` above.
    render(mkSession(), false);
    expect(text()).toContain('ONE-VERY-DISTINCTIVE-LINE');
    expect(text()).toContain('git diff --stat');
    expect(text()).toContain('let me look');
    expect(container.querySelector('.quiet-steps-toggle')).toBeNull();
  });

  test('the toggle says how much is hidden, and brings it back in place', () => {
    render(mkSession(), true);
    const btn = toggle();
    expect(btn?.textContent).toContain('3 steps');
    expect(btn?.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(text()).toContain('ONE-VERY-DISTINCTIVE-LINE');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.textContent).toContain('hide 3 steps');

    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(text()).not.toContain('ONE-VERY-DISTINCTIVE-LINE');
  });

  test('a turn with nothing to hide draws no toggle', () => {
    render(
      mkSession({
        messages: [
          { kind: 'user', id: 'm1', text: 'hi' },
          { kind: 'assistant', id: 'm2', blocks: [{ type: 'text', text: 'hello' }] },
        ],
      }),
      true,
    );
    expect(toggle()).toBeNull();
  });

  test('A GATE IS NEVER SWALLOWED: an undecided permission card renders collapsed', () => {
    const permission: MessageView = {
      kind: 'permission_request',
      id: 'p1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      category: 'dangerous',
      summary: 'rm -rf build',
    };
    render(
      mkSession({ status: 'running', messages: [TURN[0], TURN[1], TURN[2], permission] }),
      true,
    );
    expect(container.querySelector('.msg.permission')).not.toBeNull();
    expect(text()).toContain('permission · Bash');
  });

  test('AND NEITHER IS A PARKED QUESTION', () => {
    const question: MessageView = {
      kind: 'ask_user_question',
      id: 'q1',
      toolUseId: 'tu-9',
      agent: 'Cebab',
      questions: [{ question: 'Which branch?', header: 'Branch', options: [], multiSelect: false }],
    };
    render(mkSession({ status: 'running', messages: [TURN[0], TURN[1], question] }), true);
    expect(text()).toContain('Which branch?');
  });

  test('a turn that died shows the error rather than an empty answer', () => {
    render(
      mkSession({
        status: 'error',
        messages: [
          TURN[0],
          TURN[2],
          {
            kind: 'result',
            id: 'r1',
            subtype: 'error_during_execution',
            cost: 0,
            errors: ['boom'],
          },
        ],
      }),
      true,
    );
    expect(text()).toContain('error_during_execution');
  });

  test('the live label names the tool AND its subject', () => {
    // The other half of the feature: with the steps put away, this line is the
    // only thing moving, so "running Bash" would leave the operator with less
    // than they had.
    render(
      mkSession({
        status: 'running',
        messages: [
          TURN[0],
          {
            kind: 'assistant',
            id: 'a1',
            blocks: [
              {
                type: 'tool_use',
                id: 'tu2',
                name: 'Read',
                input: { file_path: 'web/src/store.ts' },
              },
            ],
          },
        ],
      }),
      true,
    );
    expect(container.querySelector('.ti-label')?.textContent).toBe('reading web/src/store.ts…');
  });
});
