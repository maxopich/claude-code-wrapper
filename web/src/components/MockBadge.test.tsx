// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MockBadge } from './MockBadge';

// Cluster G Phase 2a (UI-A3): MockBadge is pure presentational — no
// store reads, no props. The accessibility surfaces matter because the
// badge IS the signal: a colorblind, screen-reader, or reduced-motion
// operator needs to perceive "this is a MOCK process" from the same UI
// without depending on the stripe pattern.
//
// Uses raw createRoot + act (no @testing-library) per project convention
// — matches ConsultantModeChip / MaxTurnsInput / HopBudgetInput test
// patterns and avoids adding a new test-deps tax.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MockBadge', () => {
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

  test('renders under the .mock-badge class with text "MOCK"', () => {
    act(() => root.render(<MockBadge />));
    const el = container.querySelector('.mock-badge');
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe('SPAN');
    // Text-based assertion — the badge must not rely on pattern alone.
    expect(el?.textContent).toBe('MOCK');
  });

  test('exposes role="status" so SR users hear the posture without focus', () => {
    act(() => root.render(<MockBadge />));
    const el = container.querySelector('.mock-badge');
    expect(el?.getAttribute('role')).toBe('status');
  });

  test('aria-label spells out the full posture (not just "MOCK")', () => {
    // The visible word is compact (sidebar chip). The aria-label carries
    // the full explanation so a screen-reader user hears "Cebab is in
    // MOCK mode — no real model calls. …" rather than just "MOCK",
    // which on its own is ambiguous.
    act(() => root.render(<MockBadge />));
    const el = container.querySelector('.mock-badge');
    const label = el?.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/MOCK/);
    expect(label).toMatch(/no real model calls/i);
    expect(label).toMatch(/replay fixtures/i);
  });

  test('title (tooltip) explains how to leave MOCK mode', () => {
    // The actionable bit: how to turn MOCK off. Operators who don't
    // recall the MOCK=1 env flag get the answer from hovering the chip.
    act(() => root.render(<MockBadge />));
    const el = container.querySelector('.mock-badge');
    const title = el?.getAttribute('title') ?? '';
    expect(title).toMatch(/MOCK=0/);
    expect(title).toMatch(/restart/i);
  });

  test('is non-interactive: no role="button", no link, no tabindex', () => {
    // The badge is a status, not an affordance. Per spec §5 the badge
    // is "non-dismissible" — there is no close button, no link, no
    // action. Confirm a click does not throw and the chip stays mounted.
    act(() => root.render(<MockBadge />));
    const el = container.querySelector('.mock-badge');
    expect(el?.getAttribute('role')).toBe('status'); // status, not button
    expect(el?.getAttribute('tabindex')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    act(() => {
      (el as HTMLElement | null)?.click();
    });
    expect(container.querySelector('.mock-badge')).not.toBeNull();
  });
});

// Sidebar-header mount predicate: pins the strict-equality semantics so
// pre-G1 server payloads (no mockMode field) and live runtime
// (mockMode=false) both render nothing — only mockMode === true renders
// the badge. A focused harness rather than the full App.tsx shell — the
// strict-equality is what matters, and a heavy integration test would
// re-fire for any unrelated AppShell churn.
describe('MockBadge — sidebar-header mount predicate (App.tsx pattern)', () => {
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

  // Replicates the JSX pattern in App.tsx's sidebar `<header>`:
  //   {state.settings?.mockMode === true && <MockBadge />}
  function Harness({ mockMode }: { mockMode: boolean | undefined }) {
    return <div>{mockMode === true && <MockBadge />}</div>;
  }

  test('mockMode=true → badge mounts', () => {
    act(() => root.render(<Harness mockMode={true} />));
    expect(container.querySelector('.mock-badge')).not.toBeNull();
  });

  test('mockMode=false → badge does NOT mount', () => {
    act(() => root.render(<Harness mockMode={false} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });

  test('mockMode=undefined (pre-G1 server) → badge does NOT mount', () => {
    act(() => root.render(<Harness mockMode={undefined} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });
});
