// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { CopyButton } from './CopyButton';

// Pins the reusable hover copy button: idle/confirmed glyph swap, the actual
// clipboard write, the timed reset back to idle, and className pass-through.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function btn(): HTMLButtonElement {
  return container.querySelector('.copy-btn') as HTMLButtonElement;
}

describe('CopyButton', () => {
  test('renders the idle glyph and the provided label', () => {
    act(() => {
      root.render(<CopyButton text="hello" label="Copy message" />);
    });
    expect(btn().textContent).toContain('⧉');
    expect(btn().getAttribute('aria-label')).toBe('Copy message');
    expect(btn().classList.contains('icon-btn')).toBe(true);
  });

  test('passes an extra className through alongside copy-btn', () => {
    act(() => {
      root.render(<CopyButton text="x" className="msg-copy" />);
    });
    expect(btn().classList.contains('msg-copy')).toBe(true);
    expect(btn().classList.contains('copy-btn')).toBe(true);
  });

  test('writes the text and shows the confirmed glyph on click', async () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<CopyButton text="hello world" />);
    });
    await act(async () => {
      btn().click();
      await vi.advanceTimersByTimeAsync(0); // flush the clipboard promise chain
    });
    expect(writeText).toHaveBeenCalledWith('hello world');
    expect(btn().textContent).toContain('✓');
    expect(btn().getAttribute('aria-label')).toBe('Copied');
  });

  test('reverts to the idle glyph after the reset timeout', async () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<CopyButton text="x" />);
    });
    await act(async () => {
      btn().click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(btn().textContent).toContain('✓');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(btn().textContent).toContain('⧉');
  });
});
