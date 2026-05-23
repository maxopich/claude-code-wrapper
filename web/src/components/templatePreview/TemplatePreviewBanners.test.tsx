// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BypassPermissionsBanner, CustomModeBanner } from './TemplatePreviewBanners';

// React 18+ requires this flag for `act` in non-RTL setups.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * PR-1 coverage. The banners are simple presentation, but their a11y
 * posture (alert vs status) carries the "first mount per session"
 * contract — that's the test that matters most. Uses raw createRoot +
 * act (no @testing-library) to match the existing PR-5 modal tests.
 */

describe('BypassPermissionsBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Clean sessionStorage so each test sees "first mount per session" honestly.
    try {
      sessionStorage.clear();
    } catch {
      /* private mode — the banner falls back to first-mount anyway */
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders with role="alert" on the first mount per session', () => {
    act(() => root.render(<BypassPermissionsBanner />));
    const el = container.querySelector('.tpl-banner');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('alert');
  });

  test('subsequent mounts in the same session use role="status"', () => {
    // First mount: alert.
    act(() => root.render(<BypassPermissionsBanner />));
    expect(container.querySelector('.tpl-banner')!.getAttribute('role')).toBe('alert');
    // Unmount + remount in the same session: should now be status.
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<BypassPermissionsBanner />));
    expect(container.querySelector('.tpl-banner')!.getAttribute('role')).toBe('status');
  });

  test('carries the warn class and the ⚠ glyph', () => {
    act(() => root.render(<BypassPermissionsBanner />));
    const el = container.querySelector('.tpl-banner');
    expect(el?.classList.contains('is-warn')).toBe(true);
    const glyph = container.querySelector('.tpl-banner-glyph');
    expect(glyph?.textContent).toBe('⚠');
    // The glyph is decorative; the textual title carries the same meaning.
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  test('body text names `bypassPermissions` so the user can grep for it later', () => {
    act(() => root.render(<BypassPermissionsBanner />));
    const body = container.querySelector('.tpl-banner-body');
    expect(body?.textContent).toMatch(/bypassPermissions/);
  });
});

describe('CustomModeBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders with role="status" and the info class', () => {
    act(() => root.render(<CustomModeBanner />));
    const el = container.querySelector('.tpl-banner');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('status');
    expect(el!.classList.contains('is-info')).toBe(true);
  });

  test('uses the ⓘ glyph (shape-coded, not just color)', () => {
    act(() => root.render(<CustomModeBanner />));
    expect(container.querySelector('.tpl-banner-glyph')?.textContent).toBe('ⓘ');
  });

  test('body explains the approximation', () => {
    act(() => root.render(<CustomModeBanner />));
    const body = container.querySelector('.tpl-banner-body');
    expect(body?.textContent).toMatch(/approximation/i);
  });
});
