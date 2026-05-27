// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { CountdownChip, formatRemaining } from './CountdownChip.js';

// Cluster D Phase 4c: the chip is small but its three behaviours
// (visible tick, onElapsed fire-once, pause freeze) are what the
// RateLimitBanner's auto-retry hangs off — assert each in isolation so
// the banner's tests can focus on composition.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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

function chipEl(): HTMLElement {
  const el = container.querySelector('[data-testid="countdown-chip"]');
  if (!el) throw new Error('countdown chip not in DOM');
  return el as HTMLElement;
}

describe('formatRemaining (pure)', () => {
  test('rounds UP so "0 ms left" still shows 0:00 (not negative)', () => {
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-500)).toBe('0:00');
    expect(formatRemaining(Number.NaN)).toBe('0:00');
  });

  test('ceils to the next second so 1ms left renders 0:01', () => {
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(999)).toBe('0:01');
    expect(formatRemaining(1000)).toBe('0:01');
    expect(formatRemaining(1001)).toBe('0:02');
  });

  test('M:SS up to and past 60 minutes (no H:MM:SS rollover by design)', () => {
    expect(formatRemaining(60_000)).toBe('1:00');
    expect(formatRemaining(125_000)).toBe('2:05');
    expect(formatRemaining(60 * 60_000)).toBe('60:00');
    // Five-hour cap: stays as M:SS (300:00) rather than rolling to
    // hours. See the JSDoc on formatRemaining for the rationale.
    expect(formatRemaining(5 * 60 * 60_000)).toBe('300:00');
  });
});

describe('<CountdownChip>', () => {
  test('renders initial remaining from (target - now) and label prefix', () => {
    const now = vi.fn(() => 1_700_000_000_000);
    act(() => {
      root.render(
        <CountdownChip
          targetMs={1_700_000_000_000 + 65_000}
          now={now}
          intervalMs={1000}
          label="in"
        />,
      );
    });
    // 1:05 left
    expect(chipEl().textContent).toContain('in 1:05');
  });

  test('ticks down once per intervalMs', () => {
    let n = 1_700_000_000_000;
    const now = vi.fn(() => n);
    act(() => {
      root.render(<CountdownChip targetMs={n + 10_000} now={now} intervalMs={1000} />);
    });
    expect(chipEl().textContent).toContain('0:10');
    n += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(chipEl().textContent).toContain('0:09');
    n += 3000;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(chipEl().textContent).toContain('0:06');
  });

  test('fires onElapsed exactly once when remaining hits 0, never on subsequent ticks', () => {
    let n = 1_700_000_000_000;
    const now = vi.fn(() => n);
    const onElapsed = vi.fn();
    act(() => {
      root.render(
        <CountdownChip targetMs={n + 2_000} now={now} intervalMs={1000} onElapsed={onElapsed} />,
      );
    });
    expect(onElapsed).not.toHaveBeenCalled();
    n += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onElapsed).not.toHaveBeenCalled();
    n += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    // Subsequent ticks at remaining=0 do NOT re-fire.
    n += 5000;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  test('fires onElapsed on mount if target is already in the past', () => {
    // The auto-retry callback should still fire even if the dispatcher
    // managed to mount the chip after the reset window had elapsed
    // (e.g. tab was backgrounded; setInterval was throttled).
    const now = vi.fn(() => 1_700_000_000_000);
    const onElapsed = vi.fn();
    act(() => {
      root.render(
        <CountdownChip
          targetMs={1_700_000_000_000 - 5_000}
          now={now}
          intervalMs={1000}
          onElapsed={onElapsed}
        />,
      );
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(chipEl().textContent).toContain('0:00');
  });

  test('paused=true freezes the display AND blocks onElapsed', () => {
    let n = 1_700_000_000_000;
    const now = vi.fn(() => n);
    const onElapsed = vi.fn();
    act(() => {
      root.render(
        <CountdownChip
          targetMs={n + 3_000}
          now={now}
          intervalMs={1000}
          paused
          onElapsed={onElapsed}
        />,
      );
    });
    expect(chipEl().textContent).toContain('0:03');
    // Advance past the target — paused chip must NOT fire.
    n += 10_000;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onElapsed).not.toHaveBeenCalled();
    expect(chipEl().textContent).toContain('paused');

    // Unpause → chip catches up and fires immediately (target is now
    // in the past relative to current now).
    act(() => {
      root.render(
        <CountdownChip
          targetMs={n - 7_000}
          now={now}
          intervalMs={1000}
          paused={false}
          onElapsed={onElapsed}
        />,
      );
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  test('re-arms when targetMs changes (rate-limit refresh mid-flight)', () => {
    let n = 1_700_000_000_000;
    const now = vi.fn(() => n);
    const onElapsed = vi.fn();
    act(() => {
      root.render(
        <CountdownChip targetMs={n + 2_000} now={now} intervalMs={1000} onElapsed={onElapsed} />,
      );
    });
    n += 2000;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);

    // Operator gets a fresh hard rate_limit_event with a later reset
    // → re-arm the chip.
    act(() => {
      root.render(
        <CountdownChip targetMs={n + 5_000} now={now} intervalMs={1000} onElapsed={onElapsed} />,
      );
    });
    expect(chipEl().textContent).toContain('0:05');
    n += 5000;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(2);
  });

  test('error in onElapsed does not crash the chip (logged + swallowed)', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 1_700_000_000_000;
    const now = vi.fn(() => n);
    const onElapsed = vi.fn(() => {
      throw new Error('boom');
    });
    act(() => {
      root.render(
        <CountdownChip targetMs={n + 1_000} now={now} intervalMs={1000} onElapsed={onElapsed} />,
      );
    });
    n += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalled();
    // Chip is still in the DOM after the throw.
    expect(chipEl()).toBeTruthy();
    consoleErr.mockRestore();
  });

  test('aria-live mirror restates the time grammatically for screen readers', () => {
    const now = vi.fn(() => 1_700_000_000_000);
    act(() => {
      root.render(
        <CountdownChip
          targetMs={1_700_000_000_000 + 30_000}
          now={now}
          intervalMs={1000}
          label="resets in"
        />,
      );
    });
    const sr = chipEl().querySelector('[aria-live="polite"]');
    expect(sr).not.toBeNull();
    expect(sr!.textContent).toBe('resets in 0:30');
  });
});
