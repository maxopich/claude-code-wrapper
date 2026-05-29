// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BusInstalledBadge, HIGHLIGHT_MS } from './BusInstalledBadge';

// Cluster G Phase 4 (D6/D11) BusInstalledBadge tests pin:
//
//   1. Mount predicate — undefined installedAt → no mount (the
//      structural anti-pattern guard from spec §4.4: a participant row
//      with no entry in `lastBusInstallAt` gets no badge).
//   2. Recent installedAt → renders the badge with text + glyph.
//   3. After HIGHLIGHT_MS elapses, the badge unmounts.
//   4. Already-stale installedAt at mount time → no mount.
//   5. installedAt change triggers a fresh 30s window.
//   6. a11y: role="status" + aria-live + decorative glyph hidden.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  // Anchor system time so installedAt math is deterministic.
  vi.setSystemTime(new Date('2026-05-29T18:00:00.000Z'));
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

describe('BusInstalledBadge — mount predicate', () => {
  test('undefined installedAt → renders nothing (anti-pattern guard)', () => {
    act(() => {
      root.render(<BusInstalledBadge installedAt={undefined} />);
    });
    expect(container.querySelector('.bus-installed-badge')).toBeNull();
  });

  test('fresh installedAt → renders the badge', () => {
    act(() => {
      root.render(<BusInstalledBadge installedAt={Date.now()} />);
    });
    const badge = container.querySelector('.bus-installed-badge');
    expect(badge).not.toBeNull();
    // Visible text the screen reader will speak.
    expect(badge?.textContent).toContain('installed');
    // Decorative glyph element is present.
    expect(container.querySelector('.bus-installed-badge-glyph')).not.toBeNull();
  });

  test('installedAt older than HIGHLIGHT_MS at mount → renders nothing', () => {
    const stale = Date.now() - HIGHLIGHT_MS - 5_000;
    act(() => {
      root.render(<BusInstalledBadge installedAt={stale} />);
    });
    expect(container.querySelector('.bus-installed-badge')).toBeNull();
  });
});

describe('BusInstalledBadge — 30s window', () => {
  test('badge unmounts after HIGHLIGHT_MS elapses', () => {
    const installedAt = Date.now();
    act(() => {
      root.render(<BusInstalledBadge installedAt={installedAt} />);
    });
    expect(container.querySelector('.bus-installed-badge')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS);
    });
    expect(container.querySelector('.bus-installed-badge')).toBeNull();
  });

  test('badge stays visible just before HIGHLIGHT_MS', () => {
    const installedAt = Date.now();
    act(() => {
      root.render(<BusInstalledBadge installedAt={installedAt} />);
    });
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS - 100);
    });
    expect(container.querySelector('.bus-installed-badge')).not.toBeNull();
  });

  test('installedAt change resets the 30s window', () => {
    const initialInstall = Date.now();
    act(() => {
      root.render(<BusInstalledBadge installedAt={initialInstall} />);
    });
    // Half-elapse the window.
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS / 2);
    });
    expect(container.querySelector('.bus-installed-badge')).not.toBeNull();
    // A fresh install (e.g. uninstall + reinstall mid-session) bumps
    // `lastBusInstallAt[projectId]`; the badge effect re-runs and the
    // window restarts.
    const reinstall = Date.now();
    act(() => {
      root.render(<BusInstalledBadge installedAt={reinstall} />);
    });
    // Originally we would have unmounted at the original 30s mark; with
    // the reset, advancing past that point should still keep the badge
    // visible because the window restarted.
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS / 2 + 1_000);
    });
    expect(container.querySelector('.bus-installed-badge')).not.toBeNull();
    // Past the full new window → unmount.
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS);
    });
    expect(container.querySelector('.bus-installed-badge')).toBeNull();
  });

  test('installedAt → undefined transition unmounts the badge', () => {
    act(() => {
      root.render(<BusInstalledBadge installedAt={Date.now()} />);
    });
    expect(container.querySelector('.bus-installed-badge')).not.toBeNull();
    act(() => {
      root.render(<BusInstalledBadge installedAt={undefined} />);
    });
    expect(container.querySelector('.bus-installed-badge')).toBeNull();
  });
});

describe('BusInstalledBadge — a11y', () => {
  test('role=status + aria-live=polite + glyph aria-hidden', () => {
    act(() => {
      root.render(<BusInstalledBadge installedAt={Date.now()} />);
    });
    const badge = container.querySelector('.bus-installed-badge');
    expect(badge?.getAttribute('role')).toBe('status');
    expect(badge?.getAttribute('aria-live')).toBe('polite');
    const glyph = container.querySelector('.bus-installed-badge-glyph');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.textContent).toBe('✓');
  });
});
