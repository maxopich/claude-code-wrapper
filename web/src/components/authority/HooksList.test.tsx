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

  // Cebab-66y: declared-but-not-loaded hooks must be named, not reported as
  // "none declared" — the strong-negative that gets a project trusted.
  test('empty loaded list but unloaded hooks names them instead of "none declared"', () => {
    act(() => {
      root.render(<HooksList hooks={[]} unloaded={[mk({ hookKind: 'SessionStart' })]} />);
    });
    expect(container.querySelector('.hooks-empty')).toBeNull();
    expect(container.textContent).not.toContain('No hooks declared');
    expect(container.querySelector('.hooks-unloaded')).not.toBeNull();
    expect(container.textContent).toContain('will');
    expect(container.textContent).toContain('not load');
    expect(container.querySelector('.hook-card')).not.toBeNull();
  });

  /**
   * Cebab-aklg. The empty state is a STRONG NEGATIVE — "no hooks declared" — and
   * it was false on any machine with a hook-bearing plugin enabled. The beads
   * plugin, enabled on the machine this was found on, ships SessionStart and
   * PreCompact entries that run on every turn of every project.
   */
  test('a plugin hook keeps the empty state from claiming "none declared"', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[]}
          plugin={[mk({ hookKind: 'SessionStart', scope: 'plugin', command: 'bd prime' })]}
        />,
      );
    });
    expect(container.querySelector('.hooks-empty')).toBeNull();
    expect(container.textContent).not.toContain('No hooks declared');
    expect(container.querySelector('.hooks-plugin')).not.toBeNull();
    expect(container.textContent).toContain('bd prime');
  });

  test('the plugin section says Trust does not gate it', () => {
    // The lever an operator reaches for is Trust, and for these it does
    // nothing: `enabledPlugins` is read from the user tier alone, which Cebab's
    // scope set includes trusted or not. A section that listed them without
    // saying so would send someone to flip a switch that changes nothing.
    act(() => {
      root.render(<HooksList hooks={[]} plugin={[mk({ scope: 'plugin', command: 'bd prime' })]} />);
    });
    const note = container.querySelector('.hooks-plugin-note')?.textContent ?? '';
    expect(note).toContain('every project');
    expect(note).toContain('Trust does not gate');
    expect(note).toContain('disabling the plugin');
  });

  test('project hooks and plugin hooks render in separate sections', () => {
    // Not merged, visually or on the wire — they answer different questions and
    // have different levers. See ProjectAuthority.pluginHooks.
    act(() => {
      root.render(
        <HooksList
          hooks={[mk({ hookKind: 'PreToolUse', command: '/project/cmd' })]}
          plugin={[mk({ hookKind: 'SessionStart', scope: 'plugin', command: 'plugin-cmd' })]}
        />,
      );
    });
    expect(container.querySelector('.hooks-plugin')).not.toBeNull();
    expect(container.textContent).toContain('/project/cmd');
    expect(container.textContent).toContain('plugin-cmd');
    // The project hook must not have been swept into the plugin section.
    const pluginSection = container.querySelector('.hooks-plugin')?.textContent ?? '';
    expect(pluginSection).not.toContain('/project/cmd');
  });

  test('loaded and unloaded hooks both render, in separate sections', () => {
    act(() => {
      root.render(
        <HooksList
          hooks={[mk({ hookKind: 'PreToolUse', command: '/loaded/cmd' })]}
          unloaded={[mk({ hookKind: 'SessionStart', command: '/inert/cmd' })]}
        />,
      );
    });
    expect(container.querySelector('.hooks-unloaded')).not.toBeNull();
    expect(container.textContent).toContain('/loaded/cmd');
    expect(container.textContent).toContain('/inert/cmd');
  });
});
