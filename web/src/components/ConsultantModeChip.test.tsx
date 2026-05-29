// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ConsultantModeChip } from './ConsultantModeChip';

// Cluster F Phase D5 (UI-D5): the at-a-glance reminder chip for
// orchestrator-mode bus sessions. Mode-gating itself lives at the call site
// (MultiAgentActivityBar's `run.mode === 'orchestrator'` guard) — these
// tests only assert the chip's intrinsic shape + a11y posture.
//
// Uses raw createRoot + act (no @testing-library) to match the project
// convention (HopBudgetInput.test.tsx, MaxTurnsInput.test.tsx).

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ConsultantModeChip', () => {
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

  test('renders under the .ma-consultant-chip class', () => {
    act(() => root.render(<ConsultantModeChip />));
    const el = container.querySelector('.ma-consultant-chip');
    expect(el).not.toBeNull();
    // The chip is a <span> — non-interactive by tag, no role override.
    expect(el!.tagName).toBe('SPAN');
  });

  test('shows the textual marker "Consultant" (no-color-only contract)', () => {
    act(() => root.render(<ConsultantModeChip />));
    const el = container.querySelector('.ma-consultant-chip');
    // The chip carries a textual label so reduced-motion / screen-reader /
    // colorblind operators perceive it even when the info palette is muted.
    expect(el?.textContent).toMatch(/Consultant/);
  });

  test('decorative ⓘ glyph is aria-hidden so screen readers do not double-announce', () => {
    act(() => root.render(<ConsultantModeChip />));
    const glyph = container.querySelector('.ma-consultant-chip [aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent).toBe('ⓘ');
  });

  test('aria-label gives screen readers the meaning, not the glyph', () => {
    act(() => root.render(<ConsultantModeChip />));
    const el = container.querySelector('.ma-consultant-chip');
    const label = el?.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/consultant/i);
    // The label should explain *what consultant mode is*, not just repeat
    // the visible word — that's the whole point of giving it an aria-label
    // instead of relying on the textContent.
    expect(label).toMatch(/read-only by default/i);
  });

  test('tooltip explains the rule + the advisory-only caveat', () => {
    act(() => root.render(<ConsultantModeChip />));
    const el = container.querySelector('.ma-consultant-chip');
    const title = el?.getAttribute('title') ?? '';
    // Names the carve-out so a curious operator hovering understands what
    // would unlock a worker to mutate.
    expect(title).toMatch(/unless your prompt explicitly directs/i);
    // Honesty: the constraint is advisory, not enforced.
    expect(title).toMatch(/no server-side enforcement/i);
    // Points the operator at the paired banner for the full story.
    expect(title).toMatch(/banner/i);
  });

  test('is non-interactive: no onClick, no role="button", no tabIndex', () => {
    act(() => root.render(<ConsultantModeChip />));
    const el = container.querySelector('.ma-consultant-chip');
    expect(el?.getAttribute('role')).toBeNull();
    expect(el?.getAttribute('tabindex')).toBeNull();
    // A click on the chip should not throw — it's not wired to anything.
    act(() => {
      (el as HTMLElement | null)?.click();
    });
    // Sanity: still in the DOM, no error.
    expect(container.querySelector('.ma-consultant-chip')).not.toBeNull();
  });
});
