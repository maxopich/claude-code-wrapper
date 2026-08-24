// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageView } from '../store';
import { MessageBlock } from './MessageBlock';

// Cebab-003 — pins the tool-output card. Before this, MessageBlock's whole
// `kind === 'system'` branch was `return null`, so Bash stdout, Read contents
// and Grep hits were received, stored, and then dropped at render.
//
//   1. A tool_result message renders its text. (Reverting to `return null`
//      reddens this one first.)
//   2. Long output previews, and the toggle reveals the rest.
//   3. Oversized output is cut with a visible note — never silently.
//   4. Copy carries the FULL string even when the render is capped.
//   5. is_error / toolName surface in the card's chrome.
//   6. NEGATIVE CONTROL: other system subtypes still render nothing.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function toolResult(partial: Partial<Extract<MessageView, { kind: 'system' }>> = {}): MessageView {
  return { kind: 'system', id: 'm1', subtype: 'tool_result', text: 'output', ...partial };
}

function render(m: MessageView) {
  act(() => {
    root.render(<MessageBlock message={m} />);
  });
}

function card(): HTMLElement | null {
  return container.querySelector('.msg.tool-result');
}

function body(): HTMLElement | null {
  return container.querySelector('.tool-result-body');
}

function toggle(): HTMLButtonElement | null {
  return container.querySelector('.tool-result-toggle');
}

describe('MessageBlock tool output — Cebab-003', () => {
  test('renders the tool result text', () => {
    render(toolResult({ text: 'CEBAB_QA_MARKER=[set]' }));
    expect(card()).not.toBeNull();
    expect(body()!.textContent).toBe('CEBAB_QA_MARKER=[set]');
  });

  test('names the tool that produced it, and degrades when unknown', () => {
    render(toolResult({ toolName: 'Bash' }));
    expect(container.querySelector('.msg.tool-result .role')!.textContent).toBe('Bash output');
    render(toolResult());
    expect(container.querySelector('.msg.tool-result .role')!.textContent).toBe('tool output');
  });

  test('an errored result says error and carries the error class', () => {
    render(toolResult({ text: 'command not found', isError: true, toolName: 'Bash' }));
    expect(card()!.classList.contains('has-error')).toBe(true);
    expect(container.querySelector('.msg.tool-result .role')!.textContent).toBe('Bash error');
  });

  test('short output shows in full with no expand toggle', () => {
    render(toolResult({ text: 'a\nb\nc' }));
    expect(body()!.textContent).toBe('a\nb\nc');
    expect(toggle()).toBeNull();
  });

  test('long output previews the head and the toggle reveals the rest', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    render(toolResult({ text }));
    expect(body()!.textContent).toContain('line 0');
    expect(body()!.textContent).not.toContain('line 39');
    const t = toggle()!;
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.textContent).toContain('40 lines');

    act(() => {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(body()!.textContent).toContain('line 39');
  });

  test('a single very long line still offers the toggle, measured in characters', () => {
    render(toolResult({ text: 'x'.repeat(5000) }));
    expect(toggle()!.textContent).toContain('5000 characters');
  });

  test('oversized output is cut with a visible note, and Copy still holds all of it', () => {
    const text = 'y'.repeat(25_000);
    render(toolResult({ text }));
    act(() => {
      toggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(body()!.textContent!.length).toBe(20_000);
    expect(container.querySelector('.tool-result-note')!.textContent).toContain('truncated');

    const copy = container.querySelector('.msg.tool-result .copy-btn') as HTMLButtonElement;
    act(() => {
      copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith(text);
  });

  test('empty output says so rather than rendering a blank card', () => {
    render(toolResult({ text: '' }));
    expect(body()!.textContent).toBe('(no output)');
  });

  test('NEGATIVE CONTROL: other system subtypes still render nothing', () => {
    render({
      kind: 'system',
      id: 'm2',
      subtype: 'init',
      text: 'session abc • model opus • 5 tools',
    });
    expect(container.textContent).toBe('');
    render({ kind: 'system', id: 'm3', subtype: 'compact_boundary', text: 'compacted' });
    expect(container.textContent).toBe('');
  });
});
