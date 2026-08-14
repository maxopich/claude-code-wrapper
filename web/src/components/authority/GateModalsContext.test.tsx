// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useEffect } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { GateModalsProvider, useGateModalsActions, useGateModalsState } from './GateModalsContext';

// Cluster B Phase 6a tests — the provider's queue + bridge contracts.
//
// What we test:
//   - enqueue + render: pushing a pending surfaces the matching modal
//   - FIFO: a second enqueue queues behind; dismissing surfaces the next
//   - dedupe: enqueueing the same pendingId twice keeps queue at length 1
//   - dismiss-head matchKey guard: a stale dismiss doesn't pop the head
//   - handlerRef bridge: assigning a ref + dispatching a matching
//     ServerMsg enqueues; non-gate ServerMsgs are dropped silently
//   - useGateModalsState / useGateModalsActions throw without the provider
//     (defensive contract test for App.tsx wiring)
//
// We avoid testing the actual modal contents here — those have dedicated
// component tests. The provider's job is queue + dispatch + lifecycle.

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

function mkMcp(pendingId: string): Extract<ServerMsg, { type: 'mcp_auto_install_pending' }> {
  return {
    type: 'mcp_auto_install_pending',
    pendingId,
    serverName: 'git-mcp',
    originPath: '/u/p/.claude/settings.json',
    command: '/bin/git-mcp',
    binarySha: 'abc',
    reason: 'first_seen',
  };
}

function mkBus(pendingId: string): Extract<ServerMsg, { type: 'bus_auto_install_pending' }> {
  return {
    type: 'bus_auto_install_pending',
    pendingId,
    projectId: 7,
    projectName: 'Alpha',
    agentName: 'alpha',
    contextSessionId: null,
  };
}

function mkEnv(pendingStartId: string): Extract<ServerMsg, { type: 'session_start_gated' }> {
  return {
    type: 'session_start_gated',
    pendingStartId,
    projectId: 1,
    reason: 'env_injection_detected',
    detectedInjections: [
      {
        envKey: 'ANTHROPIC_API_KEY',
        scope: 'project',
        scopePath: '/u/p/.claude/settings.json',
        posture: 'subscription auth bypass',
        isSet: true,
      },
    ],
  };
}

// Helper: a child component that exposes the actions via a ref-bridge so
// tests can call enqueue / dismissHead from outside React.
function ActionsExposer(props: {
  actionsRef: React.MutableRefObject<ReturnType<typeof useGateModalsActions> | null>;
  stateRef?: React.MutableRefObject<ReturnType<typeof useGateModalsState> | null>;
}) {
  const actions = useGateModalsActions();
  const state = useGateModalsState();
  useEffect(() => {
    props.actionsRef.current = actions;
    if (props.stateRef) props.stateRef.current = state;
    return () => {
      props.actionsRef.current = null;
      if (props.stateRef) props.stateRef.current = null;
    };
  });
  return null;
}

// ---- enqueue + render ----

describe('GateModalsProvider — enqueue + render', () => {
  test('enqueuing a mcp pending surfaces the McpTofuModal', () => {
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} />
        </GateModalsProvider>,
      );
    });
    // No modal yet.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => {
      actionsRef.current!.enqueue(mkMcp('pid-1'));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-labelledby')).toBe('mcp-tofu-title-pid-1');
  });

  test('enqueuing a bus pending surfaces the BusTofuModal', () => {
    // Cluster G Phase 4 (D6/D11): the third gate variant. Same one-modal-
    // at-a-time policy as mcp/env; the bus arm uses `bus:<pendingId>` as
    // its dedupe/dismiss key.
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      actionsRef.current!.enqueue(mkBus('bus-pid-1'));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-labelledby')).toBe('bus-tofu-title-bus-pid-1');
  });

  test('enqueuing an env pending surfaces the EnvInjectionGateModal', () => {
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      actionsRef.current!.enqueue(mkEnv('psid-1'));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('env-gate-title-psid-1');
  });
});

// ---- FIFO + dedupe + dismiss guard ----

