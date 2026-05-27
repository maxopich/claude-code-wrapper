// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { McpServerView, ToolView } from '@cebab/shared/protocol';
import { ToolsList } from './ToolsList';

// Cluster B Phase 6b — ToolsList contract.
//
// Tests:
//   - UI-B10: alphabetical order
//   - UI-B10: source chip + risk badge per row; icon+text not color-only
//     (assert aria-label is set)
//   - UI-B11: search filters by name; debounced (we use fake timers)
//   - UI-B12: per-tool details is closed by default (lazy body); opening
//     reveals provenance
//   - UI-B6 (BE-B6 cascade): a tool whose mcpServer is needs-auth shows the
//     unavailable badge AND the body reason
//   - UI-B33: ArrowDown moves the active row; Home/End jump
//   - mode='usage-diff' renders the Phase 10 stub

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

function mkTool(over: Partial<ToolView>): ToolView {
  return {
    name: 'Read',
    source: 'builtin',
    allowed: true,
    denied: false,
    rulingScope: 'default',
    ...over,
  };
}

const sampleTools: ToolView[] = [
  mkTool({ name: 'Read', source: 'builtin' }),
  mkTool({ name: 'Bash', source: 'builtin' }),
  mkTool({ name: 'Edit', source: 'builtin' }),
  mkTool({ name: 'mcp__git__commit', source: 'mcp', mcpServer: 'git' }),
  mkTool({
    name: 'mcp__github__create_pr',
    source: 'mcp',
    mcpServer: 'github',
    allowed: false,
  }),
];

const sampleServers: McpServerView[] = [
  {
    name: 'git',
    status: 'connected',
    scope: 'project',
    originPath: '/u/p/.claude/settings.json',
    tools: ['mcp__git__commit'],
    trust: 'trusted',
  },
  {
    name: 'github',
    status: 'needs-auth',
    scope: 'project',
    originPath: '/u/p/.claude/settings.json',
    tools: ['mcp__github__create_pr'],
    trust: 'trusted',
  },
];

function typeIntoSearch(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ToolsList — rendering', () => {
  test('renders tools alphabetically', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const names = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    // localeCompare uses Unicode collation (case-insensitive by default), so
    // 'Read' sorts AFTER 'mcp__...' alphabetically — 'm' < 'r' regardless of
    // case. That's the desired UX: alphabetic by feel, not ASCII codepoint.
    expect(names).toEqual(['Bash', 'Edit', 'mcp__git__commit', 'mcp__github__create_pr', 'Read']);
  });

  test('each row carries a risk badge with aria-label (not color-only)', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const badges = Array.from(container.querySelectorAll('.mutation-badge'));
    expect(badges.length).toBe(sampleTools.length);
    for (const b of badges) {
      expect(b.getAttribute('aria-label')).toMatch(/risk: (read|mutate|dangerous)/);
    }
  });

  test('Bash gets the dangerous badge; Edit gets mutate; Read gets read', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tool-row'));
    function rowFor(name: string) {
      return rows.find((r) => r.querySelector('.tool-row-name')?.textContent === name)!;
    }
    expect(rowFor('Bash').querySelector('.mutation-badge-dangerous')).not.toBeNull();
    expect(rowFor('Edit').querySelector('.mutation-badge-mutate')).not.toBeNull();
    expect(rowFor('Read').querySelector('.mutation-badge-read')).not.toBeNull();
  });

  test('source chip shows the mcpServer name for MCP tools', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const row = Array.from(container.querySelectorAll<HTMLElement>('.tool-row')).find(
      (r) => r.querySelector('.tool-row-name')?.textContent === 'mcp__git__commit',
    )!;
    expect(row.querySelector('.tool-row-mcp-server')?.textContent).toContain('git');
  });

  test('BE-B6 cascade: tool whose mcp server is needs-auth shows unavailable badge', () => {
    act(() => {
      root.render(
        <ToolsList
          // Same tools but flip create_pr to allowed=true to prove the
          // unavailable badge comes from server status, not from the tool flag.
          tools={[
            mkTool({
              name: 'mcp__github__create_pr',
              source: 'mcp',
              mcpServer: 'github',
              allowed: true,
            }),
          ]}
          mcpServers={sampleServers}
        />,
      );
    });
    const row = container.querySelector('.tool-row');
    expect(row?.querySelector('.tool-row-unavailable-badge')).not.toBeNull();
  });
});

