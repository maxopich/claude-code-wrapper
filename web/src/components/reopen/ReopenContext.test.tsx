// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg, WorkspaceDiff } from '@cebab/shared/protocol';
import {
  ReopenProvider,
  isValidationFailure,
  useReopenState,
  useReopenActions,
  type ReopenState,
} from './ReopenContext';

// Cluster D Phase 5d — coverage for the reopen state machine:
//   - probe (open + ws.send) → confirm_required → confirming
//   - submit → committing → success closes the modal
//   - validation failures revert committing → confirming with inline error
//   - hard failures land terminal `failed` state
//   - race-safety: out-of-order sessionId messages are ignored

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
  state: ReopenState;
  actions: ReturnType<typeof useReopenActions>;
  bridge: ((msg: ServerMsg) => void) | null;
};

const DIRTY: WorkspaceDiff = {
  filesChanged: 2,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: ['a.txt', 'b.txt'],
  fullDiffAvailable: true,
};

const CLEAN: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: true,
};

function Captor({ onCapture }: { onCapture: (c: Captured) => void }) {
  const state = useReopenState();
  const actions = useReopenActions();
  // Bridge captured via a ref so the test can simulate incoming
  // ServerMsgs without standing up a real WS.
  onCapture({ state, actions, bridge: null });
  return null;
}

function setup() {
  const sent: ClientMsg[] = [];
  const send = (m: ClientMsg) => sent.push(m);
  const handlerRef: { current: ((msg: ServerMsg) => void) | null } = { current: null };
  let captured: Captured | null = null;
  act(() => {
    root.render(
      <ReopenProvider send={send} handlerRef={handlerRef}>
        <Captor onCapture={(c) => (captured = c)} />
      </ReopenProvider>,
    );
  });
  return { sent, handlerRef, getCaptured: (): Captured => captured! };
}

describe('isValidationFailure', () => {
  test('ack_required + typed_confirmation_required → true', () => {
    expect(isValidationFailure('ack_required')).toBe(true);
    expect(isValidationFailure('typed_confirmation_required')).toBe(true);
  });

  test('hard reasons → false', () => {
    expect(isValidationFailure('not_found')).toBe(false);
    expect(isValidationFailure('still_running')).toBe(false);
    expect(isValidationFailure('no_participant')).toBe(false);
    expect(isValidationFailure('chain_reconstruction_unsupported')).toBe(false);
    expect(isValidationFailure('reactivate_failed')).toBe(false);
  });
});

describe('ReopenProvider — happy probe→confirm→commit flow', () => {
  test('requestReopen sends probe + transitions to probing', () => {
    const { sent, getCaptured } = setup();

    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });

    expect(sent).toEqual([{ type: 'reopen_session', sessionId: 's-target' }]);
    expect(getCaptured().state).toEqual({ kind: 'probing', sessionId: 's-target' });
  });

  test('confirm_required transitions probing → confirming', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/myproj',
        workspaceDiff: DIRTY,
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('confirming');
    if (state.kind === 'confirming') {
      expect(state.projectPath).toBe('/myproj');
      expect(state.diff).toEqual(DIRTY);
    }
  });

  test('confirm sends reopen_session_confirmed + transitions to committing', () => {
    const { sent, handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/p',
        workspaceDiff: DIRTY,
      });
    });
    act(() => {
      getCaptured().actions.confirm({
        acknowledgedWorkspaceDiff: true,
        typedConfirmation: 'reopen',
      });
    });
    expect(sent).toContainEqual({
      type: 'reopen_session_confirmed',
      sessionId: 's-target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
    });
    expect(getCaptured().state.kind).toBe('committing');
  });

  test('multi_agent_started for the target closes the modal (idle)', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/p',
        workspaceDiff: CLEAN,
      });
    });
    act(() => {
      getCaptured().actions.confirm({ acknowledgedWorkspaceDiff: true });
    });
    // Server replies multi_agent_started post-adopt
    act(() => {
      handlerRef.current?.({
        type: 'multi_agent_started',
        sessionId: 's-target',
        mode: 'orchestrator',
        participants: [],
        participantAgentNames: [],
        lifecycle: 'persistent',
        sessionFolder: '/tmp/sf',
        hopBudget: 100,
        awaitingContinue: false,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      });
    });
    expect(getCaptured().state).toEqual({ kind: 'idle' });
  });

  test('confirm omits typedConfirmation when not supplied (clean workspace path)', () => {
    const { sent, handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/p',
        workspaceDiff: CLEAN,
      });
    });
    act(() => {
      getCaptured().actions.confirm({ acknowledgedWorkspaceDiff: true });
    });
    const confirmedMsg = sent.find((m) => m.type === 'reopen_session_confirmed');
    expect(confirmedMsg).toEqual({
      type: 'reopen_session_confirmed',
      sessionId: 's-target',
      acknowledgedWorkspaceDiff: true,
    });
  });
});

