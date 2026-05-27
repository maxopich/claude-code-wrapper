// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useEffect, useRef } from 'react';
import type { ClientMsg, ProjectAuthority, ServerMsg } from '@cebab/shared/protocol';
import {
  AuthorityProvider,
  useAuthorityActions,
  useAuthoritySlot,
  type AuthoritySlot,
} from './AuthorityContext';

// Cluster B Phase 6b tests — AuthorityProvider's reducer + bridge contracts.
//
// We test the wire-level + reducer behavior:
//   - request(projectId, mode) → ClientMsg dispatched + slot moves to 'requesting'
//   - receive (handlerRef bridge) → slot moves to 'ready' with the authority
//   - cache-miss path: receive(null) → slot moves to 'cache-miss'
//   - re-probe from 'ready': slot stays 'ready' (preserves stale data)
//   - reset clears a slot
//   - hooks throw without provider
//   - non-project_authority ServerMsgs are silently ignored
//
// Component tests for the panel + sections live in their own files; this is
// the provider's contract.

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

function mkAuthority(overrides: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    projectId: 1,
    capturedAt: Date.now(),
    fromProbe: false,
    model: 'claude-sonnet-4-5',
    apiKeySource: 'none',
    permissionMode: 'default',
    cwd: '/u/proj',
    settingSourcesUsed: ['user'],
    tools: [],
    mcpServers: [],
    slashCommands: [],
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    detectedEnvInjections: [],
    ...overrides,
  };
}

// Helper bridge: expose slot+actions via refs so tests can poke from outside.
function Probe(props: {
  projectId: number;
  slotRef: React.MutableRefObject<AuthoritySlot | null>;
  actionsRef: React.MutableRefObject<ReturnType<typeof useAuthorityActions> | null>;
}) {
  const slot = useAuthoritySlot(props.projectId);
  const actions = useAuthorityActions();
  useEffect(() => {
    props.slotRef.current = slot;
    props.actionsRef.current = actions;
    return () => {
      props.slotRef.current = null;
      props.actionsRef.current = null;
    };
  });
  return null;
}

// ---- request / dispatch ----

describe('AuthorityProvider — request', () => {
  test('request() ships a get_project_authority ClientMsg and moves slot to requesting', () => {
    const sent: ClientMsg[] = [];
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={(m) => sent.push(m)}>
          <Probe projectId={42} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    expect(slotRef.current?.status).toBe('idle');
    act(() => {
      actionsRef.current!.request(42, 'cache');
    });
    expect(sent).toEqual([{ type: 'get_project_authority', projectId: 42, mode: 'cache' }]);
    expect(slotRef.current?.status).toBe('requesting');
    if (slotRef.current?.status !== 'requesting') throw new Error();
    expect(slotRef.current.mode).toBe('cache');
  });

  test('reset() drops the slot for a project', () => {
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}}>
          <Probe projectId={7} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    act(() => {
      actionsRef.current!.request(7, 'cache');
    });
    expect(slotRef.current?.status).toBe('requesting');
    act(() => {
      actionsRef.current!.reset(7);
    });
    expect(slotRef.current?.status).toBe('idle');
  });
});

// ---- handlerRef bridge ----

describe('AuthorityProvider — handlerRef bridge', () => {
  test('project_authority envelope flips slot to ready with the snapshot', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}} handlerRef={handlerRef}>
          <Probe projectId={5} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    expect(handlerRef.current).toBeTypeOf('function');
    const authority = mkAuthority({ projectId: 5, model: 'sonnet' });
    act(() => {
      handlerRef.current!({ type: 'project_authority', projectId: 5, authority });
    });
    if (slotRef.current?.status !== 'ready') throw new Error('expected ready');
    expect(slotRef.current.authority.model).toBe('sonnet');
  });

  test('null authority moves slot to cache-miss', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}} handlerRef={handlerRef}>
          <Probe projectId={9} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    act(() => {
      handlerRef.current!({ type: 'project_authority', projectId: 9, authority: null });
    });
    expect(slotRef.current?.status).toBe('cache-miss');
  });

  test('non-project_authority ServerMsgs are silently ignored', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}} handlerRef={handlerRef}>
          <Probe projectId={3} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    act(() => {
      handlerRef.current!({ type: 'projects', projects: [] });
    });
    expect(slotRef.current?.status).toBe('idle');
  });

  test('re-probe from ready preserves the stale snapshot (re-request does not flash empty)', () => {
    const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
    const slotRef = { current: null as AuthoritySlot | null };
    const actionsRef = { current: null as ReturnType<typeof useAuthorityActions> | null };
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}} handlerRef={handlerRef}>
          <Probe projectId={1} slotRef={slotRef} actionsRef={actionsRef} />
        </AuthorityProvider>,
      );
    });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({ projectId: 1, model: 'stale-model' }),
      });
    });
    expect(slotRef.current?.status).toBe('ready');
    act(() => {
      actionsRef.current!.request(1, 'probe');
    });
    // Still 'ready' — we deliberately keep the stale snapshot through the
    // re-fetch instead of flashing 'requesting'.
    if (slotRef.current?.status !== 'ready') throw new Error('expected ready');
    expect(slotRef.current.authority.model).toBe('stale-model');
  });
});

// ---- defensive hook contracts ----

describe('AuthorityProvider — hook safety', () => {
  test('useAuthoritySlot throws outside a provider', () => {
    function ProbeNoProvider() {
      useAuthoritySlot(1);
      return null;
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      act(() => {
        root.render(<ProbeNoProvider />);
      }),
    ).toThrow(/AuthorityProvider/);
    consoleSpy.mockRestore();
  });
  test('useAuthorityActions throws outside a provider', () => {
    function ProbeNoProvider() {
      useAuthorityActions();
      return null;
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      act(() => {
        root.render(<ProbeNoProvider />);
      }),
    ).toThrow(/AuthorityProvider/);
    consoleSpy.mockRestore();
  });
});

// Refs to satisfy Probe's prop types.
type _AssertSlotRef = React.MutableRefObject<AuthoritySlot | null>;
type _AssertActionsRef = React.MutableRefObject<ReturnType<typeof useAuthorityActions> | null>;
const _assertRefs = (s: _AssertSlotRef, a: _AssertActionsRef) => [s, a];
void _assertRefs;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _useRefUsage = () => useRef(null);
