// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SubAgentsList } from './SubAgentsList';

// Cluster B Phase 8 — UI-B43: SubAgentsList contract.
//
// Tests:
//   - empty: explicit copy
//   - non-empty: alphabetical sort
//   - monospace rendering

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

describe('SubAgentsList', () => {
  test('empty state copy', () => {
    act(() => {
      root.render(<SubAgentsList agents={[]} />);
    });
    expect(container.querySelector('.auth-name-list-empty')).not.toBeNull();
    expect(container.textContent).toContain('No sub-agents declared');
  });

  test('alphabetical sort', () => {
    act(() => {
      root.render(<SubAgentsList agents={['planner', 'explorer', 'general-purpose']} />);
    });
    const names = Array.from(
      container.querySelectorAll<HTMLElement>('.auth-name-list-item-name'),
    ).map((el) => el.textContent);
    expect(names).toEqual(['explorer', 'general-purpose', 'planner']);
  });

  test('renders the agent name verbatim', () => {
    act(() => {
      root.render(<SubAgentsList agents={['code-reviewer']} />);
    });
    const name = container.querySelector('.auth-name-list-item-name')?.textContent;
    expect(name).toBe('code-reviewer');
  });

  test('renders names inside <code class="auth-name-list-item-name">', () => {
    act(() => {
      root.render(<SubAgentsList agents={['a']} />);
    });
    const code = container.querySelector('.auth-name-list-item-name');
    expect(code?.tagName).toBe('CODE');
  });
});
