// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { HookView } from '@cebab/shared/protocol';
import { HooksList } from './HooksList';

// Cluster B Phase 6c — UI-B40: HooksList contract.
//
// Tests:
//   - empty: explicit empty copy
//   - grouped by hookKind; alphabetical
//   - within a kind, local sorts first (highest trust burden surfaces)
//   - local hooks get the warn icon + warn-left-stripe class
//   - command + args + binarySha render
//   - aria-label on the warn icon

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

function mk(over: Partial<HookView>): HookView {
  return {
    hookKind: 'PreToolUse',
    scope: 'project',
    scopePath: '/u/p/.claude/settings.json',
    command: '/usr/local/bin/hook.sh',
    ...over,
  };
}

describe('HooksList', () => {
  test('empty state shows the explicit copy', () => {
    act(() => {
      root.render(<HooksList hooks={[]} />);
    });
    expect(container.querySelector('.hooks-empty')).not.toBeNull();
    expect(container.textContent).toContain('No hooks declared');
  });

  test('groups by hookKind alphabetically', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[
            mk({ hookKind: 'Stop' }),
            mk({ hookKind: 'PreToolUse' }),
            mk({ hookKind: 'PostToolUse' }),
          ]}
        />,
      );
    });
    const kinds = Array.from(container.querySelectorAll<HTMLElement>('.hooks-kind-name')).map(
      (el) => el.textContent,
    );
    expect(kinds).toEqual(['PostToolUse', 'PreToolUse', 'Stop']);
  });

  test('within a kind, local sorts first', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[
            mk({ hookKind: 'PreToolUse', scope: 'user', command: '/u/cmd' }),
            mk({ hookKind: 'PreToolUse', scope: 'local', command: '/local/cmd' }),
            mk({ hookKind: 'PreToolUse', scope: 'project', command: '/p/cmd' }),
          ]}
        />,
      );
    });
    // First card inside the only kind group should be the local one.
    const cards = container.querySelectorAll('.hook-card');
    expect(cards[0]?.className).toContain('hook-card-local');
  });

  test('local hooks get the warn icon (UI-B40) + warn-class', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[mk({ scope: 'local', scopePath: '/u/p/.claude/settings.local.json' })]}
        />,
      );
    });
    const card = container.querySelector('.hook-card')!;
    expect(card.className).toContain('hook-card-warn');
    const warnIcon = card.querySelector('.hook-card-warn-icon');
    expect(warnIcon).not.toBeNull();
    expect(warnIcon?.getAttribute('aria-label')).toContain('warn');
  });

  test('non-local hooks have no warn icon and no warn class', () => {
    act(() => {
      root.render(<HooksList hooks={[mk({ scope: 'project' })]} />);
    });
    const card = container.querySelector('.hook-card')!;
    expect(card.className).not.toContain('hook-card-warn');
    expect(card.querySelector('.hook-card-warn-icon')).toBeNull();
  });

  test('command + args + binarySha all render', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[mk({ command: '/bin/script.sh', args: ['--quiet'], binarySha: 'abc123' })]}
        />,
      );
    });
    const card = container.querySelector('.hook-card')!;
    expect(card.textContent).toContain('/bin/script.sh');
    expect(card.textContent).toContain('--quiet');
    expect(card.textContent).toContain('abc123');
  });

  test('binarySha row omits when absent', () => {
    act(() => {
      root.render(<HooksList hooks={[mk({ binarySha: undefined })]} />);
    });
    const card = container.querySelector('.hook-card')!;
    expect(card.querySelector('.hook-card-sha')).toBeNull();
  });
});
