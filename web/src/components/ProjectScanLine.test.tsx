// @vitest-environment jsdom
//
// The distinction this file defends: "declares nothing" and "nothing has
// looked" are different facts, and so are "declared" and "loaded". A strip
// that renders blank for an empty project asserts the first pair's wrong half;
// a strip that counts only what loads reproduces the exact blind spot this
// bead exists to close — an untrusted project's `.mcp.json` server, declared
// on disk and invisible everywhere in the UI.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ProjectScan } from '@cebab/shared/protocol';
import { ProjectScanLine, declaredTotal, notLoadedTotal, shortSourceName } from './ProjectScanLine';

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
});

function scan(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    projectId: 1,
    scannedAt: 1_700_000_000_000,
    scopesLoaded: ['user'],
    mcpServers: [],
    hooks: { declared: 0, loaded: 0, hasLocalScope: false },
    envInjections: { declared: 0, loaded: 0 },
    degraded: false,
    ...overrides,
  };
}

function render(props: {
  scan?: ProjectScan;
  managed?: { sourcePath: string; copiedAt: number } | null;
}): void {
  act(() => {
    root.render(<ProjectScanLine {...props} />);
  });
}

const chips = () => [...container.querySelectorAll<HTMLElement>('.project-scan-chip')];
const text = () => chips().map((c) => c.textContent?.replace(/\s+/g, ' ').trim() ?? '');

describe('ProjectScanLine — empty is an answer, absent is not', () => {
  test('a project that declares nothing SAYS so', () => {
    render({ scan: scan() });
    expect(text()).toEqual(['declares nothing']);
  });

  test('no scan at all renders nothing', () => {
    // The other half of the pair. A project the server sent no scan for has
    // not been measured, and must not borrow the sentence for one that has.
    render({ scan: undefined });
    expect(chips()).toHaveLength(0);
    expect(container.querySelector('.project-scan-line')).toBeNull();
  });

  test('a degraded scan says a settings file could not be read, not "declares nothing"', () => {
    render({ scan: scan({ degraded: true }) });
    expect(text()).toEqual(['⚠ settings unreadable']);
    expect(text().join(' ')).not.toContain('declares nothing');
  });
});

describe('ProjectScanLine — declared vs loaded', () => {
  const declaredNotLoaded = scan({
    mcpServers: [{ name: 'reporter', loads: false, originPath: '/p/.mcp.json' }],
  });

  test('an untrusted project shows the declaration AND that it is not loaded', () => {
    render({ scan: declaredNotLoaded });
    expect(text()).toEqual(['1 MCP server', '⚠ 1 not loaded']);
  });

  test('the same declaration on a trusted project drops the warning', () => {
    render({
      scan: scan({
        scopesLoaded: ['user', 'project', 'local'],
        mcpServers: [{ name: 'reporter', loads: true, originPath: '/p/.mcp.json' }],
      }),
    });
    expect(text()).toEqual(['1 MCP server']);
  });

  test('the warning names Trust as the reason, and says the files exist', () => {
    // Copy, deliberately pinned: the reason is the actionable half. A bare
    // "not loaded" tells the operator a number and nothing they can do.
    render({ scan: declaredNotLoaded });
    const warn = chips().find((c) => c.className.includes('is-warn'));
    expect(warn?.getAttribute('title')).toContain('not trusted');
    expect(warn?.getAttribute('title')).toContain('exist on disk');
  });

  test('the not-loaded count spans all three kinds, not just MCP servers', () => {
    render({
      scan: scan({
        mcpServers: [{ name: 'a', loads: false }],
        hooks: { declared: 2, loaded: 0, hasLocalScope: false },
        envInjections: { declared: 1, loaded: 0 },
      }),
    });
    expect(text()).toEqual(['1 MCP server', '2 hooks', '1 env override', '⚠ 4 not loaded']);
  });

  test('a partially-loaded project counts only the part that does not load', () => {
    render({
      scan: scan({
        scopesLoaded: ['user', 'project', 'local'],
        mcpServers: [
          { name: 'a', loads: true },
          { name: 'b', loads: false },
        ],
        hooks: { declared: 3, loaded: 2, hasLocalScope: false },
      }),
    });
    expect(text()).toEqual(['2 MCP servers', '3 hooks', '⚠ 2 not loaded']);
  });
});