describe('ToolsList — search (UI-B11 debounced)', () => {
  test('filtering by name narrows the list after debounce', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const search = container.querySelector('.tools-list-search') as HTMLInputElement;
    act(() => {
      typeIntoSearch(search, 'Edit');
    });
    // Before debounce fires, count still reflects all.
    expect(container.querySelectorAll('.tool-row').length).toBe(sampleTools.length);
    // Advance debounce window.
    act(() => {
      vi.advanceTimersByTime(120);
    });
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(['Edit']);
  });

  test('counts strip shows "N of M"', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    expect(container.querySelector('.tools-list-counts')?.textContent).toBe(
      `${sampleTools.length} of ${sampleTools.length}`,
    );
  });
});

describe('ToolsList — per-tool details body', () => {
  test('row body shows allow/deny/rulingScope when expanded', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={[
            mkTool({
              name: 'Bash',
              source: 'builtin',
              allowed: false,
              denied: true,
              rulingScope: 'project',
            }),
          ]}
          mcpServers={[]}
        />,
      );
    });
    const details = container.querySelector('details.tool-row') as HTMLDetailsElement;
    act(() => {
      details.open = true;
    });
    const body = details.querySelector('.tool-row-body')!;
    expect(body.textContent).toContain('Allowed');
    expect(body.textContent).toContain('Denied');
    expect(body.textContent).toContain('Ruling scope');
    expect(body.textContent).toContain('project');
    expect(body.textContent).toContain('denied (scope: project)');
  });

  test('default-deny via SDK (rulingScope=default) gets the explicit hint', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={[
            mkTool({
              name: 'mystery',
              source: 'builtin',
              allowed: false,
              denied: true,
              rulingScope: 'default',
            }),
          ]}
          mcpServers={[]}
        />,
      );
    });
    const details = container.querySelector('details.tool-row') as HTMLDetailsElement;
    act(() => {
      details.open = true;
    });
    expect(details.textContent).toContain('SDK default — no visible rule matched');
  });
});

describe('ToolsList — keyboard nav', () => {
  test('ArrowDown advances activeIdx', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const list = container.querySelector('.tools-list') as HTMLElement;
    list.focus();
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    // The first row should be marked active.
    expect(container.querySelector('.tool-row.tool-row-active')).not.toBeNull();
  });

  test('End jumps to last row', () => {
    act(() => {
      root.render(<ToolsList tools={sampleTools} mcpServers={sampleServers} />);
    });
    const list = container.querySelector('.tools-list') as HTMLElement;
    list.focus();
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    const active = container.querySelector('.tool-row.tool-row-active') as HTMLElement;
    expect(active).not.toBeNull();
    // The active row should be the alphabetically-last sample (locale-aware
    // sort: case-insensitive — 'Read' sorts after 'mcp__...').
    expect(active.querySelector('.tool-row-name')?.textContent).toBe('Read');
  });
});

