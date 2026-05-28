// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import {
  AuthRefreshProvider,
  useAuthRefreshState,
  useAuthRefreshActions,
  type AuthRefreshState,
} from './AuthRefreshContext';

// Cluster D Phase 6c (spec §6.4 / UI-D22 follow-up): coverage for the
// AuthRefresh state machine:
//   - request_start (open + ws.send) → spawning → started → running
//   - output chunks accumulate (runId-match guarded)
//   - completed transitions to terminal completed state
//   - failed (start-time) transitions to terminal failed state
//   - cancel ships cancel_auth_refresh (server completes it)
//   - race-safety: out-of-order runId messages are ignored
//   - duplicate requestStart is dropped (no second ClientMsg)

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

type Captured = {
  state: AuthRefreshState;
  actions: ReturnType<typeof useAuthRefreshActions>;
};

function Captor({ onCapture }: { onCapture: (c: Captured) => void }) {
  const state = useAuthRefreshState();
  const actions = useAuthRefreshActions();
  onCapture({ state, actions });
  return null;
}

function setup() {
  const sent: ClientMsg[] = [];
  const send = (m: ClientMsg) => sent.push(m);
  const handlerRef: { current: ((msg: ServerMsg) => void) | null } = { current: null };
  let captured: Captured | null = null;
  act(() => {
    root.render(
      <AuthRefreshProvider send={send} handlerRef={handlerRef}>
        <Captor onCapture={(c) => (captured = c)} />
      </AuthRefreshProvider>,
    );
  });
  return { sent, handlerRef, getCaptured: (): Captured => captured! };
}

describe('AuthRefreshProvider — happy spawn→run→complete flow', () => {
  test('requestStart sends start_auth_refresh + transitions to spawning', () => {
    const { sent, getCaptured } = setup();

    act(() => {
      getCaptured().actions.requestStart();
    });

    expect(sent).toEqual([{ type: 'start_auth_refresh' }]);
    expect(getCaptured().state).toEqual({ kind: 'spawning' });
  });

  test('auth_refresh_started transitions spawning → running', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_started',
        runId: 'run-1',
        pid: 12345,
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('running');
    if (state.kind === 'running') {
      expect(state.runId).toBe('run-1');
      expect(state.pid).toBe(12345);
      expect(state.output).toBe('');
    }
  });

  test('auth_refresh_output chunks accumulate in order', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({ type: 'auth_refresh_started', runId: 'run-1', pid: 1 });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_output',
        runId: 'run-1',
        stream: 'stdout',
        text: 'Open https://login.claude.ai/...\n',
      });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_output',
        runId: 'run-1',
        stream: 'stderr',
        text: 'warning: something\n',
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('running');
    if (state.kind === 'running') {
      expect(state.output).toBe('Open https://login.claude.ai/...\nwarning: something\n');
    }
  });

  test('auth_refresh_completed (success) transitions to terminal completed', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({ type: 'auth_refresh_started', runId: 'run-1', pid: 1 });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_output',
        runId: 'run-1',
        stream: 'stdout',
        text: 'final\n',
      });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_completed',
        runId: 'run-1',
        exitCode: 0,
        success: true,
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('completed');
    if (state.kind === 'completed') {
      expect(state.runId).toBe('run-1');
      expect(state.exitCode).toBe(0);
      expect(state.success).toBe(true);
      expect(state.output).toBe('final\n');
    }
  });

  test('cancel ships cancel_auth_refresh + leaves state unchanged (server emits completed)', () => {
    const { sent, handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({ type: 'auth_refresh_started', runId: 'run-1', pid: 1 });
    });
    act(() => {
      getCaptured().actions.cancel();
    });
    expect(sent).toContainEqual({ type: 'cancel_auth_refresh', runId: 'run-1' });
    // State remains running until the server's completed envelope lands.
    expect(getCaptured().state.kind).toBe('running');

    // Server then emits completed (from the kill triggering child.on('exit')).
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_completed',
        runId: 'run-1',
        exitCode: null,
        success: false,
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('completed');
    if (state.kind === 'completed') {
      expect(state.exitCode).toBeNull();
      expect(state.success).toBe(false);
    }
  });

  test('close action returns to idle from any state', () => {
    const { getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    expect(getCaptured().state.kind).toBe('spawning');
    act(() => {
      getCaptured().actions.close();
    });
    expect(getCaptured().state).toEqual({ kind: 'idle' });
  });
});

describe('AuthRefreshProvider — start-time failure', () => {
  test('auth_refresh_failed (already_running) transitions spawning → failed', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_failed',
        reason: 'already_running',
        existingRunId: 'other-tab-run',
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason).toBe('already_running');
      expect(state.existingRunId).toBe('other-tab-run');
    }
  });

  test('auth_refresh_failed (spawn_failed) carries error message', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_failed',
        reason: 'spawn_failed',
        error: 'ENOENT: claude not found',
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.reason).toBe('spawn_failed');
      expect(state.error).toContain('ENOENT');
    }
  });
});

describe('AuthRefreshProvider — race safety', () => {
  test('auth_refresh_output for a different runId is ignored', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({ type: 'auth_refresh_started', runId: 'run-1', pid: 1 });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_output',
        runId: 'wrong-run-id',
        stream: 'stdout',
        text: 'should-be-ignored',
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('running');
    if (state.kind === 'running') {
      expect(state.output).toBe('');
    }
  });

  test('auth_refresh_completed for a different runId is ignored', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      handlerRef.current?.({ type: 'auth_refresh_started', runId: 'run-1', pid: 1 });
    });
    act(() => {
      handlerRef.current?.({
        type: 'auth_refresh_completed',
        runId: 'wrong-run-id',
        exitCode: 0,
        success: true,
      });
    });
    expect(getCaptured().state.kind).toBe('running');
  });

  test('duplicate requestStart while one is in flight is dropped', () => {
    const { sent, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      getCaptured().actions.requestStart();
    });
    expect(sent).toEqual([{ type: 'start_auth_refresh' }]);
    expect(getCaptured().state).toEqual({ kind: 'spawning' });
  });

  test('cancel from non-running state is a no-op', () => {
    const { sent, getCaptured } = setup();
    // From idle
    act(() => {
      getCaptured().actions.cancel();
    });
    expect(sent).toEqual([]);
    // From spawning
    act(() => {
      getCaptured().actions.requestStart();
    });
    act(() => {
      getCaptured().actions.cancel();
    });
    // Only start, no cancel
    expect(sent).toEqual([{ type: 'start_auth_refresh' }]);
  });
});

describe('AuthRefreshProvider — hook guards', () => {
  test('useAuthRefreshState outside provider throws', () => {
    expect(() => {
      function BadCaptor() {
        useAuthRefreshState();
        return null;
      }
      act(() => {
        root.render(<BadCaptor />);
      });
    }).toThrow();
  });

  test('useAuthRefreshActions outside provider throws', () => {
    expect(() => {
      function BadCaptor() {
        useAuthRefreshActions();
        return null;
      }
      act(() => {
        root.render(<BadCaptor />);
      });
    }).toThrow();
  });
});