describe('ProjectScanLine — the local-scope hook escalation', () => {
  test('a hook from settings.local.json is flagged even when it loads', () => {
    // `settings.local.json` is neither committed nor reviewed. The authority
    // panel already escalates it; a summary that stayed neutral here would be
    // quieter than the surface it summarises.
    render({
      scan: scan({
        scopesLoaded: ['user', 'project', 'local'],
        hooks: { declared: 1, loaded: 1, hasLocalScope: true },
      }),
    });
    const hookChip = chips().find((c) => c.textContent?.includes('hook'));
    expect(hookChip?.className).toContain('is-warn');
    expect(hookChip?.getAttribute('title')).toContain('settings.local.json');
  });

  test('an ordinary project hook is not flagged', () => {
    // The negative control. Without it, a variant that warns on every hook
    // would pass the case above and mean nothing.
    render({
      scan: scan({
        scopesLoaded: ['user', 'project', 'local'],
        hooks: { declared: 1, loaded: 1, hasLocalScope: false },
      }),
    });
    const hookChip = chips().find((c) => c.textContent?.includes('hook'));
    expect(hookChip?.className).not.toContain('is-warn');
  });
});

describe('ProjectScanLine — counting helpers', () => {
  test('singular and plural both read correctly', () => {
    render({ scan: scan({ mcpServers: [{ name: 'a', loads: true }] }) });
    expect(text()[0]).toBe('1 MCP server');
    render({
      scan: scan({
        mcpServers: [
          { name: 'a', loads: true },
          { name: 'b', loads: true },
        ],
      }),
    });
    expect(text()[0]).toBe('2 MCP servers');
  });

  test('declaredTotal and notLoadedTotal agree with what is rendered', () => {
    const s = scan({
      mcpServers: [
        { name: 'a', loads: true },
        { name: 'b', loads: false },
      ],
      hooks: { declared: 2, loaded: 1, hasLocalScope: false },
      envInjections: { declared: 1, loaded: 1 },
    });
    expect(declaredTotal(s)).toBe(5);
    expect(notLoadedTotal(s)).toBe(2);
  });

  test('the MCP tooltip names the servers, so the count is not a dead end', () => {
    render({
      scan: scan({
        mcpServers: [
          { name: 'alpha', loads: true },
          { name: 'beta', loads: true },
        ],
      }),
    });
    expect(chips()[0].getAttribute('title')).toBe('Declared MCP servers: alpha, beta');
  });
});

describe('ProjectScanLine — managed provenance (Cebab-ws0.9)', () => {
  const copiedAt = new Date('2026-08-20T10:00:00Z').getTime();

  test('a managed agent names what it is a copy of', () => {
    render({ scan: scan(), managed: { sourcePath: '/Users/me/agents/Cebab', copiedAt } });
    const chip = chips().find((c) => c.className.includes('is-managed'));
    expect(chip?.textContent).toContain('copy of Cebab');
  });

  test('the tooltip carries the full source path and the date', () => {
    // The chip has room for a name; the tooltip is where the operator settles
    // which of two copies of the same source this one is.
    render({ scan: scan(), managed: { sourcePath: '/Users/me/agents/Cebab', copiedAt } });
    const chip = chips().find((c) => c.className.includes('is-managed'));
    expect(chip?.getAttribute('title')).toContain('/Users/me/agents/Cebab');
    expect(chip?.getAttribute('title')).toContain('original is untouched');
  });

  test('control: an ordinary workspace project gets no managed chip', () => {
    render({ scan: scan(), managed: null });
    expect(chips().some((c) => c.className.includes('is-managed'))).toBe(false);
  });

  test('a managed agent with no scan yet still renders its chip', () => {
    // The two facts arrive independently — provenance is on the project row,
    // the scan on a sibling message. Neither should suppress the other.
    render({ scan: undefined, managed: { sourcePath: '/a/b/Thing', copiedAt } });
    expect(text()).toEqual(['copy of Thing']);
  });

  test('neither fact present renders nothing at all', () => {
    render({ scan: undefined, managed: null });
    expect(container.querySelector('.project-scan-line')).toBeNull();
  });

  test('the chip sits alongside the declaration facts, not instead of them', () => {
    render({
      scan: scan({ mcpServers: [{ name: 'a', loads: false }] }),
      managed: { sourcePath: '/a/b/Thing', copiedAt },
    });
    expect(text()).toEqual(['copy of Thing', '1 MCP server', '\u26a0 1 not loaded']);
  });
});

describe('shortSourceName', () => {
  test('takes the last segment of either separator', () => {
    expect(shortSourceName('/Users/me/agents/Cebab')).toBe('Cebab');
    expect(shortSourceName('C:\\Users\\me\\agents\\Cebab')).toBe('Cebab');
    expect(shortSourceName('/Users/me/agents/Cebab/')).toBe('Cebab');
  });

  test('a path with no separators is returned as it is', () => {
    expect(shortSourceName('Cebab')).toBe('Cebab');
  });
});
