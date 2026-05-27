// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ToolView } from '@cebab/shared/protocol';
import { AllowDenyView } from './AllowDenyView';

// Cluster B Phase 6c — UI-B16 / B17 / B19: AllowDenyView contract.
//
// Tests:
//   - allow pane lists only explicit allows (rulingScope !== 'default')
//   - deny pane lists every denied tool (including default-deny)
//   - empty panes show "(none configured)" copy (UI-B19)
//   - default-deny tail is hinted in deny pane footer (§6.4)
//   - per-row provenance is a scope chip, not row-color (UI-B17 friend)
//   - rows sort alphabetically inside each pane

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

function mk(over: Partial<ToolView>): ToolView {
  return {
    name: 'Read',
    source: 'builtin',
    allowed: true,
    denied: false,
    rulingScope: 'default',
    ...over,
  };
}

describe('AllowDenyView', () => {
  test('explicit allow + explicit deny split into respective panes', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[
            mk({ name: 'Read', allowed: true, denied: false, rulingScope: 'project' }),
            mk({ name: 'Bash', allowed: false, denied: true, rulingScope: 'user' }),
          ]}
        />,
      );
    });
    const allowPane = container.querySelector('.allow-deny-pane-allow')!;
    const denyPane = container.querySelector('.allow-deny-pane-deny')!;
    expect(allowPane.textContent).toContain('Read');
    expect(denyPane.textContent).toContain('Bash');
  });

  test('default-allow (rulingScope=default) does NOT show in allow pane', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[
            mk({ name: 'Read', allowed: true, denied: false, rulingScope: 'default' }),
            mk({ name: 'Edit', allowed: true, denied: false, rulingScope: 'project' }),
          ]}
        />,
      );
    });
    const allowPane = container.querySelector('.allow-deny-pane-allow')!;
    expect(allowPane.textContent).not.toContain('Read');
    expect(allowPane.textContent).toContain('Edit');
  });

  test('default-deny tail is counted and hinted in footer', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[
            mk({ name: 'a', allowed: false, denied: true, rulingScope: 'default' }),
            mk({ name: 'b', allowed: false, denied: true, rulingScope: 'default' }),
            mk({ name: 'c', allowed: false, denied: true, rulingScope: 'project' }),
          ]}
        />,
      );
    });
    const denyPane = container.querySelector('.allow-deny-pane-deny')!;
    const hint = denyPane.querySelector('.allow-deny-pane-hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('2 denied via SDK default');
  });

  test('empty allow pane shows explicit "(none configured)" copy (UI-B19)', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[mk({ name: 'Bash', allowed: false, denied: true, rulingScope: 'project' })]}
        />,
      );
    });
    const allowPane = container.querySelector('.allow-deny-pane-allow')!;
    expect(allowPane.textContent).toContain('Allow: (none configured)');
  });

  test('empty deny pane shows explicit "(none configured)" copy', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[mk({ name: 'Read', allowed: true, denied: false, rulingScope: 'project' })]}
        />,
      );
    });
    const denyPane = container.querySelector('.allow-deny-pane-deny')!;
    expect(denyPane.textContent).toContain('Deny: (none configured)');
  });

  test('each row carries a scope chip with the rulingScope label', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[
            mk({ name: 'Read', allowed: true, rulingScope: 'project' }),
            mk({ name: 'Bash', allowed: false, denied: true, rulingScope: 'local' }),
          ]}
        />,
      );
    });
    const chips = Array.from(container.querySelectorAll('.allow-deny-scope-chip'));
    const labels = chips.map((c) => c.textContent?.trim());
    expect(labels).toContain('project');
    expect(labels).toContain('local');
    // aria-label carries the same value — UI-B17 (chip-not-color provenance).
    for (const c of chips) {
      expect(c.getAttribute('aria-label')).toMatch(/^ruling scope: /);
    }
  });

  test('rows sort alphabetically inside each pane', () => {
    act(() => {
      root.render(
        <AllowDenyView
          tools={[
            mk({ name: 'Zeta', allowed: true, rulingScope: 'project' }),
            mk({ name: 'Alpha', allowed: true, rulingScope: 'project' }),
            mk({ name: 'Mike', allowed: true, rulingScope: 'project' }),
          ]}
        />,
      );
    });
    const allowNames = Array.from(
      container.querySelectorAll('.allow-deny-pane-allow .allow-deny-name'),
    ).map((c) => c.textContent);
    expect(allowNames).toEqual(['Alpha', 'Mike', 'Zeta']);
  });
});
