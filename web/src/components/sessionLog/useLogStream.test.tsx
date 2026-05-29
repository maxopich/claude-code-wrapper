// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LogRow, ServerMsg, SessionLogScope } from '@cebab/shared/protocol';
import { useLogStream, type LogStreamHandle } from './useLogStream';

// Cluster H C3 UI — pins useLogStream's `scope` forwarding contract:
//
//   1. When the consumer omits `scope`, every onLoadSessionLog call passes
//      `undefined` as its 5th arg (the server then defaults to multi_agent).
//   2. When the consumer sets `scope: 'single'`, every load — initial,
//      loadMore, refresh — passes `'single'` verbatim.
//   3. The reset effect re-fires when `scope` changes (rare in practice but
//      kept correct so a future toggling consumer doesn't carry stale rows).
//
// Cluster H D12 client — pins useLogStream's tail-mode contract:
//
//   4. A `log_row_appended` envelope for the active session + matching scope
//      appends to `rows` and bumps `tailAppendedCount` + `total`.
//   5. Dedup by row.id: a tail envelope whose id is already in rows is a
//      no-op (handles the chunk-page race).
//   6. Scope filter: the consumer's `scope` (default `multi_agent` when
//      omitted) is matched against the envelope's `scope`. A mismatch is
//      dropped — a single-agent inspector cannot append a multi_agent row.
//   7. Session filter: an envelope for a different sessionId is dropped.
//   8. Safety cap: after `tailSafetyCap` rows have been appended,
//      `tailSafetyTripped` flips and further envelopes are no-ops.
//   9. Refresh re-arms the tail: `tailAppendedCount` zeroes,
//      `tailSafetyTripped` clears, and `onLoadSessionLog` re-fires at offset 0.

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

type LoadCall = {
  sessionId: string;
  offset: number;
  limit: number;
  revealSensitive: boolean;
  scope?: SessionLogScope;
};

type Harness = {
  loadCalls: LoadCall[];
  unsub: () => void;
  /** Dispatch a ServerMsg through the registered subscriber. */
  emit: (msg: ServerMsg) => void;
  /** Latest LogStreamHandle observed by the probe component. */
  handle: () => LogStreamHandle;
};

