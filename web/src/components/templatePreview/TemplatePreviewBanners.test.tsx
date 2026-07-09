// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  BypassPermissionsBanner,
  ConsultantModeBanner,
  CustomModeBanner,
  CustomModeNotice,
} from './TemplatePreviewBanners';

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

describe('CustomModeNotice (PR-2)', () => {
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

  test('renders prose under the .tpl-preview-note class', () => {
    act(() => root.render(<CustomModeNotice />));
    const el = container.querySelector('.tpl-preview-note');
    expect(el).not.toBeNull();
    // No role attribute: the sibling banner already owns the announcement,
    // and a second role would compete with it in the accessibility tree.
    expect(el!.getAttribute('role')).toBeNull();
  });

  test('names the protocol token `custom` in a <code> swatch', () => {
    act(() => root.render(<CustomModeNotice />));
    const code = container.querySelector('.tpl-preview-note code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('custom');
  });

  test('states the orchestrator-routing fallback in plain prose', () => {
    act(() => root.render(<CustomModeNotice />));
    const el = container.querySelector('.tpl-preview-note');
    expect(el?.textContent).toMatch(/orchestrator routing/i);
  });
});

// Cluster F Phase D5 (UI-D5): the new always-on consultant-mode banner for
// orchestrator-mode bus sessions. Mode-gating itself lives at the call site
// (DraftView / TemplatePreviewModal / MultiAgentActivityBar) — these tests
// only assert the banner's intrinsic shape + copy.
describe('ConsultantModeBanner', () => {
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

  test('renders with role="status" and the info class (matches CustomModeBanner posture)', () => {
    act(() => root.render(<ConsultantModeBanner />));
    const el = container.querySelector('.tpl-banner');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('status');
    expect(el!.classList.contains('is-info')).toBe(true);
  });

  test('uses the ⓘ glyph (shape-coded, decorative)', () => {
    act(() => root.render(<ConsultantModeBanner />));
    const glyph = container.querySelector('.tpl-banner-glyph');
    expect(glyph?.textContent).toBe('ⓘ');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  test('title is "Consultant mode"', () => {
    act(() => root.render(<ConsultantModeBanner />));
    const title = container.querySelector('.tpl-banner-title');
    expect(title?.textContent).toBe('Consultant mode');
  });

  test('body explains the read/analyze/advise rule + the advisory caveat', () => {
    act(() => root.render(<ConsultantModeBanner />));
    const body = container.querySelector('.tpl-banner-body');
    expect(body?.textContent).toMatch(/read, analyze, advise/i);
    // Names the carve-out so the operator knows what would unlock mutations.
    expect(body?.textContent).toMatch(/unless your prompt explicitly directs/i);
    // Honesty: the constraint is advisory, not enforced server-side.
    expect(body?.textContent).toMatch(/advisory/i);
    // The opposite verbs are surfaced so the operator can grep for them.
    expect(body?.textContent).toMatch(/modify, create, or delete/i);
  });

  test('id is stable so multiple mounts dedupe in BannerStack', () => {
    act(() => root.render(<ConsultantModeBanner />));
    const el = container.querySelector('.tpl-banner');
    // Existing banner stack pattern uses the id for de-duplication; the
    // SessionBanner wrapper attaches it on the root. This pins the value.
    expect(el?.id).toBe('consultant-mode-banner');
  });

  test('executeMode variant retitles to "Execute mode" and states the own-folder rule', () => {
    act(() => root.render(<ConsultantModeBanner executeMode />));
    expect(container.querySelector('.tpl-banner-title')?.textContent).toBe('Execute mode');
    const body = container.querySelector('.tpl-banner-body');
    expect(body?.textContent).toMatch(/within its own project folder/i);
    expect(body?.textContent).toMatch(/advisory/i);
    // Same stable id so the banner stack still dedupes across a mode flip.
    expect(container.querySelector('.tpl-banner')?.id).toBe('consultant-mode-banner');
  });
});
