// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner } from './SessionBanner.js';
import {
  buildSweptSessionBannerItem,
  sweptSessionBannerTitle,
  type SweptSessionBannerCallbacks,
} from './SweptSessionBanner.js';

// Cluster D Phase 5e (spec §6.3 / UI-D17): factory unit tests for the
// swept-session danger-tier banner.
//
// Coverage:
//   1. title is the stable phrasing operators rely on muscle memory for
//   2. item shape: id derived from sessionId, danger tier, glyph
//   3. action set wiring: Reopen primary, Archive ghost, callbacks
//      invoke with correct identity
//   4. reopenInFlight disables Reopen with a different tooltip
//   5. body copy includes the short session id (operator's reference)
//   6. factory wires cleanly into a real <SessionBanner /> mount

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Reset focus-steal-once state between tests so each render exercises
  // a fresh banner-id key in sessionStorage.
  sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mkCallbacks(over: Partial<SweptSessionBannerCallbacks> = {}): SweptSessionBannerCallbacks {
  return {
    onReopen: vi.fn(),
    onArchive: vi.fn(),
    ...over,
  };
}

describe('sweptSessionBannerTitle', () => {
  test('stable phrasing', () => {
    expect(sweptSessionBannerTitle()).toBe('This iteration has been swept');
  });
});

describe('buildSweptSessionBannerItem — shape', () => {
  test('id derives from sessionId; tier=danger; glyph=warning', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-abc12345',
      callbacks: mkCallbacks(),
    });
    expect(item.id).toBe('swept-session-sess-abc12345');
    expect(item.tier).toBe('danger');
    expect(item.glyph).toBe('⚠');
    expect(item.title).toBe('This iteration has been swept');
  });

  test('arrivedAt threads through for BannerStack tiebreaker', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
      arrivedAt: 1_700_000_000_000,
    });
    expect(item.arrivedAt).toBe(1_700_000_000_000);
  });

  test('returns Reopen + Archive actions in order; primary then ghost', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
    });
    expect(item.actions).toBeDefined();
    expect(item.actions!.length).toBe(2);
    expect(item.actions![0].label).toBe('Reopen this iteration');
    expect(item.actions![0].variant).toBe('primary');
    expect(item.actions![1].label).toBe('Archive');
    expect(item.actions![1].variant).toBe('ghost');
  });
});

describe('buildSweptSessionBannerItem — reopenInFlight', () => {
  test('reopenInFlight=true disables Reopen action with the busy tooltip', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
      reopenInFlight: true,
    });
    const reopen = item.actions![0];
    expect(reopen.disabled).toBe(true);
    expect(reopen.title).toContain('already in progress');
  });

  test('reopenInFlight=false (default) leaves Reopen enabled with the action tooltip', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
    });
    const reopen = item.actions![0];
    expect(reopen.disabled).toBeFalsy();
    expect(reopen.title).toContain('Reviews the workspace diff');
  });

  test('Archive is never disabled by reopenInFlight (independent action)', () => {
    const item = buildSweptSessionBannerItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
      reopenInFlight: true,
    });
    const archive = item.actions![1];
    expect(archive.disabled).toBeFalsy();
  });
});

describe('buildSweptSessionBannerItem — render integration', () => {
  function renderItem(args: Parameters<typeof buildSweptSessionBannerItem>[0]) {
    const item = buildSweptSessionBannerItem(args);
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
  }

  test('renders title + short sessionId in body + both action buttons', () => {
    renderItem({
      sessionId: 'abcdef1234567890',
      callbacks: mkCallbacks(),
    });
    // Title visible
    expect(container.querySelector('.session-banner-title')?.textContent).toBe(
      'This iteration has been swept',
    );
    // Short id (first 8 chars) embedded in body
    expect(container.textContent).toContain('abcdef12');
    // Two buttons
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const labels = buttons.map((b) => b.textContent ?? '');
    expect(labels).toContain('Reopen this iteration');
    expect(labels).toContain('Archive');
  });

  test('Reopen click invokes onReopen callback', () => {
    const onReopen = vi.fn();
    renderItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks({ onReopen }),
    });
    const reopen = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Reopen this iteration',
    )!;
    act(() => {
      reopen.click();
    });
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  test('Archive click invokes onArchive callback', () => {
    const onArchive = vi.fn();
    renderItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks({ onArchive }),
    });
    const archive = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Archive',
    )!;
    act(() => {
      archive.click();
    });
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  test('reopenInFlight renders Reopen as disabled DOM button', () => {
    renderItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
      reopenInFlight: true,
    });
    const reopen = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Reopen this iteration',
    )!;
    expect(reopen.disabled).toBe(true);
  });

  test('danger tier renders with is-danger class', () => {
    renderItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
    });
    const root = container.querySelector('.session-banner');
    expect(root).toBeTruthy();
    expect(root!.classList.contains('is-danger')).toBe(true);
  });

  test('danger tier steals focus once per banner-id', () => {
    renderItem({
      sessionId: 'sess-1',
      callbacks: mkCallbacks(),
    });
    // Defer one tick (the focus is scheduled via setTimeout(0) in
    // SessionBanner so VoiceOver sees the live region first).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const reopen = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
          (b) => b.textContent === 'Reopen this iteration',
        )!;
        expect(document.activeElement).toBe(reopen);
        resolve();
      }, 10);
    });
  });
});
