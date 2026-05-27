// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SkillsList } from './SkillsList';

// Cluster B Phase 8 — UI-B42: SkillsList contract.
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

describe('SkillsList', () => {
  test('empty state copy', () => {
    act(() => {
      root.render(<SkillsList skills={[]} />);
    });
    expect(container.querySelector('.auth-name-list-empty')).not.toBeNull();
    expect(container.textContent).toContain('No skills enumerated');
  });

  test('alphabetical sort', () => {
    act(() => {
      root.render(<SkillsList skills={['superpower', 'ability', 'meta']} />);
    });
    const names = Array.from(
      container.querySelectorAll<HTMLElement>('.auth-name-list-item-name'),
    ).map((el) => el.textContent);
    expect(names).toEqual(['ability', 'meta', 'superpower']);
  });

  test('renders the skill name verbatim (no slash prepended)', () => {
    act(() => {
      root.render(<SkillsList skills={['my-skill']} />);
    });
    const name = container.querySelector('.auth-name-list-item-name')?.textContent;
    expect(name).toBe('my-skill');
  });

  test('renders names inside <code class="auth-name-list-item-name">', () => {
    act(() => {
      root.render(<SkillsList skills={['a']} />);
    });
    const code = container.querySelector('.auth-name-list-item-name');
    expect(code?.tagName).toBe('CODE');
  });
});
