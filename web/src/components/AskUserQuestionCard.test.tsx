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
