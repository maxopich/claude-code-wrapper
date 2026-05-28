// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { InputBox } from './InputBox';

/**
 * Cluster C Phase 1 (spec §4): tests for the Send / Stop swap in the
 * single-agent composer.
 *
 * Coverage:
 *   - UI-1: same DOM node carries both variants; class+icon+label flip
 *     on isRunning
 *   - UI-3: clicking Stop fires `onStop` (the App.tsx layer ships the
 *     `interrupt` ClientMsg)
 *   - UI-4: Stop button is enabled regardless of textarea content;
 *     `disabled` only applies when structurally disabled OR Stop is
 *     in-flight
 *   - UI-5: clicking Stop flips into "Stopping…" (disabled + spinner
 *     copy) and the second click is silently swallowed
 *   - UI-6: textarea stays enabled while running
 *   - UI-7: Esc dispatches Stop when focus is in the composer
 *   - Reset: when isRunning flips back to false, the local "stopping"
 *     state clears (next stop starts fresh)
 *   - Idle baseline: button is Send + disabled when textarea empty
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

function getButton(): HTMLButtonElement {
  const btn = container.querySelector('button') as HTMLButtonElement | null;
  if (!btn) throw new Error('button not found');
  return btn;
}

function getTextarea(): HTMLTextAreaElement {
  const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
  if (!ta) throw new Error('textarea not found');
  return ta;
}

describe('InputBox — idle (not running)', () => {
  test('shows Send button, disabled when textarea empty', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const btn = getButton();
    expect(btn.textContent).toContain('Send');
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain('input-box-btn-send');
  });

  test('Send dispatches onSend(text) and clears textarea', () => {
    const onSend = vi.fn();
    act(() => {
      root.render(<InputBox onSend={onSend} />);
    });
    const ta = getTextarea();
    // React's controlled-component pattern: poke the value via the
    // prototype setter so React's synthetic onChange detects the
    // mutation, then dispatch the input event to fire it. Plain
    // `ta.value = ...` skips the React internals.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(ta, 'hello');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const btn = getButton();
    expect(btn.disabled).toBe(false);
    act(() => {
      btn.click();
    });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(ta.value).toBe('');
  });

  test('structural disabled disables both textarea and button', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} disabled />);
    });
    expect(getTextarea().disabled).toBe(true);
    expect(getButton().disabled).toBe(true);
  });
});

describe('InputBox — running (Stop variant)', () => {
  test('swaps to Stop button (same DOM node, class + label flip)', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={() => {}} />);
    });
    const btn = getButton();
    expect(btn.textContent).toContain('Stop');
    expect(btn.className).toContain('input-box-btn-stop');
    expect(btn.getAttribute('aria-label')).toBe('Stop the current response');
  });

  test('UI-4: Stop button enabled regardless of textarea content', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={() => {}} />);
    });
    // Textarea is empty; Send would be disabled here.
    expect(getButton().disabled).toBe(false);
  });

  test('UI-6: textarea stays enabled while running', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={() => {}} />);
    });
    expect(getTextarea().disabled).toBe(false);
  });

  test('UI-3: click fires onStop once', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={onStop} />);
    });
    act(() => {
      getButton().click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('UI-5: clicking Stop flips to "Stopping…" and second click is silent', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={onStop} />);
    });
    act(() => {
      getButton().click();
    });
    // After click, button shows Stopping…, is disabled, and second click is a no-op.
    const btn2 = getButton();
    expect(btn2.textContent).toContain('Stopping…');
    expect(btn2.className).toContain('is-stopping');
    expect(btn2.disabled).toBe(true);
    act(() => {
      btn2.click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('UI-7: Esc keypress in the composer fires onStop', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={onStop} />);
    });
    const ta = getTextarea();
    act(() => {
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('Esc with focus OUTSIDE the composer does NOT fire onStop', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={onStop} />);
    });
    // Synthesize an Esc on the document body (outside .input-box).
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  test('Stop button disabled when structurally disabled prop is also true', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={() => {}} disabled />);
    });
    // Even though isRunning, the structural `disabled` wins for both
    // textarea and Stop button.
    expect(getButton().disabled).toBe(true);
    expect(getTextarea().disabled).toBe(true);
  });
});

describe('InputBox — isRunning flip handling', () => {
  test('isRunning → true → false clears the stopping flag so the next Stop starts fresh', () => {
    const onStop = vi.fn();
    function Harness({ running }: { running: boolean }) {
      return <InputBox onSend={() => {}} isRunning={running} onStop={onStop} />;
    }
    act(() => {
      root.render(<Harness running />);
    });
    // First Stop click → stopping flag flips, disabled.
    act(() => {
      getButton().click();
    });
    expect(getButton().disabled).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);

    // Parent flips running back to false (server's session_running
    // arrived). isRunning false reverts to Send variant; the local
    // stopping flag should be cleared via the useEffect.
    act(() => {
      root.render(<Harness running={false} />);
    });
    const btn3 = getButton();
    expect(btn3.textContent).toContain('Send');
    expect(btn3.className).toContain('input-box-btn-send');

    // Re-run: parent flips running back on. Stop is fresh — not stuck
    // in "Stopping…" state from the previous click.
    act(() => {
      root.render(<Harness running />);
    });
    const btn4 = getButton();
    expect(btn4.textContent).toContain('Stop');
    expect(btn4.disabled).toBe(false);
  });
});

// Cluster E Phase 1 — slash-command palette wiring:
//   - `/` key with empty textarea + cursor 0 opens the palette
//   - `/` key with non-empty textarea does NOT open the palette
//   - `/` key when cursor is past position 0 does NOT open the palette
//     (the operator typed something else first then a slash mid-text)
//   - `Cmd+K` (and `Ctrl+K`) opens the palette regardless of text/cursor
//   - On open, the `/` keypress itself is preventDefaulted so the
//     textarea stays empty
//   - Selecting from the palette replaces the textarea with `<cmd> ` and
//     closes the palette
//   - Esc while palette is open closes the palette (and does NOT fire
//     onStop even when isRunning — palette has Esc precedence)

describe('InputBox — slash command palette (E1)', () => {
  function pressKeyOnTextarea(ta: HTMLTextAreaElement, init: KeyboardEventInit) {
    // Use the wrap's keydown listener — events bubble from the textarea.
    ta.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
  }

  test('`/` with empty textarea at cursor 0 opens the palette', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const ta = getTextarea();
    // Empty + cursor 0 are the defaults; just dispatch the keypress.
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: '/' });
    });
    expect(document.querySelector('.slash-palette')).not.toBeNull();
  });

  test('`/` is NOT opened when textarea has content', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const ta = getTextarea();
    // Type into the textarea first.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(ta, 'already typed');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: '/' });
    });
    expect(document.querySelector('.slash-palette')).toBeNull();
  });

  test('Cmd+K opens the palette regardless of text/cursor', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const ta = getTextarea();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(ta, 'some text');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: 'k', metaKey: true });
    });
    expect(document.querySelector('.slash-palette')).not.toBeNull();
  });

  test('Ctrl+K (Linux/Win path) also opens the palette', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const ta = getTextarea();
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: 'k', ctrlKey: true });
    });
    expect(document.querySelector('.slash-palette')).not.toBeNull();
  });

  test('selecting from palette replaces textarea with `<cmd> ` and closes', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    const ta = getTextarea();
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: '/' });
    });
    expect(document.querySelector('.slash-palette')).not.toBeNull();
    // Click the /compact row.
    const compactRow = Array.from(
      document.querySelectorAll<HTMLLIElement>('.slash-palette-row'),
    ).find((r) => r.querySelector('code')?.textContent === '/compact');
    expect(compactRow).toBeDefined();
    act(() => {
      compactRow!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('.slash-palette')).toBeNull();
    expect(getTextarea().value).toBe('/compact ');
  });

  test('Esc closes the palette and does not fire onStop while running', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={onStop} />);
    });
    const ta = getTextarea();
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: 'k', metaKey: true });
    });
    expect(document.querySelector('.slash-palette')).not.toBeNull();
    // Esc dispatched on the palette's input — the palette owns it.
    const input = document.querySelector('.slash-palette-input') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.slash-palette')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  test('sdkSlashCommands prop surfaces the Discovered from session group', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} sdkSlashCommands={['/ide', '/init']} />);
    });
    const ta = getTextarea();
    act(() => {
      ta.focus();
      pressKeyOnTextarea(ta, { key: 'k', metaKey: true });
    });
    const sectionTitles = Array.from(
      document.querySelectorAll('.slash-palette-section-title'),
    ).map((e) => e.textContent);
    expect(sectionTitles).toContain('Discovered from session');
    const cmds = Array.from(document.querySelectorAll('.slash-palette-row code')).map(
      (e) => e.textContent,
    );
    expect(cmds).toContain('/ide');
    expect(cmds).toContain('/init');
  });
});
