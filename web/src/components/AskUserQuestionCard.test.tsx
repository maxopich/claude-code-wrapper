// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PendingAskUserQuestionView } from '@cebab/shared/protocol';
import { AskUserQuestionCard } from './AskUserQuestionCard';

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

function render(pending: PendingAskUserQuestionView | null, onSubmit = vi.fn()) {
  act(() => {
    root.render(<AskUserQuestionCard pending={pending} onSubmit={onSubmit} />);
  });
  return onSubmit;
}

function sendBtn(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Send answer',
  );
  return btn as HTMLButtonElement;
}

function optionByLabel(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('.ask-user-option')].find((b) =>
    b.textContent?.includes(label),
  );
  return btn as HTMLButtonElement;
}

const single: PendingAskUserQuestionView = {
  agent: 'hodor',
  toolUseId: 'tu1',
  questions: [
    {
      question: 'Deploy where?',
      header: 'Env',
      options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }],
      multiSelect: false,
    },
  ],
};

describe('AskUserQuestionCard', () => {
  test('renders nothing when pending is null', () => {
    render(null);
    expect(container.querySelector('.ask-user-card')).toBeNull();
  });

  test('renders the agent badge, question, and options', () => {
    render(single);
    expect(container.querySelector('.ask-user-card-badge')?.textContent).toContain('hodor');
    expect(container.querySelector('.ask-user-q-text')?.textContent).toBe('Deploy where?');
    expect(container.querySelectorAll('.ask-user-option')).toHaveLength(2);
  });

  test('Send is disabled until an option is chosen, then submits the answer', () => {
    const onSubmit = render(single);
    expect(sendBtn().disabled).toBe(true);

    act(() => optionByLabel('Prod').click());
    expect(sendBtn().disabled).toBe(false);

    act(() => sendBtn().click());
    expect(onSubmit).toHaveBeenCalledWith('hodor', 'tu1', { 'Deploy where?': 'Prod' });
  });

  test('free-text "Other" contributes the answer', () => {
    const onSubmit = render(single);
    const other = container.querySelector('.ask-user-other') as HTMLInputElement;
    act(() => {
      // Drive React's onChange via the native value setter.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter) setter.call(other, 'us-east-2');
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sendBtn().disabled).toBe(false);
    act(() => sendBtn().click());
    expect(onSubmit).toHaveBeenCalledWith('hodor', 'tu1', { 'Deploy where?': 'us-east-2' });
  });

  test('multi-select joins picks with commas', () => {
    const onSubmit = render({
      agent: 'a',
      toolUseId: 'tu2',
      questions: [
        {
          question: 'Which checks?',
          header: 'Checks',
          options: [{ label: 'lint' }, { label: 'test' }, { label: 'types' }],
          multiSelect: true,
        },
      ],
    });
    act(() => optionByLabel('lint').click());
    act(() => optionByLabel('types').click());
    act(() => sendBtn().click());
    expect(onSubmit).toHaveBeenCalledWith('a', 'tu2', { 'Which checks?': 'lint, types' });
  });
});

/**
 * W04 — answers belong to the question they were typed for.
 *
 * The host renders this card ungated for the whole run, so `pending: null`
 * hides it without unmounting. `picks` / `other` are keyed by question INDEX,
 * which only means anything relative to one `toolUseId`. Before the fix the
 * next question inherited index 0 of the last one, arrived already marked
 * complete, and was one click from shipping a different agent's answer.
 *
 * Every case below re-renders the SAME root — which is exactly why the suite
 * above never caught this: each of its tests gets a fresh mount in
 * `beforeEach`, so the state never had a chance to outlive its question.
 */
describe('AskUserQuestionCard — answers are stamped with their question (W04)', () => {
  const second: PendingAskUserQuestionView = {
    agent: 'bran',
    toolUseId: 'tu-second',
    questions: [
      {
        question: 'Roll back?',
        header: 'Rollback',
        options: [{ label: 'Yes' }, { label: 'No' }],
        multiSelect: false,
      },
    ],
  };

  test('a second question arrives blank and cannot be sent', () => {
    const onSubmit = render(single);
    act(() => optionByLabel('Prod').click());
    expect(sendBtn().disabled).toBe(false);

    render(second, onSubmit);
    expect(container.querySelector('.ask-user-q-text')?.textContent).toBe('Roll back?');
    expect(
      [...container.querySelectorAll('.ask-user-option')].some(
        (b) => b.getAttribute('aria-pressed') === 'true',
      ),
    ).toBe(false);
    expect((container.querySelector('.ask-user-other') as HTMLInputElement).value).toBe('');
    expect(sendBtn().disabled).toBe(true);
  });

  test('the stale answer is not resurrected by answering the new question', () => {
    const onSubmit = render(single);
    act(() => optionByLabel('Prod').click());
    render(second, onSubmit);
    act(() => optionByLabel('Yes').click());
    act(() => sendBtn().click());
    expect(onSubmit).toHaveBeenCalledWith('bran', 'tu-second', { 'Roll back?': 'Yes' });
  });

  test('a question that clears and returns is still blank', () => {
    // The real sequence: `multi_agent_ask_user_resolved` nulls the slot, the
    // card renders nothing, and the next question mounts into the same node.
    const onSubmit = render(single);
    act(() => optionByLabel('Prod').click());
    render(null, onSubmit);
    render(second, onSubmit);
    expect(sendBtn().disabled).toBe(true);
  });

  test('CONTROL: re-rendering the SAME question keeps the in-progress answer', () => {
    // A reset-on-every-render would satisfy the three cases above and fail
    // here — the card re-renders constantly while a run streams.
    const onSubmit = render(single);
    act(() => optionByLabel('Prod').click());
    render({ ...single }, onSubmit);
    expect(sendBtn().disabled).toBe(false);
    act(() => sendBtn().click());
    expect(onSubmit).toHaveBeenCalledWith('hodor', 'tu1', { 'Deploy where?': 'Prod' });
  });

  test('CONTROL: free-text carries the same stamp as the option picks', () => {
    const onSubmit = render(single);
    const type = (value: string) => {
      const other = container.querySelector('.ask-user-other') as HTMLInputElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(other, value);
        other.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('us-east-2');
    expect(sendBtn().disabled).toBe(false);
    render(second, onSubmit);
    expect((container.querySelector('.ask-user-other') as HTMLInputElement).value).toBe('');
    expect(sendBtn().disabled).toBe(true);
  });
});
