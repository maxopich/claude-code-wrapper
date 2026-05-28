// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StoppedMarker } from './StoppedMarker';

/**
 * Cluster C Phase 2: StoppedMarker UI tests.
 *
 * Coverage:
 *   - marker line renders ts (HH:MM:SS) + ackLatencyMs format
 *   - prompt is hidden when reasonSubmitted is true
 *   - clicking a non-other reason fires onSubmit(code) with no text
 *   - clicking 'Other…' expands the inline text input (doesn't submit yet)
 *   - submitting Other with text fires onSubmit('other', text)
 *   - submitting Other empty is blocked (button disabled)
 *   - Skip fires onSkip + does NOT fire onSubmit
 *   - Enter key in Other input submits
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

function mount(reasonSubmitted = false) {
  const onSubmit = vi.fn();
  const onSkip = vi.fn();
  act(() => {
    root.render(
      <StoppedMarker
        ts={1_700_000_000_000}
        ackLatencyMs={42}
        reasonSubmitted={reasonSubmitted}
        onSubmit={onSubmit}
        onSkip={onSkip}
      />,
    );
  });
  return { onSubmit, onSkip };
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
  const match = buttons.find((b) => b.textContent?.includes(label));
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

describe('StoppedMarker — marker line', () => {
  test('renders "Stopped by you" with ack latency', () => {
    mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Stopped by you');
    expect(text).toContain('ack 42 ms');
  });

  test('formats ackLatencyMs >= 1000 as seconds', () => {
    act(() => {
      root.render(
        <StoppedMarker
          ts={Date.now()}
          ackLatencyMs={2500}
          reasonSubmitted={false}
          onSubmit={() => {}}
          onSkip={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain('ack 2.5 s');
  });

  test('hides prompt when reasonSubmitted=true (marker stays)', () => {
    mount(true);
    expect(container.textContent).toContain('Stopped by you');
    expect(container.querySelector('.stopped-marker-prompt')).toBeNull();
  });
});

describe('StoppedMarker — reason picker', () => {
  test('clicking a non-other reason fires onSubmit(code) with no text', () => {
    const { onSubmit, onSkip } = mount();
    act(() => {
      findButton('Runaway loop').click();
    });
    // The component calls onSubmit(code) with only one arg for non-other
    // codes — assert on the call shape rather than implicitly-undefined
    // second arg.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]).toEqual(['runaway_loop']);
    expect(onSkip).not.toHaveBeenCalled();
  });

  test('clicking "Other…" expands the inline text input without submitting', () => {
    const { onSubmit } = mount();
    expect(container.querySelector('.stopped-marker-other')).toBeNull();
    act(() => {
      findButton('Other').click();
    });
    expect(container.querySelector('.stopped-marker-other')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Submit on Other is disabled until text is non-empty', () => {
    mount();
    act(() => {
      findButton('Other').click();
    });
    const submit = findButton('Submit');
    expect(submit.disabled).toBe(true);

    const input = container.querySelector('.stopped-marker-other-input') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'too verbose');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(findButton('Submit').disabled).toBe(false);
  });

  test('Submit on Other ships onSubmit("other", text)', () => {
    const { onSubmit } = mount();
    act(() => {
      findButton('Other').click();
    });
    const input = container.querySelector('.stopped-marker-other-input') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'too verbose');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      findButton('Submit').click();
    });
    expect(onSubmit).toHaveBeenCalledWith('other', 'too verbose');
  });

  test('Enter key in Other input submits', () => {
    const { onSubmit } = mount();
    act(() => {
      findButton('Other').click();
    });
    const input = container.querySelector('.stopped-marker-other-input') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'enter to submit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith('other', 'enter to submit');
  });

  test('whitespace-only Other text does NOT submit', () => {
    const { onSubmit } = mount();
    act(() => {
      findButton('Other').click();
    });
    const input = container.querySelector('.stopped-marker-other-input') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      findButton('Submit').click();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Skip fires onSkip + does NOT fire onSubmit', () => {
    const { onSubmit, onSkip } = mount();
    act(() => {
      findButton('Skip').click();
    });
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
