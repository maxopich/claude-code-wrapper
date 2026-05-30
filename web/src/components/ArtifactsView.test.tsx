// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientMsg, MultiAgentMutationView, ServerMsg } from '@cebab/shared';
import type { MultiAgentRun } from '../store';
import { ArtifactsView } from './ArtifactsView';

// Cluster I H3 UI: the ArtifactsView "▸ View latest content" disclosure — lazy
// fetch (H3-2), redacted badge + truncated hint (H3-3/H3-4), error + retry, and
// the disabled v2 diff scaffold (H3-5). Raw createRoot + act, repo convention.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let sent: ClientMsg[];
let subCb: ((m: ServerMsg) => void) | null;

beforeEach(() => {
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
});

function mut(over: Partial<MultiAgentMutationView> = {}): MultiAgentMutationView {
  return {
    id: 1,
    sessionId: 's1',
    ts: 1000,
    agentName: 'worker',
    toolName: 'Write',
    category: 'mutate',
    summary: 'wrote the plan',
    filePath: '/ws/plan.md',
    cwd: '/ws',
    confirmedAt: 1000,
    promoted: true,
    ...over,
  };
}

function renderView(mutations: MultiAgentMutationView[]) {
  const run = { sessionId: 's1', mutations } as unknown as MultiAgentRun;
  act(() => {
    root.render(
      <ArtifactsView
        run={run}
        send={(m) => sent.push(m)}
        subscribeServerMsg={(cb) => {
          subCb = cb;
          return () => {
            subCb = null;
          };
        }}
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

function reply(overrides: Partial<Extract<ServerMsg, { type: 'artifact_content' }>>) {
  const msg = {
    type: 'artifact_content' as const,
    mutationId: 1,
    content: '',
    mtime: 0,
    size: 0,
    ...overrides,
  };
  act(() => subCb?.(msg));
}

const toggle = () =>
  container.querySelector('.artifact-content-toggle') as HTMLButtonElement | null;
const lastSearch = () =>
  sent.filter((m) => m.type === 'get_artifact_content').at(-1) as
    | Extract<ClientMsg, { type: 'get_artifact_content' }>
    | undefined;

describe('ArtifactsView content disclosure (H3 UI)', () => {
  test('renders an artifact row + a collapsed content toggle, with NO fetch yet (lazy)', () => {
    renderView([mut()]);
    expect(container.querySelector('.artifacts-row')).not.toBeNull();
    expect(toggle()).not.toBeNull();
    expect(toggle()?.textContent).toContain('View latest content');
    // Lazy: nothing fetched until the operator expands.
    expect(sent.filter((m) => m.type === 'get_artifact_content')).toHaveLength(0);
    expect(container.querySelector('.artifact-content-pre')).toBeNull();
  });

  test('expanding lazily fetches the latest mutation content', () => {
    renderView([mut({ id: 42 })]);
    click(toggle());
    expect(lastSearch()).toEqual({ type: 'get_artifact_content', mutationId: 42 });
    expect(container.querySelector('.artifact-content-hint')?.textContent).toContain('Loading');
  });

  test('renders content + redacted badge + truncated hint on reply', () => {
    renderView([mut({ id: 42 })]);
    click(toggle());
    reply({
      mutationId: 42,
      content: 'the file body',
      size: 13,
      truncated: true,
      redactedFields: ['line:3'],
    });
    expect(container.querySelector('.artifact-content-pre')?.textContent).toBe('the file body');
    expect(container.querySelector('.artifact-content-redacted')).not.toBeNull();
    expect(container.querySelector('.artifact-content-truncated')).not.toBeNull();
  });

  test('an error reply shows a message + Retry that re-fetches', () => {
    renderView([mut({ id: 42 })]);
    click(toggle());
    reply({ mutationId: 42, error: 'read_failed' });
    expect(container.querySelector('.artifact-content-error')).not.toBeNull();

    const retry = Array.from(container.querySelectorAll('.artifact-content-error button')).find(
      (b) => b.textContent?.includes('Retry'),
    );
    click(retry ?? null);
    expect(sent.filter((m) => m.type === 'get_artifact_content')).toHaveLength(2);
  });

  test('the v2 Diff affordance is disabled with the coming-in-v2 tooltip (H3-5)', () => {
    renderView([mut()]);
    click(toggle());
    const diff = container.querySelector('.artifact-content-diff-btn') as HTMLButtonElement | null;
    expect(diff).not.toBeNull();
    expect(diff?.disabled).toBe(true);
    expect(diff?.title).toContain('v2');
  });

  test('does not fetch again when collapsed and re-expanded after a load', () => {
    renderView([mut({ id: 42 })]);
    click(toggle()); // open → fetch #1
    reply({ mutationId: 42, content: 'x', size: 1 });
    click(toggle()); // collapse
    click(toggle()); // re-open — status is 'loaded', so no re-fetch
    expect(sent.filter((m) => m.type === 'get_artifact_content')).toHaveLength(1);
  });
});
