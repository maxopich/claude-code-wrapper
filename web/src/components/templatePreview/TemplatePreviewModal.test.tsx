// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentTemplate, Project } from '@cebab/shared/protocol';
import {
  decideSplitView,
  SPLIT_VIEW_PREF_KEY,
  SPLIT_VIEW_AUTO_N,
  TemplatePreviewModal,
} from './TemplatePreviewModal';

// React 18+ requires this flag for `act` to work in non-RTL setups.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom doesn't ship matchMedia; AgentDiagram calls it once for the
// reduced-motion check. Stub it as "no preference" (motion allowed) so
// the trip-animation code path is exercised. Tests don't observe the
// animation directly, but the JS guard reads matchMedia regardless.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
  });

  // Node ≥22 ships an experimental top-level `localStorage` that vitest 4
  // activates without a backing file, leaving `window.localStorage` as a
  // stub whose methods throw. Override with a plain Map-based shim so the
  // modal's pref-persistence code runs the same as in a real browser.
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
});

/**
 * PR-5 component + a11y coverage. Uses raw React 18 `createRoot` + the
 * `act` helper — Cebab does not pull `@testing-library/react` for v1
 * (the dependency was deferred per `web/package.json`). The tests
 * still cover the ACs that matter most:
 *
 *  - AC-18: role/dialog/aria-modal/aria-labelledby, initial focus on
 *    close button, body scroll lock, inert siblings, scoped live
 *    region — all observable in the DOM.
 *  - AC-17: Esc closes (via useModalKeys), backdrop click closes,
 *    ✕ button closes.
 *  - AC-22: split-view default per N + localStorage pref override.
 *  - AC-19: roles survive modal mount/unmount (via the controlled
 *    pattern — the same `roles` ref is passed through both compact
 *    AgentDiagram and modal AgentDiagram).
 */

function mkProject(id: number, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    trusted: true,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: true,
    busAgentName: name.toLowerCase(),
  };
}

function mkTemplate(participants: number[], mode: 'chain' | 'orchestrator'): MultiAgentTemplate {
  return {
    id: 'tpl-test',
    name: 'Test Template',
    mode,
    lifecycle: 'persistent',
    participants,
    roles: {},
  };
}

describe('decideSplitView (PR-5 AC-22)', () => {
  test('returns stored pref when set', () => {
    expect(decideSplitView(3, true)).toBe(true);
    expect(decideSplitView(20, false)).toBe(false);
  });
  test('falls back to N-based default at the auto-N threshold', () => {
    for (let n = 1; n < SPLIT_VIEW_AUTO_N; n++) {
      expect(decideSplitView(n, null)).toBe(false);
    }
    for (const n of [SPLIT_VIEW_AUTO_N, SPLIT_VIEW_AUTO_N + 1, 14, 20, 30]) {
      expect(decideSplitView(n, null)).toBe(true);
    }
  });
});

describe('TemplatePreviewModal — a11y + close vectors (AC-17/18)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onCloseCalls: number;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'app-root';
    document.body.appendChild(container);
    root = createRoot(container);
    onCloseCalls = 0;
    window.localStorage.removeItem(SPLIT_VIEW_PREF_KEY);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = '';
    window.localStorage.removeItem(SPLIT_VIEW_PREF_KEY);
  });

  function mount(participants: Project[]) {
    act(() => {
      root.render(
        <TemplatePreviewModal
          template={mkTemplate(
            participants.map((p) => p.id),
            'orchestrator',
          )}
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
          onClose={() => {
            onCloseCalls += 1;
          }}
        />,
      );
    });
  }

  test('renders as a labelled modal dialog with focused close button', () => {
    mount([mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.textContent).toBe('Test Template');
    const close = container.querySelector('.tpl-modal-close') as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  test('Esc dispatches onClose (via useModalKeys)', () => {
    mount([mkProject(1, 'Alpha')]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCloseCalls).toBe(1);
  });

  test('click on backdrop dispatches onClose; click inside the dialog does not', () => {
    mount([mkProject(1, 'Alpha')]);
    const overlay = container.querySelector('.tpl-modal-overlay') as HTMLElement;
    const dialog = container.querySelector('.tpl-modal') as HTMLElement;
    // Inside-click first (target = .tpl-modal, currentTarget = overlay)
    act(() => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onCloseCalls).toBe(0);
    // Backdrop click (target === currentTarget)
    act(() => {
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onCloseCalls).toBe(1);
  });

  test('Close button click dispatches onClose', () => {
    mount([mkProject(1, 'Alpha')]);
    const close = container.querySelector('.tpl-modal-close') as HTMLButtonElement;
    act(() => {
      close.click();
    });
    expect(onCloseCalls).toBe(1);
  });

  test('body scroll is locked on mount and restored on unmount', () => {
    document.body.style.overflow = 'auto';
    mount([mkProject(1, 'Alpha')]);
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.unmount());
    expect(document.body.style.overflow).toBe('auto');
  });

  test('sibling elements get the inert attribute while the modal is open', () => {
    const sibling = document.createElement('div');
    sibling.id = 'sibling';
    document.body.insertBefore(sibling, container);
    try {
      mount([mkProject(1, 'Alpha')]);
      expect(sibling.hasAttribute('inert')).toBe(true);
      act(() => root.unmount());
      expect(sibling.hasAttribute('inert')).toBe(false);
    } finally {
      sibling.remove();
    }
  });

  test('scoped live region announces template name + agent count', () => {
    mount([mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement | null;
    expect(live).not.toBeNull();
    expect(live!.textContent).toContain('Test Template');
    expect(live!.textContent).toContain('2 agents');
  });
});

describe('TemplatePreviewModal — split-view default + persistence (AC-22)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.removeItem(SPLIT_VIEW_PREF_KEY);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = '';
    window.localStorage.removeItem(SPLIT_VIEW_PREF_KEY);
  });

  function mount(participants: Project[]) {
    act(() => {
      root.render(
        <TemplatePreviewModal
          template={mkTemplate(
            participants.map((p) => p.id),
            'orchestrator',
          )}
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
          onClose={() => {}}
        />,
      );
    });
  }

  test('split-view OFF by default at N<9', () => {
    mount(Array.from({ length: 3 }, (_, i) => mkProject(i + 1, `A${i}`)));
    expect(container.querySelector('.tpl-modal-panel')).toBeNull();
    expect(container.querySelector('.tpl-modal-body--split')).toBeNull();
  });

  test('split-view ON by default at N≥9', () => {
    mount(Array.from({ length: 9 }, (_, i) => mkProject(i + 1, `A${i}`)));
    expect(container.querySelector('.tpl-modal-panel')).not.toBeNull();
    expect(container.querySelector('.tpl-modal-body--split')).not.toBeNull();
  });

  test('localStorage pref overrides the N-based default', () => {
    window.localStorage.setItem(SPLIT_VIEW_PREF_KEY, '1');
    mount(Array.from({ length: 3 }, (_, i) => mkProject(i + 1, `A${i}`)));
    // N=3 would default OFF, but the stored pref forces ON.
    expect(container.querySelector('.tpl-modal-panel')).not.toBeNull();
  });

  test('clicking the toggle writes the pref to localStorage', () => {
    mount(Array.from({ length: 3 }, (_, i) => mkProject(i + 1, `A${i}`)));
    const toggle = container.querySelector('.tpl-modal-split-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(SPLIT_VIEW_PREF_KEY)).toBe('1');
    act(() => toggle.click());
    expect(window.localStorage.getItem(SPLIT_VIEW_PREF_KEY)).toBe('0');
  });
});
