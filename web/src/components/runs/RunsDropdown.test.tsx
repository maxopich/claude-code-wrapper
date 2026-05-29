// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActiveRunView } from '../../store';
import { formatElapsed, RUNS_DROPDOWN_VISIBLE_CAP, RunsDropdown } from './RunsDropdown';

// Cluster G Phase 3b (G1 UI): RunsDropdown pins the wire-shape → row
// rendering contract. The dropdown is dumb (no state, no fetching) so
// the tests focus on:
//
//   1. Project-name fallback ladder (name → "project N" → "(no project)").
//   2. Per-row click hands the full ActiveRunView to onJump AND calls
//      onRequestClose — the dropdown owns close behaviour on row select.
//   3. Cap at RUNS_DROPDOWN_VISIBLE_CAP rows + overflow line shape.
//   4. Defensive empty-state when runs=[].
//   5. Live-ticking elapsed advances from startedAt (1Hz interval).
//   6. formatElapsed contract pinned for the wire-shape boundary.

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

function renderDropdown(props: Parameters<typeof RunsDropdown>[0]) {
  act(() => {
    root.render(<RunsDropdown {...props} />);
  });
}

const baseRun = (overrides: Partial<ActiveRunView> = {}): ActiveRunView => ({
  sessionId: 's-default',
  projectId: 1,
  projectName: 'reviewer',
  kind: 'single',
  startedAt: 1_700_000_000_000,
  elapsedMs: 5_000,
  ...overrides,
});

describe('RunsDropdown / empty state', () => {
  test('runs=[] renders an empty-state copy (defensive — host normally unmounts at 0)', () => {
    renderDropdown({ runs: [], onJump: vi.fn(), onRequestClose: vi.fn() });
    expect(container.textContent).toContain('No runs in flight right now.');
    expect(container.querySelectorAll('.runs-dropdown-row').length).toBe(0);
  });
});

