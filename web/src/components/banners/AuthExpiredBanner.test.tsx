// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner } from './SessionBanner.js';
import {
  authExpiredBannerTitle,
  buildAuthExpiredBannerItem,
  type AuthExpiredBannerCallbacks,
} from './AuthExpiredBanner.js';
import type { AuthExpiredState } from '../../store.js';

// Cluster D Phase 6 (spec §6.4 / UI-D22): factory unit tests for the
// app-wide auth-expired danger-tier banner.
//
// Coverage:
//   1. title is the stable phrasing operators rely on muscle memory for
//   2. item shape: stable id, danger tier, lock glyph
//   3. body composition: count pluralization, relative-time "last seen"
//   4. detail surfaces the raw wrapper error message under <details>
//   5. action set: Dismiss only (no Re-authenticate in v1 — manual fix)
//   6. wires cleanly into <SessionBanner /> + click invokes dismiss

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mkCallbacks(over: Partial<AuthExpiredBannerCallbacks> = {}): AuthExpiredBannerCallbacks {
  return {
    onDismiss: vi.fn(),
    ...over,
  };
}

const NOW = 1_700_000_000_000;
const stableNow = () => NOW;

const baseState: AuthExpiredState = {
  firstSeenMs: NOW - 30_000,
  lastSeenMs: NOW - 10_000,
  count: 2,
  lastMessage: 'Error: OAuth token expired (please run `claude login`)',
};

describe('authExpiredBannerTitle', () => {
  test('stable phrasing', () => {
    expect(authExpiredBannerTitle()).toBe('Claude subscription credentials expired');
  });
});

describe('buildAuthExpiredBannerItem — shape', () => {
  test('stable id (single global slot); tier=danger; glyph=lock', () => {
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    // Stable id — same banner across re-renders and re-arrivals so
    // SessionBanner's focus-steal-once contract is honored per tab.
    expect(item.id).toBe('auth-expired');
    expect(item.tier).toBe('danger');
    expect(item.glyph).toBe('🔒');
    expect(item.title).toBe('Claude subscription credentials expired');
  });

  test('arrivedAt threads through for BannerStack tiebreaker', () => {
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
      arrivedAt: 42,
    });
    expect(item.arrivedAt).toBe(42);
  });

  test('actions = [Dismiss] only (no Re-authenticate primary in v1)', () => {
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.actions).toBeDefined();
    expect(item.actions!.length).toBe(1);
    expect(item.actions![0].label).toBe('Dismiss');
    expect(item.actions![0].variant).toBe('ghost');
  });

  test('detail surfaces raw wrapper message in <details>', () => {
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.detail).toBeDefined();
    expect(item.detailLabel).toBe('Last error message');
  });

  test('omits detail when wrapper message is empty', () => {
    const item = buildAuthExpiredBannerItem({
      state: { ...baseState, lastMessage: '' },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.detail).toBeNull();
  });
});