describe('ToolsList — mode=usage-diff (Phase 10 / UI-B31)', () => {
  const usageTools: ToolView[] = [
    mkTool({ name: 'Read', calledCount: 5 }),
    mkTool({ name: 'Edit', source: 'builtin', calledCount: 2 }),
    mkTool({ name: 'Bash', source: 'builtin', deniedCount: 3 }),
    mkTool({ name: 'Grep', source: 'builtin' }), // neither used nor denied
    mkTool({ name: 'Write', source: 'builtin', calledCount: 1, deniedCount: 1 }),
  ];

  test('toggle bar renders with four buttons (All / Used / Unused / Attempted)', () => {
    act(() => {
      root.render(
        <ToolsList tools={usageTools} mcpServers={[]} mode="usage-diff" defaultUsageToggle="all" />,
      );
    });
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.tools-list-usage-toggle-btn'),
    ).map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels?.[0]).toMatch(/^All/);
    expect(labels?.[1]).toMatch(/^Used/);
    expect(labels?.[2]).toMatch(/^Unused/);
    expect(labels?.[3]).toMatch(/^Attempted/);
  });

  test('toggle counts reflect the unfiltered tool population', () => {
    act(() => {
      root.render(
        <ToolsList tools={usageTools} mcpServers={[]} mode="usage-diff" defaultUsageToggle="all" />,
      );
    });
    const counts = Array.from(
      container.querySelectorAll<HTMLElement>('.tools-list-usage-toggle-count'),
    ).map((el) => el.textContent);
    // all=5, used=3 (Read+Edit+Write), unused=1 (Grep), attempted=2 (Bash+Write)
    expect(counts).toEqual(['5', '3', '1', '2']);
  });

  test('used rows get the used chip + ok stripe; attempted rows get the err chip + err stripe', () => {
    act(() => {
      root.render(
        <ToolsList tools={usageTools} mcpServers={[]} mode="usage-diff" defaultUsageToggle="all" />,
      );
    });
    const findRow = (name: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('.tool-row')).find(
        (r) => r.querySelector('.tool-row-name')?.textContent === name,
      )!;
    const read = findRow('Read');
    expect(read.className).toContain('tool-row-stripe-used');
    expect(read.querySelector('.tool-row-usage-chip-used')?.textContent).toContain('used ×5');
    expect(read.querySelector('.tool-row-usage-chip-attempted')).toBeNull();

    const bash = findRow('Bash');
    expect(bash.className).toContain('tool-row-stripe-attempted');
    expect(bash.querySelector('.tool-row-usage-chip-attempted')?.textContent).toContain(
      'denied ×3',
    );

    // A row with BOTH counts: attempted stripe wins (it's the red column).
    const write = findRow('Write');
    expect(write.className).toContain('tool-row-stripe-attempted');
    expect(write.querySelector('.tool-row-usage-chip-used')).not.toBeNull();
    expect(write.querySelector('.tool-row-usage-chip-attempted')).not.toBeNull();
  });

  test('toggle=used hides rows with no calledCount', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={usageTools}
          mcpServers={[]}
          mode="usage-diff"
          defaultUsageToggle="used"
        />,
      );
    });
    const names = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    // Read, Edit, Write all have calledCount > 0; Bash has only denied; Grep has neither.
    expect(names.sort()).toEqual(['Edit', 'Read', 'Write']);
  });

  test('toggle=attempted shows only rows with deniedCount > 0', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={usageTools}
          mcpServers={[]}
          mode="usage-diff"
          defaultUsageToggle="attempted"
        />,
      );
    });
    const names = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    // Bash (3 denies) + Write (1 deny)
    expect(names.sort()).toEqual(['Bash', 'Write']);
  });

  test('toggle=unused hides both used and denied rows', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={usageTools}
          mcpServers={[]}
          mode="usage-diff"
          defaultUsageToggle="unused"
        />,
      );
    });
    const names = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    // Only Grep matches.
    expect(names).toEqual(['Grep']);
  });

  test('clicking a toggle button switches the active filter', () => {
    act(() => {
      root.render(
        <ToolsList tools={usageTools} mcpServers={[]} mode="usage-diff" defaultUsageToggle="all" />,
      );
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>('.tools-list-usage-toggle-btn');
    const attempted = Array.from(buttons).find((b) => b.textContent?.includes('Attempted'))!;
    act(() => {
      attempted.click();
    });
    expect(attempted.getAttribute('aria-pressed')).toBe('true');
    const names = Array.from(container.querySelectorAll<HTMLElement>('.tool-row-name')).map(
      (el) => el.textContent,
    );
    expect(names.sort()).toEqual(['Bash', 'Write']);
  });

  test('mode=list does NOT render the toggle bar (preflight)', () => {
    act(() => {
      root.render(<ToolsList tools={usageTools} mcpServers={[]} mode="list" />);
    });
    expect(container.querySelector('.tools-list-usage-toggle')).toBeNull();
    // Chips also do not render in list mode (the data may still have counts
    // but the chrome is suppressed to keep preflight clean).
    expect(container.querySelector('.tool-row-usage-chip')).toBeNull();
  });

  test('expanded body surfaces Used / Denied facts for screen readers', () => {
    act(() => {
      root.render(
        <ToolsList
          tools={[mkTool({ name: 'Bash', calledCount: 2, deniedCount: 1 })]}
          mcpServers={[]}
          mode="usage-diff"
          defaultUsageToggle="all"
        />,
      );
    });
    const details = container.querySelector('details.tool-row') as HTMLDetailsElement;
    act(() => {
      details.open = true;
    });
    expect(details.textContent).toContain('Used');
    expect(details.textContent).toContain('Denied by operator');
  });
});
