// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { RouterDropView } from '../../store';
import { RouterDropsCounter } from './RouterDropsCounter';

// Cluster B Phase 6d — UI-B24/B28: RouterDropsCounter contract.
//
// Tests:
//   - UI-B24: zero drops → chip hidden (returns null)
//   - 4-regime calibration:
//       - 1 drop  → occasional (warn tint)
//       - 5 drops → persistent (heavier warn)
//       - 10 drops total → burst (err palette)
//       - 5 drops in last 30s → burst (recency)
//   - click opens RouterDropsModal
//   - tooltip + aria-label reflect regime + count
//   - rolling regime re-classifies as drops age out of burst window

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
  vi.useRealTimers();
});

function mkDrop(over: Partial<RouterDropView> = {}): RouterDropView {
  return {
    auditRowId: `a-${Math.random().toString(36).slice(2, 10)}`,
    reasonCode: 'forged_source',
    source: 'workerA',
    destination: 'orchestrator',
    kind: 'reply',
    receivedAt: Date.now(),
    ...over,
  };
}

describe('RouterDropsCounter — visibility', () => {
  test('renders nothing when drops is empty', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[]} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip')).toBeNull();
  });

  test('renders the chip with a count when ≥ 1 drop', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop()]} sessionId="s1" />);
    });
    const chip = container.querySelector('.ma-router-drops-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('1 drop');
  });

  test('pluralizes count correctly', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop(), mkDrop()]} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip')?.textContent).toContain('2 drops');
  });
});

describe('RouterDropsCounter — 4-regime calibration', () => {
  test('1 drop → occasional class', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop()]} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip-occasional')).not.toBeNull();
  });

  test('4 drops (total ≥ 4, no burst window) → persistent class', () => {
    // Spread drops over hours so no 5-in-30s burst window triggers.
    const old = Date.now() - 10 * 60_000;
    const drops = Array.from({ length: 4 }, () => mkDrop({ receivedAt: old }));
    act(() => {
      root.render(<RouterDropsCounter drops={drops} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip-persistent')).not.toBeNull();
  });

  test('10 drops total → burst class', () => {
    // Spread so the BURST_TOTAL threshold (10) trips, not the recency one.
    const old = Date.now() - 10 * 60_000;
    const drops = Array.from({ length: 10 }, () => mkDrop({ receivedAt: old }));
    act(() => {
      root.render(<RouterDropsCounter drops={drops} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip-burst')).not.toBeNull();
  });

  test('5 drops in last 30s → burst (recency trips before total)', () => {
    const now = Date.now();
    // 5 fresh drops, total < BURST_TOTAL — only the recency window triggers.
    const drops = Array.from({ length: 5 }, () => mkDrop({ receivedAt: now - 1000 }));
    act(() => {
      root.render(<RouterDropsCounter drops={drops} sessionId="s1" />);
    });
    expect(container.querySelector('.ma-router-drops-chip-burst')).not.toBeNull();
  });

  test('aria-label includes count and regime', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop()]} sessionId="s1" />);
    });
    const chip = container.querySelector('.ma-router-drops-chip')!;
    const label = chip.getAttribute('aria-label') ?? '';
    expect(label).toContain('1');
    expect(label).toContain('occasional');
  });
});

describe('RouterDropsCounter — click opens modal', () => {
  test('click opens RouterDropsModal containing the log', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop()]} sessionId="s1" />);
    });
    const chip = container.querySelector('.ma-router-drops-chip') as HTMLButtonElement;
    act(() => {
      chip.click();
    });
    expect(document.querySelector('.router-drops-modal')).not.toBeNull();
    // Log component renders the row.
    expect(document.querySelector('.router-drops-row')).not.toBeNull();
  });

  test('modal Close button dismisses the modal', () => {
    act(() => {
      root.render(<RouterDropsCounter drops={[mkDrop()]} sessionId="s1" />);
    });
    const chip = container.querySelector('.ma-router-drops-chip') as HTMLButtonElement;
    act(() => {
      chip.click();
    });
    const closeBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.router-drops-modal button'),
    ).find((b) => b.textContent === 'Close');
    expect(closeBtn).toBeDefined();
    act(() => {
      closeBtn!.click();
    });
    expect(document.querySelector('.router-drops-modal')).toBeNull();
  });
});
