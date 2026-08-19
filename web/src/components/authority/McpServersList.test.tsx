// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { McpServerView } from '@cebab/shared/protocol';
import { McpServersList } from './McpServersList';

// Cluster B Phase 6c — UI-B13 / B15: McpServersList contract.
//
// Tests:
//   - happy path: one card per declared server
//   - empty: explicit "no MCP servers declared" copy (not blank)
//   - scope chip + trust chip + status dot all render
//   - status dot defaults to muted/gray for unknown statuses (UI-B15)
//   - copy-to-clipboard button writes the originPath
//   - cebab-injected sorts to the bottom
//   - BE-B12 [security]: envKeys render NAMES only, never values

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

function mk(over: Partial<McpServerView> = {}): McpServerView {
  return {
    name: 'git-mcp',
    status: 'connected',
    scope: 'project',
    originPath: '/u/p/.claude/settings.json',
    tools: ['mcp__git__commit', 'mcp__git__diff'],
    trust: 'trusted',
    ...over,
  };
}

describe('McpServersList — rendering', () => {
  // REWRITTEN, not deleted (Cebab-ys9). This case used to assert the string
  // 'No MCP servers declared' — which made it a test DEFENDING the defect:
  // the list renders empty for two unrelated reasons and that sentence is only
  // true for one of them. On an untrusted project the scans never open
  // `.mcp.json`, so a project that declares a server got told it had none, in
  // precisely the situation where the operator was trying to find out why its
  // tools were missing. Both directions are pinned below so neither branch can
  // drift back into asserting the other's meaning.
  test('empty because the scans were not allowed to look says so, and points at Trust', () => {
    act(() => {
      root.render(<McpServersList servers={[]} projectScopeRead={false} />);
    });
    expect(container.querySelector('.mcp-servers-empty')).not.toBeNull();
    expect(container.textContent).toContain('.mcp.json');
    expect(container.textContent).toContain('Trust');
    // The claim it must NOT make: that the project has none.
    expect(container.textContent).not.toContain('No MCP servers');
  });

  test('empty after actually reading the declarations may say none were found', () => {
    act(() => {
      root.render(<McpServersList servers={[]} projectScopeRead />);
    });
    expect(container.querySelector('.mcp-servers-empty')).not.toBeNull();
    expect(container.textContent).toContain('No MCP servers found');
    // And must NOT send the operator to a Trust toggle that would change
    // nothing — the files were already read.
    expect(container.textContent).not.toContain('Turn Trust on');
  });

  test('defaults to the read interpretation, so existing callers are unchanged', () => {
    act(() => {
      root.render(<McpServersList servers={[]} />);
    });
    expect(container.textContent).toContain('No MCP servers found');
  });

  test('renders one card per server alphabetically; cebab-injected to bottom', () => {
    act(() => {
      root.render(
        <McpServersList
          servers={[
            mk({ name: 'zeta', scope: 'project' }),
            mk({ name: 'alpha', scope: 'user' }),
            mk({ name: 'bus_send', scope: 'cebab-injected' }),
            mk({ name: 'github', scope: 'project' }),
          ]}
        />,
      );
    });
    const names = Array.from(container.querySelectorAll<HTMLElement>('.mcp-server-name')).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['alpha', 'github', 'zeta', 'bus_send']);
  });

  test('status, scope, trust chips render', () => {
    act(() => {
      root.render(
        <McpServersList
          servers={[mk({ status: 'needs-auth', scope: 'local', trust: 'pending_tofu' })]}
        />,
      );
    });
    const card = container.querySelector('.mcp-server-card')!;
    expect(card.querySelector('.mcp-status-warn')).not.toBeNull();
    expect(card.querySelector('.mcp-scope-local')).not.toBeNull();
    expect(card.querySelector('.mcp-trust-warn')).not.toBeNull();
    expect(card.textContent).toContain('pending TOFU');
  });

  test('unknown status falls through to muted gray (UI-B15)', () => {
    act(() => {
      root.render(<McpServersList servers={[mk({ status: 'some-future-status' })]} />);
    });
    const dot = container.querySelector('.mcp-status-dot')!;
    expect(dot.className).toContain('mcp-status-muted');
  });

  test('originPath copy button writes to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    act(() => {
      root.render(<McpServersList servers={[mk()]} />);
    });
    const btn = container.querySelector('.mcp-copy-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('/u/p/.claude/settings.json');
  });

  test('envKeys render NAMES only — no values anywhere in DOM (BE-B12)', () => {
    act(() => {
      root.render(
        <McpServersList
          servers={[
            mk({
              config: {
                command: '/bin/git-mcp',
                envKeys: ['GIT_TOKEN', 'GITHUB_TOKEN'],
              },
            }),
          ]}
        />,
      );
    });
    expect(container.textContent).toContain('GIT_TOKEN');
    expect(container.textContent).toContain('GITHUB_TOKEN');
    // Defensive: a value-looking pattern should NOT appear.
    expect(container.textContent).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(container.textContent).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  test('tool count chip pluralizes correctly', () => {
    act(() => {
      root.render(
        <McpServersList
          servers={[mk({ name: 'singular', tools: ['only-one'] }), mk({ name: 'plural' })]}
        />,
      );
    });
    const counts = Array.from(container.querySelectorAll<HTMLElement>('.mcp-tool-count')).map(
      (el) => el.textContent,
    );
    expect(counts).toContain('1 tool');
    expect(counts).toContain('2 tools');
  });
});