describe('GateModalsProvider — FIFO queue', () => {
  test('two enqueues render only the head; dismissing surfaces the next', () => {
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      actionsRef.current!.enqueue(mkMcp('pid-A'));
      actionsRef.current!.enqueue(mkMcp('pid-B'));
    });
    expect(stateRef.current?.queue).toHaveLength(2);
    // Only one modal renders.
    const dialogsAfterEnqueue = container.querySelectorAll('[role="dialog"]');
    expect(dialogsAfterEnqueue).toHaveLength(1);
    expect(dialogsAfterEnqueue[0]!.getAttribute('aria-labelledby')).toBe('mcp-tofu-title-pid-A');

    act(() => {
      actionsRef.current!.dismissHead('mcp:pid-A');
    });
    // Head moved to pid-B.
    expect(stateRef.current?.queue).toHaveLength(1);
    const dialogsAfterDismiss = container.querySelectorAll('[role="dialog"]');
    expect(dialogsAfterDismiss[0]!.getAttribute('aria-labelledby')).toBe('mcp-tofu-title-pid-B');
  });

  test('enqueuing the same pendingId twice de-dupes (queue stays at length 1)', () => {
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      actionsRef.current!.enqueue(mkMcp('pid-X'));
      actionsRef.current!.enqueue(mkMcp('pid-X')); // same id
    });
    expect(stateRef.current?.queue).toHaveLength(1);
  });

  test('dismissHead with a non-matching key is a no-op (stale dismiss guard)', () => {
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      actionsRef.current!.enqueue(mkMcp('pid-1'));
      actionsRef.current!.dismissHead('mcp:pid-OTHER'); // stale
    });
    // Head untouched.
    expect(stateRef.current?.queue).toHaveLength(1);
    expect(stateRef.current?.queue[0]).toMatchObject({ pendingId: 'pid-1' });
  });
});

// ---- handlerRef bridge ----

describe('GateModalsProvider — handlerRef bridge', () => {
  test('matching ServerMsgs route through the ref into the queue', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true} handlerRef={handlerRef}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    expect(handlerRef.current).toBeTypeOf('function');
    act(() => {
      handlerRef.current!(mkMcp('pid-from-ws'));
    });
    expect(stateRef.current?.queue).toHaveLength(1);
  });

  test('bus_auto_install_pending ServerMsgs route through the bridge', () => {
    // Cluster G Phase 4 (D6/D11): App.tsx's onMessage feeds every
    // ServerMsg through `gateHandlerRef.current`; the provider's
    // bridge filter must include the bus variant. Without this, the
    // server's first-seen prompt would arrive but no modal would mount.
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true} handlerRef={handlerRef}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      handlerRef.current!(mkBus('bus-from-ws'));
    });
    expect(stateRef.current?.queue).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe(
      'bus-tofu-title-bus-from-ws',
    );
  });

  test('non-gate ServerMsgs are silently ignored by the bridge', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const stateRef = { current: null as ReturnType<typeof useGateModalsState> | null };
    const actionsRef = { current: null as ReturnType<typeof useGateModalsActions> | null };
    act(() => {
      root.render(
        <GateModalsProvider send={() => true} handlerRef={handlerRef}>
          <ActionsExposer actionsRef={actionsRef} stateRef={stateRef} />
        </GateModalsProvider>,
      );
    });
    act(() => {
      handlerRef.current!({ type: 'projects', projects: [] });
    });
    expect(stateRef.current?.queue).toHaveLength(0);
  });
});

// ---- send wiring ----

describe('GateModalsProvider — send wiring', () => {
  test('modal Submit goes through the injected send callback', () => {
    const sent: ClientMsg[] = [];
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    act(() => {
      root.render(
        <GateModalsProvider
          send={(m) => {
            sent.push(m);
            return true;
          }}
          handlerRef={handlerRef}
        >
          <div />
        </GateModalsProvider>,
      );
    });
    act(() => {
      handlerRef.current!(mkMcp('pid-go'));
    });
    // Trust button is in the McpTofuModal.
    const trustBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Trust',
    )!;
    act(() => {
      trustBtn.click();
    });
    expect(sent).toHaveLength(1);
    if (sent[0]?.type !== 'mcp_trust_decision') throw new Error();
    expect(sent[0].pendingId).toBe('pid-go');
    expect(sent[0].decision).toBe('trust');
  });
});

// ---- defensive: hooks throw without provider ----

describe('GateModalsProvider — hook safety', () => {
  test('useGateModalsState throws outside a provider', () => {
    function Probe() {
      // Should throw on mount.
      useGateModalsState();
      return null;
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      act(() => {
        root.render(<Probe />);
      }),
    ).toThrow(/GateModalsProvider/);
    consoleSpy.mockRestore();
  });

  test('useGateModalsActions throws outside a provider', () => {
    function Probe() {
      useGateModalsActions();
      return null;
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      act(() => {
        root.render(<Probe />);
      }),
    ).toThrow(/GateModalsProvider/);
    consoleSpy.mockRestore();
  });
});

