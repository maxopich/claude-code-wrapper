// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LogRowKind, SessionLogScope } from '@cebab/shared/protocol';
import type { LogFiltersHandle } from './useLogFilters';
import { LogToolbar } from './LogToolbar';

// Cluster H C3 UI — pins LogToolbar's scope-aware rendering:
//
//   1. Default scope (multi-agent / undefined): Agent multi-select renders,
//      all five LogRowKind chips render (bus, tool, llm, error, artifact).
//   2. Single-agent scope: Agent multi-select hides; Kinds dropdown contains
//      only the single-agent projector's kinds (`tool | llm | error`); `bus`
//      and `artifact` chips do NOT appear because the projector never emits
//      them.
//   3. The visible-kinds restriction is structural, not state-driven — the
//      operator can't toggle the hidden chips.

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

function makeFilters(): LogFiltersHandle {
  return {
    search: '',
    agents: new Set(),
    kinds: new Set<LogRowKind>(),
    setSearch: () => {},
    toggleAgent: () => {},
    toggleKind: () => {},
    reset: () => {},
  };
}

function renderToolbar(scope?: SessionLogScope, agents: string[] = []) {
  act(() => {
    root.render(
      <LogToolbar
        filters={makeFilters()}
        agents={agents}
        scope={scope}
        revealedSensitive={false}
        loading={false}
        onRevealSensitive={() => {}}
        onRefresh={() => {}}
        onDownload={() => {}}
      />,
    );
  });
}

function kindLabels(): string[] {
  return Array.from(container.querySelectorAll('.logs-filter-dropdown')).flatMap((d) => {
    const summary = d.querySelector('summary');
    if (summary?.textContent?.includes('Kinds') !== true) return [];
    return Array.from(d.querySelectorAll('.logs-filter-option span'))
      .map((s) => s.textContent ?? '')
      .filter((s) => s.length > 0);
  });
}

function hasAgentDropdown(): boolean {
  return Array.from(container.querySelectorAll('.logs-filter-dropdown')).some((d) => {
    const summary = d.querySelector('summary');
    return summary?.textContent?.includes('Agents') === true;
  });
}

describe('LogToolbar — default (multi-agent / undefined) scope', () => {
  test('renders the Agents dropdown', () => {
    renderToolbar(undefined, ['worker', 'reviewer']);
    expect(hasAgentDropdown()).toBe(true);
  });

  test('renders ALL five LogRowKind chips', () => {
    renderToolbar(undefined);
    const labels = kindLabels();
    expect(new Set(labels)).toEqual(new Set(['tool', 'bus', 'llm', 'error', 'artifact']));
  });

  test('explicit scope="multi_agent" matches the undefined default', () => {
    renderToolbar('multi_agent', ['worker']);
    expect(hasAgentDropdown()).toBe(true);
    expect(new Set(kindLabels())).toEqual(new Set(['tool', 'bus', 'llm', 'error', 'artifact']));
  });
});

describe('LogToolbar — single-agent scope', () => {
  test('hides the Agents dropdown entirely', () => {
    renderToolbar('single', ['agent']);
    expect(hasAgentDropdown()).toBe(false);
  });

  test('restricts the Kinds dropdown to tool / llm / error', () => {
    renderToolbar('single');
    expect(new Set(kindLabels())).toEqual(new Set(['tool', 'llm', 'error']));
  });

  test('omits bus + artifact chips (the projector never emits them)', () => {
    renderToolbar('single');
    const labels = kindLabels();
    expect(labels).not.toContain('bus');
    expect(labels).not.toContain('artifact');
  });
});
