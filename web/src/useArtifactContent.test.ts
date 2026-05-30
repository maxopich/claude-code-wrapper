// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientMsg, ServerMsg } from '@cebab/shared';
import { useArtifactContent, type ArtifactContentState } from './useArtifactContent';

// Cluster I H3 UI: the data hook behind the ArtifactsView content disclosure.
// Driven through a null-rendering harness (the repo's no-testing-library
// convention). No fake timers — the hook has no debounce; it fetches only when
// `load()` is called.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let latest: ArtifactContentState;
let subCb: ((m: ServerMsg) => void) | null;
let sent: ClientMsg[];

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

function Harness(props: { mutationId: number }) {
  latest = useArtifactContent({
    mutationId: props.mutationId,
    send: (m) => sent.push(m),
    subscribeServerMsg: (cb) => {
      subCb = cb;
      return () => {
        subCb = null;
      };
    },
  });
  return null;
}

function render(mutationId = 7) {
  act(() => {
    root.render(createElement(Harness, { mutationId }));
  });
}

function reply(overrides: Partial<Extract<ServerMsg, { type: 'artifact_content' }>>) {
  const msg = {
    type: 'artifact_content' as const,
    mutationId: 7,
    content: '',
    mtime: 0,
    size: 0,
    ...overrides,
  };
  act(() => subCb?.(msg));
}

const lastSent = () =>
  sent.at(-1) as Extract<ClientMsg, { type: 'get_artifact_content' }> | undefined;

describe('useArtifactContent', () => {
  test('does NOT fetch on mount — lazy (H3-2)', () => {
    render(7);
    expect(sent).toHaveLength(0);
    expect(latest.status).toBe('idle');
  });

  test('load() sends get_artifact_content for the mutationId and flips to loading', () => {
    render(7);
    act(() => latest.load());
    expect(sent).toHaveLength(1);
    expect(lastSent()).toEqual({ type: 'get_artifact_content', mutationId: 7 });
    expect(latest.status).toBe('loading');
  });

  test('accepts a reply matching the mutationId', () => {
    render(7);
    act(() => latest.load());
    reply({
      mutationId: 7,
      content: 'hello world',
      size: 11,
      mtime: 1000,
      truncated: true,
      redactedFields: ['line:2'],
    });
    expect(latest.status).toBe('loaded');
    expect(latest.content).toBe('hello world');
    expect(latest.size).toBe(11);
    expect(latest.truncated).toBe(true);
    expect(latest.redactedFields).toEqual(['line:2']);
    expect(latest.error).toBeUndefined();
  });

  test('ignores a reply for a different mutationId', () => {
    render(7);
    act(() => latest.load());
    reply({ mutationId: 999, content: 'not mine' });
    expect(latest.status).toBe('loading'); // still waiting for OUR reply
    expect(latest.content).toBe('');
  });

  test('an error reply sets the error status', () => {
    render(7);
    act(() => latest.load());
    reply({ mutationId: 7, error: 'read_failed' });
    expect(latest.status).toBe('error');
    expect(latest.error).toBe('read_failed');
  });

  test('retry (load again) re-sends and clears the error', () => {
    render(7);
    act(() => latest.load());
    reply({ mutationId: 7, error: 'read_failed' });
    expect(latest.status).toBe('error');
    act(() => latest.load());
    expect(sent).toHaveLength(2);
    expect(latest.status).toBe('loading');
    expect(latest.error).toBeUndefined();
  });

  // Cebab Security Reviewer (PR #193): confirm the subscribe effect's cleanup
  // ALWAYS fires — every `subscribeServerMsg(cb)` is paired 1:1 with its
  // returned unsubscribe, so neither an unmount nor a remount loop (mutationId
  // churn → effect re-run) can leak `artifact_content` listeners. Self-contained
  // root so the live-subscription count is asserted directly, independent of the
  // shared harness.
  test('[security] subscribe/unsubscribe are paired across remounts + unmount (no listener leak)', () => {
    let subs = 0;
    let unsubs = 0;
    const c = document.createElement('div');
    document.body.appendChild(c);
    let r!: Root;
    act(() => {
      r = createRoot(c);
    });

    function Probe({ id }: { id: number }) {
      useArtifactContent({
        mutationId: id,
        send: () => {},
        subscribeServerMsg: () => {
          subs++;
          return () => {
            unsubs++;
          };
        },
      });
      return null;
    }

    act(() => {
      r.render(createElement(Probe, { id: 1 }));
    });
    expect(subs - unsubs).toBe(1); // exactly one live subscription after mount

    // The reviewer's "remount loop": each mutationId change re-runs the effect.
    // The old subscription must be cleaned up before the new one is added, so
    // the live count never climbs past one.
    for (const id of [2, 3, 4, 5]) {
      act(() => {
        r.render(createElement(Probe, { id }));
      });
      expect(subs - unsubs).toBe(1);
    }
    expect(subs).toBe(5); // mount + 4 churns

    act(() => {
      r.unmount();
    });
    expect(subs - unsubs).toBe(0); // unmount cleaned up the last → zero leaked
    expect(unsubs).toBe(5);
    c.remove();
  });
});
