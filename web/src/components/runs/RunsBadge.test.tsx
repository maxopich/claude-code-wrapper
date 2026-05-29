// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActiveRunView } from '../../store';
import { RunsBadge } from './RunsBadge';

// Cluster G Phase 3b (G1 UI): RunsBadge owns the mount predicate + the
// popover toggle wiring. The tests pin:
//
//   1. Hidden when runs=[] (G1-1: zero-count is silent, never a "0 active"
//      chip).
//   2. Label arithmetic: 1 → "1 active", N → "N active".
//   3. Toggle on click; ARIA wiring (`aria-expanded`, `aria-haspopup`).
//   4. Esc closes (only while open — global Esc not swallowed when closed).
//   5. Outside click closes.
//   6. Auto-close when runs drops to 0 while open.

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
  act(() => {
    root.unmount();
  });
  container.remove();
  // Reset timers leaked from individual cases.
  vi.useRealTimers();
});

function render(props: Parameters<typeof RunsBadge>[0]) {
  act(() => {
    root.render(<RunsBadge {...props} />);
  });
}

const run = (overrides: Partial<ActiveRunView> = {}): ActiveRunView => ({
  sessionId: 's-default',
  projectId: 1,
  projectName: 'reviewer',
  kind: 'single',
  startedAt: 1_700_000_000_000,
  elapsedMs: 1_000,
  ...overrides,
});

describe('RunsBadge / mount predicate (G1-1)', () => {
  test('runs=[] → nothing rendered (no chip, no popover)', () => {
    render({ runs: [], onJump: vi.fn() });
    expect(container.querySelector('.runs-badge')).toBeNull();
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });

  test('runs.length === 1 → "1 active" (singular label)', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('▶');
    expect(btn?.textContent).toContain('1 active');
    expect(btn?.getAttribute('aria-label')).toBe('1 active run');
  });

  test('runs.length === 3 → "3 active" (plural label)', () => {
    render({
      runs: [run({ sessionId: 'a' }), run({ sessionId: 'b' }), run({ sessionId: 'c' })],
      onJump: vi.fn(),
    });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    expect(btn?.textContent).toContain('3 active');
    expect(btn?.getAttribute('aria-label')).toBe('3 active runs');
  });
});

describe('RunsBadge / ARIA + toggle', () => {
  test('initial: aria-expanded=false, popover absent', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    expect(btn?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });

  test('click → aria-expanded=true, popover mounted', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    expect(btn?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.runs-dropdown-popover')).not.toBeNull();
  });

  test('click again → popover closes', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('.runs-dropdown-popover')).not.toBeNull();
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });
});

describe('RunsBadge / outside-click + Esc', () => {
  test('Esc while open → close + focus returns to badge', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('.runs-dropdown-popover')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  test('outside pointerdown closes (clicks on body, not on badge or popover)', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('.runs-dropdown-popover')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });

  test('Esc while closed → no-op (does not swallow global Esc)', () => {
    // Sentinel: nothing visible should change, but mostly this is asserting
    // the listener is unmounted while closed (no exception thrown).
    render({ runs: [run()], onJump: vi.fn() });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // Still closed; no popover ever showed.
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });
});

describe('RunsBadge / auto-close on count → 0', () => {
  test('open popover then runs becomes [] → both chip and popover unmount', () => {
    render({ runs: [run()], onJump: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('.runs-dropdown-popover')).not.toBeNull();
    render({ runs: [], onJump: vi.fn() });
    expect(container.querySelector('.runs-badge')).toBeNull();
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });
});

describe('RunsBadge / dropdown row click integration', () => {
  test('click row → onJump receives the row + popover closes', () => {
    const onJump = vi.fn();
    const target = run({ sessionId: 's-target', projectName: 'planner' });
    render({ runs: [target], onJump });
    const btn = container.querySelector<HTMLButtonElement>('.runs-badge');
    act(() => {
      btn?.click();
    });
    const rowBtn = container.querySelector<HTMLButtonElement>('.runs-dropdown-row-btn');
    act(() => {
      rowBtn?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(target);
    expect(container.querySelector('.runs-dropdown-popover')).toBeNull();
  });
});
