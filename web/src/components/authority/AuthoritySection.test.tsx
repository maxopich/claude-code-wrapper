// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AuthoritySection } from './AuthoritySection';

// Cluster B Phase 6b — UI-B2 / spec §6.7: AuthoritySection contract.
//
// Tests:
//   - title + count render
//   - <details> respects defaultOpen
//   - trailing slot renders and click doesn't toggle <details>
//   - changedHint produces an sr-only role=status mirror
//   - stripe variant applies a class without overriding behaviour

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

describe('AuthoritySection', () => {
  test('renders title, count badge, sublabel', () => {
    act(() => {
      root.render(
        <AuthoritySection title="Tools" count={3} sublabel="2 unavailable">
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const summary = container.querySelector('.authority-section-summary');
    expect(summary?.textContent).toContain('Tools');
    expect(summary?.textContent).toContain('3');
    expect(summary?.textContent).toContain('2 unavailable');
  });

  test('defaultOpen=true opens the details element', () => {
    act(() => {
      root.render(
        <AuthoritySection title="X" defaultOpen>
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const details = container.querySelector('details.authority-section');
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(container.querySelector('.authority-section-body')?.textContent).toBe('body');
  });

  test('defaultOpen=false keeps the details closed', () => {
    act(() => {
      root.render(
        <AuthoritySection title="X">
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const details = container.querySelector('details.authority-section');
    expect((details as HTMLDetailsElement).open).toBe(false);
  });

  test('trailing slot renders and click does not toggle the details', () => {
    let clicked = 0;
    act(() => {
      root.render(
        <AuthoritySection
          title="X"
          trailing={
            <button type="button" onClick={() => (clicked += 1)}>
              Refresh
            </button>
          }
        >
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const btn = container.querySelector('.authority-section-trailing button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    const details = container.querySelector('details.authority-section') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    act(() => {
      btn.click();
    });
    expect(clicked).toBe(1);
    // Browser-level toggle on summary is what details responds to; our
    // stopPropagation guarantees the click never reaches summary, so the
    // details stays closed.
    expect(details.open).toBe(false);
  });

  test('changedHint produces an sr-only role=status mirror with the hint text', () => {
    act(() => {
      root.render(
        <AuthoritySection title="X" changedHint="tools changed since last paint">
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const mirror = container.querySelector('[role="status"]') as HTMLElement;
    expect(mirror).not.toBeNull();
    expect(mirror.getAttribute('aria-live')).toBe('polite');
    expect(mirror.textContent).toBe('tools changed since last paint');
    // It's positioned off-screen — class is sr-only-equivalent.
    expect(mirror.className).toContain('authority-section-sr-mirror');
  });

  test('stripe variant applies the expected class', () => {
    act(() => {
      root.render(
        <AuthoritySection title="X" stripe="added">
          <span>body</span>
        </AuthoritySection>,
      );
    });
    const details = container.querySelector('details.authority-section');
    expect(details?.className).toContain('authority-section-stripe-added');
  });
});
