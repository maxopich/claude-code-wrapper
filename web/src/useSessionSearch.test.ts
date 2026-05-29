// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientMsg, SearchResult, ServerMsg } from '@cebab/shared';
import {
  useSessionSearch,
  type SessionSearchState,
  type UseSessionSearchOpts,
} from './useSessionSearch';

// Cluster I C4 UI: the data hook behind SessionSearchModal. We drive it through
// a tiny null-rendering harness (the repo's no-testing-library convention) and
// fake timers for the debounce.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

// Captured across renders.
let latest: SessionSearchState;
let subCb: ((m: ServerMsg) => void) | null;
let sent: ClientMsg[];

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  sent = [];
  subCb = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

type HarnessProps = Pick<UseSessionSearchOpts, 'scope' | 'projectId' | 'includeArchived' | 'raw'>;

function Harness(props: HarnessProps) {
  latest = useSessionSearch({
    send: (m) => sent.push(m),
    subscribeServerMsg: (cb) => {
      subCb = cb;
      return () => {
        subCb = null;
      };
    },
    scope: props.scope,
    projectId: props.projectId,
    includeArchived: props.includeArchived,
    raw: props.raw,
    debounceMs: 50,
  });
  return null;
}

function render(props: Partial<HarnessProps> = {}) {
  const full: HarnessProps = {
    scope: 'all_projects',
    includeArchived: false,
    raw: false,
    ...props,
  };
  act(() => {
    root.render(createElement(Harness, full));
  });
}

function type(q: string) {
  act(() => latest.setQuery(q));
}
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}
function reply(overrides: Partial<Extract<ServerMsg, { type: 'search_results' }>>) {
  const msg = {
    type: 'search_results' as const,
    query: 'mig',
    scope: 'all_projects' as const,
    results: [] as SearchResult[],
    raw: false,
    truncated: false,
    ...overrides,
  };
  act(() => subCb?.(msg));
}

function hit(id: string): SearchResult {
  return {
    sessionId: id,
    projectId: 1,
    projectName: 'p',
    ts: 1000,
    snippet: `…migration in ${id}…`,
    matchedField: 'events.raw',
    matchedKind: 'assistant',
  };
}

const lastSent = () => sent.at(-1) as Extract<ClientMsg, { type: 'search_sessions' }> | undefined;

describe('useSessionSearch — dispatch', () => {
  test('sends search_sessions after the debounce with trimmed query + flags', () => {
    render({ scope: 'all_projects', includeArchived: false, raw: false });
    type('  mig  ');
    expect(sent).toHaveLength(0); // not yet — debounce pending
    advance(50);
    expect(sent).toHaveLength(1);
    expect(lastSent()).toMatchObject({
      type: 'search_sessions',
      query: 'mig',
      scope: 'all_projects',
      includeArchived: false,
      raw: false,
    });
    expect(lastSent()).not.toHaveProperty('projectId');
  });

  test('this_project scope includes the projectId', () => {
    render({ scope: 'this_project', projectId: 7 });
    type('foo');
    advance(50);
    expect(lastSent()).toMatchObject({ scope: 'this_project', projectId: 7 });
  });

  test('raw flag is forwarded', () => {
    render({ raw: true });
    type('secret');
    advance(50);
    expect(lastSent()?.raw).toBe(true);
  });

  test(`sub-2-char queries never dispatch and clear results`, () => {
    render();
    type('mig');
    advance(50);
    reply({ query: 'mig', results: [hit('s1')] });
    expect(latest.results).toHaveLength(1);
    // Now shorten below the floor.
    type('a');
    advance(50);
    expect(latest.results).toEqual([]);
    expect(latest.loading).toBe(false);
    // Only the first (valid) query produced a dispatch.
    expect(sent).toHaveLength(1);
  });

  test('rapid typing coalesces to a single dispatch for the final value', () => {
    render();
    type('mi');
    advance(20); // < debounce, timer still pending
    type('mig');
    advance(50);
    expect(sent).toHaveLength(1);
    expect(lastSent()?.query).toBe('mig');
  });
});

describe('useSessionSearch — reply handling', () => {
  test('accepts a reply whose echoed (query, scope, raw) matches the dispatch', () => {
    render({ scope: 'all_projects', raw: false });
    type('mig');
    advance(50);
    expect(latest.loading).toBe(true);
    reply({
      query: 'mig',
      scope: 'all_projects',
      raw: false,
      results: [hit('s1')],
      truncated: true,
    });
    expect(latest.results.map((r) => r.sessionId)).toEqual(['s1']);
    expect(latest.truncated).toBe(true);
    expect(latest.raw).toBe(false);
    expect(latest.loading).toBe(false);
  });

  test('discards a stale reply for a superseded query', () => {
    render();
    type('mig');
    advance(50);
    reply({ query: 'OLD', results: [hit('stale')] });
    expect(latest.results).toEqual([]);
    expect(latest.loading).toBe(true); // still waiting for the live reply
  });

  test('accepts a server DOWNGRADE (raw requested, reply redacted) — not keyed on raw', () => {
    // The server downgrades a raw:true request to redacted when its audit
    // write fails. The reply echoes raw:false; we must accept it (keying on
    // raw would discard it and show nothing) and surface the downgrade.
    render({ raw: true });
    type('mig');
    advance(50);
    reply({ query: 'mig', scope: 'all_projects', raw: false, results: [hit('x')] });
    expect(latest.results.map((r) => r.sessionId)).toEqual(['x']);
    expect(latest.raw).toBe(false); // UI can now show "downgraded to redacted"
  });

  test('discards a reply for a different scope', () => {
    render({ scope: 'all_projects' });
    type('mig');
    advance(50);
    reply({ query: 'mig', scope: 'this_project', results: [hit('wrong')] });
    expect(latest.results).toEqual([]);
  });
});