describe('buildAuthExpiredBannerItem — Re-authenticate action (Phase 6c)', () => {
  test('adds Re-authenticate primary action when onReauthenticate is supplied', () => {
    const onReauth = vi.fn();
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: { ...mkCallbacks(), onReauthenticate: onReauth },
      now: stableNow,
    });
    expect(item.actions).toBeDefined();
    expect(item.actions!.length).toBe(2);
    expect(item.actions![0].label).toBe('Re-authenticate');
    expect(item.actions![0].variant).toBe('primary');
    expect(item.actions![1].label).toBe('Dismiss');
    expect(item.actions![1].variant).toBe('ghost');
    // Click wiring
    item.actions![0].onClick?.();
    expect(onReauth).toHaveBeenCalledTimes(1);
  });

  test('reauthInFlight disables the Re-authenticate action with busy tooltip', () => {
    const item = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: { ...mkCallbacks(), onReauthenticate: vi.fn() },
      reauthInFlight: true,
      now: stableNow,
    });
    const reauth = item.actions![0];
    expect(reauth.disabled).toBe(true);
    expect(reauth.title).toContain('already in progress');
  });

  test('body copy points at the modal when Re-authenticate is available', () => {
    const itemWith = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: { ...mkCallbacks(), onReauthenticate: vi.fn() },
      now: stableNow,
    });
    const itemWithout = buildAuthExpiredBannerItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    // Both bodies are React elements — render and compare textContent
    // via a real Root mount.
    const c1 = document.createElement('div');
    document.body.appendChild(c1);
    const r1 = createRoot(c1);
    act(() => {
      r1.render(<>{itemWith.body}</>);
    });
    expect(c1.textContent).toContain('Click');
    expect(c1.textContent).toContain('Re-authenticate');
    expect(c1.textContent).toContain('streams into a modal');
    act(() => {
      r1.unmount();
    });
    c1.remove();

    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const r2 = createRoot(c2);
    act(() => {
      r2.render(<>{itemWithout.body}</>);
    });
    expect(c2.textContent).toContain('Run');
    expect(c2.textContent).toContain('in a terminal');
    act(() => {
      r2.unmount();
    });
    c2.remove();
  });
});

describe('buildAuthExpiredBannerItem — render integration', () => {
  function renderItem(args: Parameters<typeof buildAuthExpiredBannerItem>[0]) {
    const item = buildAuthExpiredBannerItem(args);
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
  }

  test('renders title + body + Dismiss button + raw error in details', () => {
    renderItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.querySelector('.session-banner-title')?.textContent).toBe(
      'Claude subscription credentials expired',
    );
    // Body mentions the file path
    expect(container.textContent).toContain('~/.claude/.credentials.json');
    // Body mentions the fix
    expect(container.textContent).toContain('claude login');
    // Single Dismiss button
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const dismissBtn = buttons.find((b) => b.textContent === 'Dismiss')!;
    expect(dismissBtn).toBeTruthy();
    // Detail summary toggle is present
    const summary = container.querySelector('details summary')?.textContent;
    expect(summary).toBe('Last error message');
    // The raw message renders inside the details
    const detailMsg = container.querySelector('.auth-expired-banner-detail-message')?.textContent;
    expect(detailMsg).toContain('OAuth token expired');
  });

  test('singular count → "a turn"; plural → "N turns"', () => {
    renderItem({
      state: { ...baseState, count: 1 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('a turn');

    act(() => {
      root.unmount();
      root = createRoot(container);
    });
    renderItem({
      state: { ...baseState, count: 3 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('3 turns');
  });

  test('relative-time formatter handles seconds / minutes / hours / days', () => {
    // 10 seconds ago
    renderItem({
      state: { ...baseState, lastSeenMs: NOW - 10_000 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('10s ago');

    act(() => {
      root.unmount();
      root = createRoot(container);
    });
    // 5 minutes ago
    renderItem({
      state: { ...baseState, lastSeenMs: NOW - 5 * 60 * 1000 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('5m ago');

    act(() => {
      root.unmount();
      root = createRoot(container);
    });
    // 3 hours ago
    renderItem({
      state: { ...baseState, lastSeenMs: NOW - 3 * 60 * 60 * 1000 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('3h ago');

    act(() => {
      root.unmount();
      root = createRoot(container);
    });
    // 2 days ago
    renderItem({
      state: { ...baseState, lastSeenMs: NOW - 2 * 24 * 60 * 60 * 1000 },
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('2d ago');
  });

  test('Dismiss click invokes onDismiss callback', () => {
    const onDismiss = vi.fn();
    renderItem({
      state: baseState,
      callbacks: mkCallbacks({ onDismiss }),
      now: stableNow,
    });
    const dismissBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Dismiss',
    )!;
    act(() => {
      dismissBtn.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('danger tier renders with is-danger class', () => {
    renderItem({
      state: baseState,
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    const rootEl = container.querySelector('.session-banner');
    expect(rootEl).toBeTruthy();
    expect(rootEl!.classList.contains('is-danger')).toBe(true);
  });
});
