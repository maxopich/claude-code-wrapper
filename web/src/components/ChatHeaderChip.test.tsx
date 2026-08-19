// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatHeaderChip } from './ChatHeaderChip';
import { AuthorityProvider } from './authority/AuthorityContext';

// Cluster B Phase 6e — ChatHeaderChip wiring smoke.
//
// Tests:
//   - legacy shape (no projectId) renders only the chip span (no group / link)
//   - new shape (with projectId) renders chip + [Authority…] link
//   - clicking [Authority…] opens the preflight modal

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

describe('ChatHeaderChip — Phase 6e wiring', () => {
  test('legacy shape (no projectId) renders only the chip', () => {
    act(() => {
      root.render(<ChatHeaderChip trusted={false} mode="default" />);
    });
    expect(container.querySelector('.trust-chip')).not.toBeNull();
    expect(container.querySelector('.trust-chip-group')).toBeNull();
    expect(container.querySelector('.trust-chip-authority-link')).toBeNull();
  });

  test('with projectId renders chip + [Authority…] link', () => {
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}}>
          <ChatHeaderChip trusted={false} mode="default" projectId={42} />
        </AuthorityProvider>,
      );
    });
    expect(container.querySelector('.trust-chip-group')).not.toBeNull();
    const link = container.querySelector('.trust-chip-authority-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain('Authority');
  });

  test('clicking [Authority…] opens the preflight modal', () => {
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}}>
          <ChatHeaderChip trusted={false} mode="default" projectId={42} />
        </AuthorityProvider>,
      );
    });
    expect(document.querySelector('.authority-preflight-modal')).toBeNull();
    const link = container.querySelector('.trust-chip-authority-link') as HTMLButtonElement;
    act(() => {
      link.click();
    });
    expect(document.querySelector('.authority-preflight-modal')).not.toBeNull();
    // Title is the single-project variant since we passed one id.
    const title = document.querySelector('.authority-preflight-modal .gate-modal-title');
    expect(title?.textContent).toBe('Authority preview');
  });
});

describe('ChatHeaderChip — what the chip claims (Cebab-ws0.14)', () => {
  function chipFor(trusted: boolean, mode: 'default' | 'acceptEdits') {
    act(() => {
      root.render(<ChatHeaderChip trusted={trusted} mode={mode} />);
    });
    return container.querySelector('.trust-chip') as HTMLElement;
  }

  test('a trusted project in ask mode does not claim to auto-allow', () => {
    // The defect this whole change is about, at the surface the operator
    // actually reads. Before Cebab-ws0.14 this chip said "auto-allow ALL"
    // while the pill said "ask" — and the chip was the honest one, because
    // the mode genuinely did nothing. Now the mode binds, so the chip has to
    // follow it.
    const chip = chipFor(true, 'default');
    expect(chip.textContent).toContain('ask every tool');
    expect(chip.textContent).not.toContain('auto-allow');
    // ok-green, not the amber reserved for "you said yes to all of this".
    expect(chip.className).toContain('trust-chip-ok');
  });

  test('a trusted project in auto-edits mode still says auto-allow ALL, in amber', () => {
    // The control. This is the DEFAULT posture for a trusted project
    // (seedPermissionMode seeds acceptEdits), so if this row moved, the change
    // would not be the narrowing it claims to be.
    const chip = chipFor(true, 'acceptEdits');
    expect(chip.textContent).toContain('auto-allow ALL');
    expect(chip.className).toContain('trust-chip-warn');
  });

  test('[security] every tooltip says the pill changes what asks, not what loads', () => {
    // PR #364 removed copy claiming the permissions pill changes settingSources
    // ("To change scope: toggle the permissions pill"). It does not — Trust is
    // the only control over what loads. Adding a fourth chip state is exactly
    // the moment that wrong claim gets re-copied into the new string, so the
    // corrected formula is asserted for every state rather than reviewed once.
    const seen: string[] = [];
    for (const trusted of [true, false]) {
      for (const mode of ['default', 'acceptEdits'] as const) {
        const title = chipFor(trusted, mode).getAttribute('title') ?? '';
        seen.push(title);
        expect(title).toContain('settingSources');
        // Every tooltip names what LOADS and attributes it to Trust.
        expect(title).toMatch(/changes what asks, not what loads|toggle Trust off in the sidebar/);
        // The banned claim, in the shape it took before #364.
        expect(title).not.toMatch(/change scope: toggle the permissions pill/i);
        // The invariant, stated so it cannot flag its own remedy: if a tooltip
        // mentions the pill at all, it must be to DENY that the pill affects
        // loading. (A blunter "pill near loads" ban fails here — the corrected
        // formula contains the word "loads", so the guard would reject the
        // very sentence #364 introduced.)
        if (/permissions pill/i.test(title)) {
          expect(title).toContain('changes what asks, not what loads');
        }
      }
    }
    // Anti-vacuity: four distinct states, four distinct tooltips. A render
    // that silently fell back to one string would satisfy every assertion above.
    expect(new Set(seen).size).toBe(4);
  });
});