describe('RunsDropdown / project-name fallback ladder', () => {
  test('projectName present → renders the cached name', () => {
    renderDropdown({
      runs: [baseRun({ sessionId: 's-a', projectName: 'reviewer' })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-project')?.textContent).toBe('reviewer');
  });

  test('projectName absent, projectId present → "project N"', () => {
    renderDropdown({
      runs: [baseRun({ projectName: undefined, projectId: 7 })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-project')?.textContent).toBe('project 7');
  });

  test('both absent → "(no project)" sentinel', () => {
    renderDropdown({
      runs: [
        {
          sessionId: 's-orphan',
          kind: 'single',
          startedAt: 1_700_000_000_000,
          elapsedMs: 0,
        },
      ],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-project')?.textContent).toBe('(no project)');
  });
});

describe('RunsDropdown / activeAgentName suffix', () => {
  test('absent (single-agent or between hops) → no agent line', () => {
    renderDropdown({ runs: [baseRun()], onJump: vi.fn(), onRequestClose: vi.fn() });
    expect(container.querySelector('.runs-dropdown-row-agent')).toBeNull();
  });

  test('present → mono-font agent suffix below project name', () => {
    renderDropdown({
      runs: [baseRun({ kind: 'bus-worker', activeAgentName: 'planner-1' })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-agent')?.textContent).toBe('planner-1');
  });
});

describe('RunsDropdown / kind chip', () => {
  test('single → "● single" inside .run-status .run-status-running pill', () => {
    renderDropdown({
      runs: [baseRun({ kind: 'single' })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    const chip = container.querySelector('.runs-dropdown-row-kind');
    expect(chip?.className).toMatch(/\brun-status\b/);
    expect(chip?.className).toMatch(/\brun-status-running\b/);
    expect(chip?.textContent).toContain('●');
    expect(chip?.textContent).toContain('single');
  });

  test('bus-worker → "⇄ bus"', () => {
    renderDropdown({
      runs: [baseRun({ kind: 'bus-worker' })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    const chip = container.querySelector('.runs-dropdown-row-kind');
    expect(chip?.textContent).toContain('⇄');
    expect(chip?.textContent).toContain('bus');
  });

  test('orchestrator → "◆ orch" (reserved slot per protocol)', () => {
    renderDropdown({
      runs: [baseRun({ kind: 'orchestrator' })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    const chip = container.querySelector('.runs-dropdown-row-kind');
    expect(chip?.textContent).toContain('◆');
    expect(chip?.textContent).toContain('orch');
  });
});

describe('RunsDropdown / per-row click', () => {
  test('click → onJump receives the full ActiveRunView AND onRequestClose fires', () => {
    const onJump = vi.fn();
    const onRequestClose = vi.fn();
    const run = baseRun({ sessionId: 's-clicked', projectName: 'planner' });
    renderDropdown({ runs: [run], onJump, onRequestClose });
    const btn = container.querySelector<HTMLButtonElement>('.runs-dropdown-row-btn');
    expect(btn).not.toBeNull();
    act(() => {
      btn?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(run);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});

describe('RunsDropdown / cap + overflow', () => {
  test('count ≤ CAP → no overflow line', () => {
    const runs = Array.from({ length: RUNS_DROPDOWN_VISIBLE_CAP }, (_, i) =>
      baseRun({ sessionId: `s-${i}` }),
    );
    renderDropdown({ runs, onJump: vi.fn(), onRequestClose: vi.fn() });
    expect(container.querySelectorAll('.runs-dropdown-row').length).toBe(RUNS_DROPDOWN_VISIBLE_CAP);
    expect(container.querySelector('.runs-dropdown-overflow')).toBeNull();
  });

  test('count > CAP → renders CAP rows + "+N more" footer (R-G3 cap)', () => {
    const runs = Array.from({ length: RUNS_DROPDOWN_VISIBLE_CAP + 3 }, (_, i) =>
      baseRun({ sessionId: `s-${i}` }),
    );
    renderDropdown({ runs, onJump: vi.fn(), onRequestClose: vi.fn() });
    expect(container.querySelectorAll('.runs-dropdown-row').length).toBe(RUNS_DROPDOWN_VISIBLE_CAP);
    expect(container.querySelector('.runs-dropdown-overflow')?.textContent).toBe('+3 more');
  });
});

describe('RunsDropdown / live elapsed ticker', () => {
  test('elapsed advances 1s/s from startedAt (server elapsedMs becomes the anchor)', () => {
    // Pin Date.now() to a known instant via fake timers. `advanceTimersByTime`
    // moves both the fake clock and triggers due intervals, so a 3s advance
    // from t=100s with startedAt t=98s lands the ticker at 5s.
    vi.setSystemTime(1_700_000_100_000);
    renderDropdown({
      runs: [baseRun({ startedAt: 1_700_000_098_000 })],
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-elapsed')?.textContent).toBe('2s');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('.runs-dropdown-row-elapsed')?.textContent).toBe('5s');
  });

  test('startedAt > now (NTP slew) → elapsed floors at 0 instead of going negative', () => {
    vi.setSystemTime(1_700_000_100_000);
    renderDropdown({
      runs: [baseRun({ startedAt: 1_700_000_101_500 })], // 1.5s in the FUTURE
      onJump: vi.fn(),
      onRequestClose: vi.fn(),
    });
    expect(container.querySelector('.runs-dropdown-row-elapsed')?.textContent).toBe('0s');
  });
});

describe('formatElapsed / wire-shape boundary', () => {
  test('< 1m → "Ns"', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1_500)).toBe('1s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  test('1m..1h → "MmSSs" (zero-padded seconds)', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(61_000)).toBe('1m01s');
    expect(formatElapsed(3_599_000)).toBe('59m59s');
  });

  test('≥ 1h → "HhMMm" (zero-padded minutes)', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m');
    expect(formatElapsed(7_500_000)).toBe('2h05m');
    expect(formatElapsed(86_400_000)).toBe('24h00m');
  });
});
