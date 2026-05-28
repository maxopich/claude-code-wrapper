// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useEffect, useRef } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import {
  ForensicViewerProvider,
  forensicViewerReducer,
  initialForensicViewerState,
  useForensicViewerActions,
  useForensicViewerState,
} from './ForensicViewerContext';

// Cluster C Phase 4g4: state machine + handlerRef bridge for the
// KickForensicsModal.
//
// Coverage:
//   - reducer: open → loading; snapshot for the open key → ready;
//     close → closed; stale snapshot (different key) dropped.
//   - provider: open() dispatches both the reducer transition AND the
//     `get_kick_forensics` ClientMsg.
//   - provider: handlerRef routes `kick_forensics_snapshot` into the
//     reducer.

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

describe('forensicViewerReducer', () => {
  test('open transitions closed → loading with key', () => {
    const after = forensicViewerReducer(initialForensicViewerState, {
      type: 'open',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
    });
    expect(after).toEqual({
      kind: 'loading',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
    });
  });

  test('snapshot for the open key transitions to ready', () => {
    let s = forensicViewerReducer(initialForensicViewerState, {
      type: 'open',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
    });
    s = forensicViewerReducer(s, {
      type: 'snapshot',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
      found: true,
      snapshot: null,
    });
    expect(s.kind).toBe('ready');
    if (s.kind !== 'ready') return;
    expect(s.found).toBe(true);
  });

  test('snapshot for a stale key is dropped', () => {
    const open = forensicViewerReducer(initialForensicViewerState, {
      type: 'open',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
    });
    const after = forensicViewerReducer(open, {
      type: 'snapshot',
      sessionId: 'sess-other',
      agentSlug: 'worker-b',
      found: true,
      snapshot: null,
    });
    // No transition — still loading for the original key.
    expect(after).toBe(open);
  });

  test('snapshot when closed is dropped', () => {
    const after = forensicViewerReducer(initialForensicViewerState, {
      type: 'snapshot',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
      found: true,
      snapshot: null,
    });
    expect(after).toBe(initialForensicViewerState);
  });

  test('close transitions back to closed', () => {
    const open = forensicViewerReducer(initialForensicViewerState, {
      type: 'open',
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
    });
    const after = forensicViewerReducer(open, { type: 'close' });
    expect(after).toEqual({ kind: 'closed' });
  });
});

// Probe components — expose the context value to tests.
function StateProbe({ onState }: { onState: (s: ReturnType<typeof useForensicViewerState>) => void }) {
  const s = useForensicViewerState();
  onState(s);
  return null;
}

function ActionsProbe({
  capture,
}: {
  capture: (actions: ReturnType<typeof useForensicViewerActions>) => void;
}) {
  const a = useForensicViewerActions();
  useEffect(() => {
    capture(a);
  }, [a, capture]);
  return null;
}

describe('ForensicViewerProvider — open dispatches both reducer + ClientMsg', () => {
  test('open() ships get_kick_forensics + transitions to loading', () => {
    const sent: ClientMsg[] = [];
    const states: ReturnType<typeof useForensicViewerState>[] = [];
    let actions: ReturnType<typeof useForensicViewerActions> | null = null;
    act(() => {
      root.render(
        <ForensicViewerProvider send={(m) => sent.push(m)}>
          <StateProbe onState={(s) => states.push(s)} />
          <ActionsProbe capture={(a) => (actions = a)} />
        </ForensicViewerProvider>,
      );
    });
    expect(actions).not.toBeNull();
    act(() => {
      actions!.open('sess-1', 'worker-a');
    });
    expect(sent).toEqual([
      { type: 'get_kick_forensics', sessionId: 'sess-1', agentSlug: 'worker-a' },
    ]);
    const last = states[states.length - 1];
    expect(last.kind).toBe('loading');
  });

  test('handlerRef routes kick_forensics_snapshot into the reducer', () => {
    const handlerRef: React.MutableRefObject<((msg: ServerMsg) => void) | null> = {
      current: null,
    };
    const states: ReturnType<typeof useForensicViewerState>[] = [];
    let actions: ReturnType<typeof useForensicViewerActions> | null = null;
    function Bridge() {
      const localRef = useRef<((msg: ServerMsg) => void) | null>(null);
      useEffect(() => {
        handlerRef.current = localRef.current;
      });
      return (
        <ForensicViewerProvider send={() => {}} handlerRef={localRef as never}>
          <StateProbe onState={(s) => states.push(s)} />
          <ActionsProbe capture={(a) => (actions = a)} />
        </ForensicViewerProvider>
      );
    }
    act(() => {
      root.render(<Bridge />);
    });
    // Open so a snapshot will land.
    act(() => {
      actions!.open('sess-9', 'worker-z');
    });
    expect(handlerRef.current).not.toBeNull();
    act(() => {
      handlerRef.current!({
        type: 'kick_forensics_snapshot',
        sessionId: 'sess-9',
        agentSlug: 'worker-z',
        found: false,
        snapshot: null,
      });
    });
    const last = states[states.length - 1];
    expect(last.kind).toBe('ready');
    if (last.kind !== 'ready') return;
    expect(last.found).toBe(false);
  });
});