describe('ReopenProvider — failure handling', () => {
  test('validation failure during committing reverts to confirming with inline error', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/p',
        workspaceDiff: DIRTY,
      });
    });
    act(() => {
      getCaptured().actions.confirm({
        acknowledgedWorkspaceDiff: true,
        typedConfirmation: 'reopen',
      });
    });
    // Server replies typed_confirmation_required (e.g. diff changed
    // between probe and commit so the gate fires retroactively)
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_failed',
        sessionId: 's-target',
        reason: 'typed_confirmation_required',
        message: 'Type "reopen" to confirm.',
      });
    });
    const state = getCaptured().state;
    expect(state.kind).toBe('confirming');
    if (state.kind === 'confirming') {
      expect(state.lastFailureMessage).toBe('Type "reopen" to confirm.');
      // diff + projectPath preserved across the revert
      expect(state.projectPath).toBe('/p');
      expect(state.diff).toEqual(DIRTY);
    }
  });

  test('hard failure lands terminal failed state', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_failed',
        sessionId: 's-target',
        reason: 'chain_reconstruction_unsupported',
        message: 'Chain mode not supported in v1.',
      });
    });
    expect(getCaptured().state).toEqual({
      kind: 'failed',
      sessionId: 's-target',
      reason: 'chain_reconstruction_unsupported',
      message: 'Chain mode not supported in v1.',
    });
  });

  test('close action returns to idle from any state', () => {
    const { getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    expect(getCaptured().state.kind).toBe('probing');
    act(() => {
      getCaptured().actions.close();
    });
    expect(getCaptured().state).toEqual({ kind: 'idle' });
  });
});

describe('ReopenProvider — race safety', () => {
  test('confirm_required for a different sessionId is ignored', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-other',
        projectPath: '/p',
        workspaceDiff: CLEAN,
      });
    });
    // Still probing for s-target; the s-other reply was dropped.
    expect(getCaptured().state).toEqual({ kind: 'probing', sessionId: 's-target' });
  });

  test('multi_agent_started for an unrelated session does not close the modal', () => {
    const { handlerRef, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      handlerRef.current?.({
        type: 'reopen_session_confirm_required',
        sessionId: 's-target',
        projectPath: '/p',
        workspaceDiff: CLEAN,
      });
    });
    // Modal is confirming. An unrelated multi_agent_started arrives
    // (e.g. operator started a new run from another surface).
    act(() => {
      handlerRef.current?.({
        type: 'multi_agent_started',
        sessionId: 's-some-other',
        mode: 'orchestrator',
        participants: [],
        participantAgentNames: [],
        lifecycle: 'persistent',
        sessionFolder: '/tmp/sf',
        hopBudget: 100,
        awaitingContinue: false,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      });
    });
    expect(getCaptured().state.kind).toBe('confirming');
  });

  test('duplicate requestReopen while one is in flight is dropped', () => {
    const { sent, getCaptured } = setup();
    act(() => {
      getCaptured().actions.requestReopen('s-target');
    });
    act(() => {
      getCaptured().actions.requestReopen('s-other');
    });
    // Only the first request was sent; the second was dropped.
    expect(sent).toEqual([{ type: 'reopen_session', sessionId: 's-target' }]);
    expect(getCaptured().state).toEqual({ kind: 'probing', sessionId: 's-target' });
  });
});

describe('ReopenProvider — hook guards', () => {
  test('useReopenState outside provider throws', () => {
    expect(() => {
      function BadCaptor() {
        useReopenState();
        return null;
      }
      act(() => {
        root.render(<BadCaptor />);
      });
    }).toThrow();
  });

  test('useReopenActions outside provider throws', () => {
    expect(() => {
      function BadCaptor() {
        useReopenActions();
        return null;
      }
      act(() => {
        root.render(<BadCaptor />);
      });
    }).toThrow();
  });
});
