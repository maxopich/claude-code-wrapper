// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MultiAgentEventKind } from '@cebab/shared/protocol';
import {
  MultiAgentScrollbackFilter,
  SCROLLBACK_FILTER_KINDS,
  countByKind,
} from './MultiAgentScrollbackFilter';

// Cluster H D8 — pins the scrollback filter's structure + interaction
// contract:
//
//   1. Renders one chip per MultiAgentEventKind in canonical order.
//   2. countByKind() is a stable O(n) aggregator over events.
//   3. Chips reflect the *hidden* set as opposite-pressed: empty hidden →
//      every chip is is-visible / aria-pressed=true.
//   4. Toggling a chip calls onToggle with its kind.
//   5. The Clear button only renders when hiddenKinds is non-empty.

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

type Harness = {
  toggled: MultiAgentEventKind[];
  resets: number;
};

function renderFilter(
  hiddenKinds: ReadonlySet<MultiAgentEventKind> = new Set(),
  counts: ReadonlyMap<MultiAgentEventKind, number> = new Map(),
): Harness {
  const harness: Harness = { toggled: [], resets: 0 };
  act(() => {
    root.render(
      <MultiAgentScrollbackFilter
        hiddenKinds={hiddenKinds}
        counts={counts}
        onToggle={(k) => harness.toggled.push(k)}
        onReset={() => {
          harness.resets += 1;
        }}
      />,
    );
  });
  return harness;
}

function chips(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.ma-scrollback-filter-chip'));
}

function clearBtn(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.ma-scrollback-filter-clear');
}

describe('countByKind — aggregator', () => {
  test('returns zero for every kind on empty input', () => {
    const counts = countByKind([]);
    for (const k of SCROLLBACK_FILTER_KINDS) {
      expect(counts.get(k)).toBe(0);
    }
  });

  test('tallies one bucket per kind in O(n)', () => {
    const counts = countByKind([
      { kind: 'intro' },
      { kind: 'prompt' },
      { kind: 'prompt' },
      { kind: 'reply' },
      { kind: 'final' },
      { kind: 'error' },
      { kind: 'error' },
      { kind: 'error' },
    ]);
    expect(counts.get('intro')).toBe(1);
    expect(counts.get('prompt')).toBe(2);
    expect(counts.get('reply')).toBe(1);
    expect(counts.get('final')).toBe(1);
    expect(counts.get('error')).toBe(3);
  });
});

describe('MultiAgentScrollbackFilter — structure', () => {
  test('renders one chip per kind in canonical order', () => {
    renderFilter();
    const buttons = chips();
    expect(buttons).toHaveLength(SCROLLBACK_FILTER_KINDS.length);
    // First kind label appears in the first chip, last in the last chip.
    expect(buttons[0]?.textContent ?? '').toContain(SCROLLBACK_FILTER_KINDS[0]);
    expect(buttons[buttons.length - 1]?.textContent ?? '').toContain(
      SCROLLBACK_FILTER_KINDS[SCROLLBACK_FILTER_KINDS.length - 1],
    );
  });

  test('displays counts next to each label', () => {
    renderFilter(
      new Set(),
      new Map<MultiAgentEventKind, number>([
        ['intro', 1],
        ['prompt', 2],
        ['reply', 3],
        ['final', 4],
        ['error', 5],
      ]),
    );
    const counts = Array.from(container.querySelectorAll('.ma-scrollback-filter-count')).map(
      (el) => el.textContent,
    );
    expect(counts).toEqual(['1', '2', '3', '4', '5']);
  });

  test('missing counts in the map render as 0', () => {
    renderFilter(new Set(), new Map<MultiAgentEventKind, number>([['error', 2]]));
    const counts = Array.from(container.querySelectorAll('.ma-scrollback-filter-count')).map(
      (el) => el.textContent,
    );
    // Only 'error' set; the other four read 0 (default).
    expect(counts).toEqual(['0', '0', '0', '0', '2']);
  });
});

describe('MultiAgentScrollbackFilter — visibility state', () => {
  test('empty hidden set: every chip is is-visible / aria-pressed=true', () => {
    renderFilter(new Set());
    const buttons = chips();
    for (const btn of buttons) {
      expect(btn.classList.contains('is-visible')).toBe(true);
      expect(btn.classList.contains('is-hidden')).toBe(false);
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    }
  });

  test('hidden set: matched chips are is-hidden / aria-pressed=false', () => {
    renderFilter(new Set<MultiAgentEventKind>(['intro', 'prompt']));
    const buttons = chips();
    // First two (intro, prompt) hidden; rest visible.
    expect(buttons[0]?.classList.contains('is-hidden')).toBe(true);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1]?.classList.contains('is-hidden')).toBe(true);
    expect(buttons[2]?.classList.contains('is-visible')).toBe(true);
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('MultiAgentScrollbackFilter — interactions', () => {
  test('clicking a chip calls onToggle with that kind', () => {
    const h = renderFilter();
    const buttons = chips();
    act(() => {
      buttons[3]!.click(); // 'final'
    });
    expect(h.toggled).toEqual(['final']);
  });

  test('clicking multiple chips records each in order', () => {
    const h = renderFilter();
    const buttons = chips();
    act(() => {
      buttons[0]!.click();
      buttons[4]!.click();
    });
    expect(h.toggled).toEqual(['intro', 'error']);
  });

  test('Clear button only renders when hiddenKinds is non-empty', () => {
    renderFilter(new Set());
    expect(clearBtn()).toBeNull();
  });

  test('Clear button fires onReset', () => {
    const h = renderFilter(new Set<MultiAgentEventKind>(['intro']));
    const btn = clearBtn();
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(h.resets).toBe(1);
  });
});
