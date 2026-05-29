// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientMsg, SearchResult, ServerMsg } from '@cebab/shared';
import { RAW_ACK_PHRASE, SessionSearchModal } from './SessionSearchModal';

// Cluster I C4 UI: end-to-end coverage for the Cmd/Ctrl+P search modal —
// scope chips (C4-2), result navigation (C4-4), the raw typed-ack gate (C4-3),
// and the redacted/truncated affordances. Raw createRoot + act + fake timers
// (the debounce lives in useSessionSearch), matching the repo convention.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let sent: ClientMsg[];
let subCb: ((m: ServerMsg) => void) | null;
let onNavigate: ReturnType<typeof vi.fn<(r: SearchResult) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  sent = [];
  subCb = null;
  onNavigate = vi.fn<(r: SearchResult) => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(opts: { activeProjectId: number | null }) {
  act(() => {
    root.render(
      <SessionSearchModal
        onClose={onClose}
        send={(m) => sent.push(m)}
        subscribeServerMsg={(cb) => {
          subCb = cb;
          return () => {
            subCb = null;
          };
        }}
        activeProjectId={opts.activeProjectId}
        onNavigate={onNavigate}
      />,
    );
  });
}

function click(el: Element | null) {
  if (!el) throw new Error('click target missing');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function keyDown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function input(): HTMLInputElement {
  return container.querySelector('.session-search-input') as HTMLInputElement;
}
function chip(label: string): HTMLButtonElement | null {
  return (Array.from(container.querySelectorAll('.session-search-chip')).find(
    (b) => b.textContent?.trim() === label,
  ) ?? null) as HTMLButtonElement | null;
}
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll('.session-search-result'));
}
function lastSearch(): Extract<ClientMsg, { type: 'search_sessions' }> | undefined {
  const hits = sent.filter((m) => m.type === 'search_sessions');
  return hits.at(-1) as Extract<ClientMsg, { type: 'search_sessions' }> | undefined;
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

function hit(id: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    sessionId: id,
    projectId: 1,
    projectName: 'demo',
    ts: 1000,
    snippet: `…the migration plan in ${id}…`,
    matchedField: 'events.raw',
    matchedKind: 'assistant',
    ...extra,
  };
}

describe('SessionSearchModal — scaffold + scope chips (C4-2)', () => {
  test('renders the input + both scope chips; This project enabled iff a project is active', () => {
    render({ activeProjectId: 5 });
    expect(input()).not.toBeNull();
    expect(chip('This project')?.disabled).toBe(false);
    expect(chip('All projects')).not.toBeNull();
    // Active project → defaults to this_project.
    expect(chip('This project')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('This project chip is disabled and scope defaults to all_projects with no active project', () => {
    render({ activeProjectId: null });
    expect(chip('This project')?.disabled).toBe(true);
    expect(chip('All projects')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SessionSearchModal — dispatch + scope/archived (C4-2)', () => {
  test('typing dispatches search_sessions with the active scope + projectId', () => {
    render({ activeProjectId: 5 });
    setValue(input(), 'mig');
    advance(200);
    expect(lastSearch()).toMatchObject({ query: 'mig', scope: 'this_project', projectId: 5 });
  });

  test('switching to All projects re-dispatches without projectId', () => {
    render({ activeProjectId: 5 });
    setValue(input(), 'mig');
    advance(200);
    click(chip('All projects'));
    advance(200);
    expect(lastSearch()?.scope).toBe('all_projects');
    expect(lastSearch()).not.toHaveProperty('projectId');
  });

  test('Include archived composes into the dispatch', () => {
    render({ activeProjectId: 5 });
    setValue(input(), 'mig');
    advance(200);
    const archived = container.querySelector('.session-search-archived input') as HTMLInputElement;
    click(archived);
    advance(200);
    expect(lastSearch()?.includeArchived).toBe(true);
  });
});

describe('SessionSearchModal — results + navigation (C4-4)', () => {
  test('renders result rows from a reply and navigates on click', () => {
    render({ activeProjectId: 1 });
    setValue(input(), 'mig');
    advance(200);
    reply({ query: 'mig', scope: 'this_project', results: [hit('s1'), hit('s2')] });

    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain('demo');

    click(rows()[1]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]![0].sessionId).toBe('s2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('ArrowDown moves the selection and Enter navigates the selected row', () => {
    render({ activeProjectId: 1 });
    setValue(input(), 'mig');
    advance(200);
    reply({ query: 'mig', scope: 'this_project', results: [hit('s1'), hit('s2')] });

    keyDown(input(), 'ArrowDown'); // select index 1
    expect(rows()[1]?.classList.contains('selected')).toBe(true);
    keyDown(input(), 'Enter');
    expect(onNavigate.mock.calls[0]![0].sessionId).toBe('s2');
  });

  test('redacted badge shows when a hit carries redactedFields; truncated hint when capped', () => {
    render({ activeProjectId: 1 });
    setValue(input(), 'mig');
    advance(200);
    reply({
      query: 'mig',
      scope: 'this_project',
      results: [hit('s1', { redactedFields: ['api_key'] })],
      truncated: true,
    });
    expect(container.querySelector('.session-search-redacted-badge')).not.toBeNull();
    expect(container.querySelector('.session-search-truncated')).not.toBeNull();
  });

  test('shows the too-short hint until 2 characters are typed', () => {
    render({ activeProjectId: 1 });
    expect(container.querySelector('.session-search-hint')?.textContent).toContain('at least');
    setValue(input(), 'm');
    advance(200);
    expect(lastSearch()).toBeUndefined(); // never dispatched
  });
});

describe('SessionSearchModal — raw opt-in typed-ack gate (C4-3)', () => {
  function rawLink(): HTMLButtonElement | null {
    return (Array.from(container.querySelectorAll('.session-search-raw-link')).find((b) =>
      b.textContent?.includes('unredacted'),
    ) ?? null) as HTMLButtonElement | null;
  }

  test('raw search stays gated until the ack phrase is typed verbatim', () => {
    render({ activeProjectId: 1 });
    setValue(input(), 'secret');
    advance(200);
    expect(lastSearch()?.raw).toBe(false);

    click(rawLink());
    const ack = container.querySelector('.session-search-raw-ack') as HTMLInputElement;
    const confirm = container.querySelector('.session-search-raw-confirm') as HTMLButtonElement;
    expect(ack).not.toBeNull();
    expect(confirm.disabled).toBe(true);

    // Wrong phrase keeps it gated.
    setValue(ack, 'whatever');
    expect(
      (container.querySelector('.session-search-raw-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);

    // Exact phrase arms it; the next dispatch is raw.
    setValue(ack, RAW_ACK_PHRASE);
    expect(
      (container.querySelector('.session-search-raw-confirm') as HTMLButtonElement).disabled,
    ).toBe(false);
    click(container.querySelector('.session-search-raw-confirm'));
    advance(200);

    expect(lastSearch()?.raw).toBe(true);
    expect(container.querySelector('.session-search-raw-pill')?.textContent).toBe('RAW');
  });
});
