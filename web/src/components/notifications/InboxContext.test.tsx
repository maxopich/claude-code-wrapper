// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useRef } from 'react';
import type { ClientMsg, NotificationEnvelope, ServerMsg } from '@cebab/shared/protocol';
import {
  InboxProvider,
  inboxReducer,
  initialInboxState,
  useInboxActions,
  useInboxState,
} from './InboxContext';

/**
 * Cluster A Phase 5: InboxContext tests.
 *
 * Two layers covered:
 *   1. Pure reducer — snapshot action overwrites prior state; `loaded`
 *      flips to true after the first snapshot.
 *   2. Provider bridge — the `handlerRef` exposes a function that
 *      filters ServerMsgs to the `inbox_snapshot` discriminant; other
 *      ServerMsgs are silently ignored. `useInboxActions().requestSnapshot`
 *      sends a `request_inbox_snapshot` ClientMsg with the given filters.
 */

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

function makeEnvelope(overrides: Partial<NotificationEnvelope> = {}): NotificationEnvelope {
  return {
    id: 'env-1',
    ts: 1_700_000_000_000,
    severity: 'warn',
    class: 'operational',
    dedupeKey: 'k:1',
    title: 'Hi',
    sticky: true,
    ...overrides,
  };
}

describe('inboxReducer', () => {
  test('initial state has loaded=false, empty rows, zero count', () => {
    expect(initialInboxState.loaded).toBe(false);
    expect(initialInboxState.rows).toEqual([]);
    expect(initialInboxState.unackedGlobal).toBe(0);
    expect(initialInboxState.unackedCountBySession).toEqual({});
  });

  test('snapshot action overwrites state and flips loaded=true', () => {
    const e1 = makeEnvelope({ id: 'a' });
    const e2 = makeEnvelope({ id: 'b' });
    const next = inboxReducer(initialInboxState, {
      type: 'snapshot',
      rows: [e1, e2],
      unackedCountBySession: { s1: 2 },
      unackedGlobal: 2,
    });
    expect(next.loaded).toBe(true);
    expect(next.rows).toEqual([e1, e2]);
    expect(next.unackedGlobal).toBe(2);
  });

  test('successive snapshots replace, not merge', () => {
    const first = inboxReducer(initialInboxState, {
      type: 'snapshot',
      rows: [makeEnvelope({ id: 'a' })],
      unackedCountBySession: { s1: 1 },
      unackedGlobal: 1,
    });
    const second = inboxReducer(first, {
      type: 'snapshot',
      rows: [makeEnvelope({ id: 'b' })],
      unackedCountBySession: { s2: 5 },
      unackedGlobal: 5,
    });
    expect(second.rows.map((r) => r.id)).toEqual(['b']);
    expect(second.unackedGlobal).toBe(5);
    expect(second.unackedCountBySession.s1).toBeUndefined();
  });
});

describe('InboxProvider bridge', () => {
  test('handlerRef receives an inbox_snapshot router; state updates on push', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
    const sendSpy = vi.fn();

    const holder: { state?: ReturnType<typeof useInboxState> } = {};
    function Probe() {
      holder.state = useInboxState();
      return null;
    }

    act(() => {
      root.render(
        <InboxProvider send={sendSpy} handlerRef={handlerRef}>
          <Probe />
        </InboxProvider>,
      );
    });

    expect(handlerRef.current).not.toBeNull();
    expect(holder.state?.loaded).toBe(false);

    const env = makeEnvelope({ id: 'snap-1' });
    act(() => {
      handlerRef.current!({
        type: 'inbox_snapshot',
        rows: [env],
        unackedCountBySession: { s1: 1 },
        unackedGlobal: 1,
      });
    });

    expect(holder.state?.loaded).toBe(true);
    expect(holder.state?.rows[0]?.id).toBe('snap-1');
    expect(holder.state?.unackedGlobal).toBe(1);
  });

  test('non-inbox_snapshot ServerMsgs are silently ignored', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
    const holder: { state?: ReturnType<typeof useInboxState> } = {};
    function Probe() {
      holder.state = useInboxState();
      return null;
    }

    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <Probe />
        </InboxProvider>,
      );
    });

    act(() => {
      // Type-correct ServerMsg of the wrong variant — must not crash + must
      // not change state.
      handlerRef.current!({ type: 'projects', projects: [] });
    });

    expect(holder.state?.loaded).toBe(false);
  });

  test('requestSnapshot sends a request_inbox_snapshot with filters', () => {
    const sent: ClientMsg[] = [];
    const actionsHolder: { actions?: ReturnType<typeof useInboxActions> } = {};
    function Probe() {
      actionsHolder.actions = useInboxActions();
      return null;
    }

    act(() => {
      root.render(
        <InboxProvider send={(m) => sent.push(m)}>
          <Probe />
        </InboxProvider>,
      );
    });

    act(() => {
      actionsHolder.actions!.requestSnapshot({ classes: ['safety'] });
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'request_inbox_snapshot',
      filters: { classes: ['safety'] },
    });
  });

  test('clearDismissed sends clear_dismissed_inbox', () => {
    const sent: ClientMsg[] = [];
    const actionsHolder: { actions?: ReturnType<typeof useInboxActions> } = {};
    function Probe() {
      actionsHolder.actions = useInboxActions();
      return null;
    }

    act(() => {
      root.render(
        <InboxProvider send={(m) => sent.push(m)}>
          <Probe />
        </InboxProvider>,
      );
    });

    act(() => {
      actionsHolder.actions!.clearDismissed();
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'clear_dismissed_inbox' });
  });

  test('handlerRef is cleared on unmount so dangling callers no-op', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
    function Empty() {
      // Need a useRef to keep TypeScript happy about unused imports.
      useRef(null);
      return null;
    }

    act(() => {
      root.render(
        <InboxProvider send={() => {}} handlerRef={handlerRef}>
          <Empty />
        </InboxProvider>,
      );
    });
    expect(handlerRef.current).not.toBeNull();

    act(() => {
      root.unmount();
    });
    expect(handlerRef.current).toBeNull();
    // Recreate the root so afterEach's unmount doesn't double-unmount.
    root = createRoot(container);
  });
});