// Refs to satisfy ActionsExposer's ref-prop type.
/**
 * Register W28 + H15: dismissing a gate tells the server.
 *
 * Before this, `onClose` only popped the queue. Escape, a backdrop click, and
 * the env gate's own "Refuse & edit" button all left the spawn parked on its
 * promise with no trace in the UI, and the only escape was dropping the
 * socket — the MCP modal called that intentional, on the strength of a
 * re-emit-on-attach phase that never shipped.
 *
 * `cancel_gate` is NOT a denial: it routes to the same reject-don't-resolve
 * path the disconnect drain uses, so nothing is recorded and the operator is
 * asked again next time. The controls below are what stop this from being
 * satisfied by "always send a cancel".
 */
describe('GateModalsProvider — dismissing cancels the gate (W28)', () => {
  function mount(sent: ClientMsg[]) {
    const actionsRef = {
      current: null as ReturnType<typeof useGateModalsActions> | null,
    };
    act(() => {
      root.render(
        <GateModalsProvider
          send={(m) => {
            sent.push(m);
            return true;
          }}
        >
          <ActionsExposer actionsRef={actionsRef} />
        </GateModalsProvider>,
      );
    });
    return actionsRef;
  }

  function pressEscape() {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  }

  test('Escape on the MCP gate sends cancel_gate and pops the queue', () => {
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => actionsRef.current?.enqueue(mkMcp('mp-1')));
    expect(container.querySelector('.gate-modal')).not.toBeNull();

    pressEscape();

    expect(sent).toEqual([{ type: 'cancel_gate', kind: 'mcp', pendingId: 'mp-1' }]);
    expect(container.querySelector('.gate-modal')).toBeNull();
  });

  test('Escape on the bus gate cancels with the bus kind', () => {
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => actionsRef.current?.enqueue(mkBus('bp-1')));

    pressEscape();

    expect(sent).toEqual([{ type: 'cancel_gate', kind: 'bus', pendingId: 'bp-1' }]);
  });

  test("the env gate cancels as kind 'start', off its pendingStartId", () => {
    // The two vocabularies for one gate: this file calls it `env`, the server
    // calls it `start` (session_start_gated / startGate). The wire word
    // follows the server, because that is whose pending map gets reached into.
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => actionsRef.current?.enqueue(mkEnv('sp-1')));

    pressEscape();

    expect(sent).toEqual([{ type: 'cancel_gate', kind: 'start', pendingId: 'sp-1' }]);
  });

  test('the env gate\'s "Refuse & edit" button cancels too, not just Escape', () => {
    // The button is the reason this mattered most here: a labelled refusal
    // affordance that sent nothing, on the one gate with no deny verb.
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => actionsRef.current?.enqueue(mkEnv('sp-2')));

    const refuse = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Refuse'),
    );
    act(() => refuse?.click());

    expect(sent).toEqual([{ type: 'cancel_gate', kind: 'start', pendingId: 'sp-2' }]);
    expect(container.querySelector('.gate-modal')).toBeNull();
  });

  test('CONTROL: deciding sends the DECISION and no cancel', () => {
    // The failure this rules out is a cancel chasing every decision, which
    // would reach the server after the gate had already resolved.
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => actionsRef.current?.enqueue(mkBus('bp-2')));

    const trust = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Trust',
    );
    act(() => trust?.click());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'bus_trust_decision', decision: 'trust' });
    expect(sent.some((m) => m.type === 'cancel_gate')).toBe(false);
    expect(container.querySelector('.gate-modal')).toBeNull();
  });

  test('CONTROL: cancelling one gate surfaces the next, cancelling only the first', () => {
    const sent: ClientMsg[] = [];
    const actionsRef = mount(sent);
    act(() => {
      actionsRef.current?.enqueue(mkMcp('mp-a'));
      actionsRef.current?.enqueue(mkMcp('mp-b'));
    });

    pressEscape();

    expect(sent).toEqual([{ type: 'cancel_gate', kind: 'mcp', pendingId: 'mp-a' }]);
    // The second gate is now the head, still parked and still asking.
    expect(container.querySelector('.gate-modal')).not.toBeNull();
  });
});

type _AssertActionsRef = React.MutableRefObject<ReturnType<typeof useGateModalsActions> | null>;
type _AssertStateRef = React.MutableRefObject<ReturnType<typeof useGateModalsState> | null>;
const _assertRefs = (a: _AssertActionsRef, s: _AssertStateRef) => [a, s];
void _assertRefs;