function renderProbe(
  scope?: SessionLogScope,
  sessionId = 'sess-1',
  tailSafetyCap?: number,
): Harness {
  const loadCalls: LoadCall[] = [];
  let unsub: () => void = () => {};
  let subscriberCb: ((msg: ServerMsg) => void) | null = null;
  let latestHandle: LogStreamHandle | null = null;

  function Probe() {
    const h = useLogStream({
      sessionId,
      scope,
      tailSafetyCap,
      onLoadSessionLog: (sid, offset, limit, revealSensitive, sc) => {
        loadCalls.push({ sessionId: sid, offset, limit, revealSensitive, scope: sc });
      },
      subscribeServerMsg: (cb: (msg: ServerMsg) => void) => {
        subscriberCb = cb;
        unsub = () => {
          subscriberCb = null;
        };
        return unsub;
      },
    });
    latestHandle = h;
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  return {
    loadCalls,
    unsub,
    emit: (msg) => {
      act(() => {
        subscriberCb?.(msg);
      });
    },
    handle: () => {
      if (!latestHandle) throw new Error('probe not mounted');
      return latestHandle;
    },
  };
}

function busRow(id: string, ts = 1700000000000): LogRow {
  return {
    id,
    ts,
    agent: 'worker',
    kind: 'bus',
    summary: `${id} summary`,
    status: 'reply',
    raw: { kind: 'reply', source: 'worker', destination: 'cebab', text: 'ok' },
  };
}

describe('useLogStream — scope forwarding (Cluster H C3 UI)', () => {
  test('omits scope (undefined) when consumer leaves it unset', () => {
    const { loadCalls } = renderProbe(undefined);
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    const first = loadCalls[0]!;
    expect(first.sessionId).toBe('sess-1');
    expect(first.offset).toBe(0);
    expect(first.revealSensitive).toBe(false);
    expect(first.scope).toBeUndefined();
  });

  test('passes scope="single" verbatim to onLoadSessionLog on initial fetch', () => {
    const { loadCalls } = renderProbe('single');
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    expect(loadCalls[0]?.scope).toBe('single');
  });

  test('passes scope="multi_agent" verbatim when the consumer sets it explicitly', () => {
    const { loadCalls } = renderProbe('multi_agent');
    expect(loadCalls[0]?.scope).toBe('multi_agent');
  });
});

describe('useLogStream — tail-mode (Cluster H D12 client)', () => {
  test('log_row_appended for matching session + default scope appends a row', () => {
    const h = renderProbe(undefined, 'sess-1');
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:1'),
    });
    const s = h.handle();
    expect(s.rows.map((r) => r.id)).toEqual(['event:1']);
    expect(s.tailAppendedCount).toBe(1);
    expect(s.total).toBe(1);
    expect(s.tailSafetyTripped).toBe(false);
  });

  test('log_row_appended for explicit scope="multi_agent" matches default consumer', () => {
    const h = renderProbe(undefined, 'sess-1');
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:7'),
    });
    expect(h.handle().rows.map((r) => r.id)).toEqual(['event:7']);
  });

  test('single-agent consumer drops multi_agent tail envelopes', () => {
    const h = renderProbe('single', 'sess-1');
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:7'),
    });
    const s = h.handle();
    expect(s.rows).toEqual([]);
    expect(s.tailAppendedCount).toBe(0);
  });

  test('multi-agent consumer drops single-scope tail envelopes', () => {
    const h = renderProbe('multi_agent', 'sess-1');
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'single',
      row: busRow('event:7'),
    });
    expect(h.handle().rows).toEqual([]);
  });

  test('envelope for a different session is dropped', () => {
    const h = renderProbe(undefined, 'sess-1');
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-OTHER',
      scope: 'multi_agent',
      row: busRow('event:9'),
    });
    expect(h.handle().rows).toEqual([]);
    expect(h.handle().tailAppendedCount).toBe(0);
  });

  test('dedup: an envelope whose row.id is already present is a no-op', () => {
    const h = renderProbe(undefined, 'sess-1');
    // Seed via initial chunk so the row is in `rows`.
    h.emit({
      type: 'session_log_chunk',
      sessionId: 'sess-1',
      offset: 0,
      rows: [busRow('event:1')],
      total: 1,
      hasMore: false,
      revealedSensitive: false,
    });
    expect(h.handle().rows).toHaveLength(1);
    // A tail envelope for the same id arrives — no double-append.
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:1'),
    });
    expect(h.handle().rows).toHaveLength(1);
    expect(h.handle().tailAppendedCount).toBe(0);
  });

  test('safety cap: after `tailSafetyCap` appends, further envelopes are dropped', () => {
    const h = renderProbe(undefined, 'sess-1', 3);
    for (let i = 1; i <= 3; i += 1) {
      h.emit({
        type: 'log_row_appended',
        sessionId: 'sess-1',
        scope: 'multi_agent',
        row: busRow(`event:${i}`),
      });
    }
    expect(h.handle().tailAppendedCount).toBe(3);
    expect(h.handle().tailSafetyTripped).toBe(false);
    // The 4th flips the flag and does NOT add the row.
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:4'),
    });
    expect(h.handle().tailSafetyTripped).toBe(true);
    expect(h.handle().rows.map((r) => r.id)).toEqual(['event:1', 'event:2', 'event:3']);
    expect(h.handle().tailAppendedCount).toBe(3);
    // Further envelopes are still no-ops while the flag is set.
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:5'),
    });
    expect(h.handle().rows.map((r) => r.id)).toEqual(['event:1', 'event:2', 'event:3']);
  });

  test('refresh() re-arms the tail: counter + tripped flag reset, reload fires', () => {
    const h = renderProbe(undefined, 'sess-1', 1);
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:1'),
    });
    h.emit({
      type: 'log_row_appended',
      sessionId: 'sess-1',
      scope: 'multi_agent',
      row: busRow('event:2'),
    });
    expect(h.handle().tailSafetyTripped).toBe(true);
    const callsBefore = h.loadCalls.length;
    act(() => {
      h.handle().refresh();
    });
    const s = h.handle();
    expect(s.tailAppendedCount).toBe(0);
    expect(s.tailSafetyTripped).toBe(false);
    expect(s.rows).toEqual([]);
    expect(h.loadCalls.length).toBe(callsBefore + 1);
    expect(h.loadCalls[h.loadCalls.length - 1]?.offset).toBe(0);
  });
});
