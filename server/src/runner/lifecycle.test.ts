import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetForTests,
  closeAllQueries,
  inFlightCount,
  onInFlightChange,
  registerQuery,
  snapshotInFlight,
  type InFlightMeta,
} from './lifecycle.js';

// Cluster G Phase 3 (G1): the lifecycle registry now carries optional
// `InFlightMeta` so the WS `active_runs` dispatcher can project a per-conn
// snapshot. These tests pin the new behaviours:
//
//   1. Meta-carrying registrations show up in `snapshotInFlight()`; meta-less
//      registrations are tracked-for-shutdown but invisible.
//   2. The `onInFlightChange` listener fires on add AND remove for meta-
//      carrying entries; it does NOT fire for meta-less ones (auth_refresh).
//   3. `closeAllQueries` clears the registry and notifies once.
//   4. The shutdown path is idempotent — re-calling the unregister returned
//      after `closeAllQueries` is a safe no-op.

afterEach(() => {
  __resetForTests();
});

function makeQ(): { close: () => void; closed: boolean } {
  const q = { closed: false, close: () => {} };
  q.close = () => {
    q.closed = true;
  };
  return q;
}

describe('lifecycle / metadata registry (Phase 3)', () => {
  test('registerQuery without meta is invisible in snapshotInFlight', () => {
    const q = makeQ();
    const unregister = registerQuery(q);
    // Tracked for shutdown:
    expect(inFlightCount()).toBe(1);
    // But invisible to the active-runs surface:
    expect(snapshotInFlight()).toEqual([]);
    unregister();
    expect(inFlightCount()).toBe(0);
  });

  test('registerQuery WITH meta surfaces in snapshotInFlight', () => {
    const meta: InFlightMeta = {
      sessionId: 'sess-1',
      projectId: 42,
      kind: 'single',
      startedAt: 1_700_000_000_000,
    };
    const unregister = registerQuery(makeQ(), meta);
    expect(snapshotInFlight()).toEqual([meta]);
    unregister();
    expect(snapshotInFlight()).toEqual([]);
  });

  test('snapshotInFlight preserves insertion order across mixed kinds', () => {
    // Important for the dropdown: the operator's eye lands on rows in the
    // order they started, which gives "newest at bottom" implicitly via
    // Map iteration order. A future sort can reverse without losing the
    // tie-breaker.
    const single: InFlightMeta = {
      sessionId: 's-single',
      projectId: 1,
      kind: 'single',
      startedAt: 1,
    };
    const bus1: InFlightMeta = {
      sessionId: 'bus-A',
      projectId: 2,
      kind: 'bus-worker',
      startedAt: 2,
    };
    const bus2: InFlightMeta = {
      sessionId: 'bus-B',
      projectId: 3,
      kind: 'bus-worker',
      startedAt: 3,
    };
    registerQuery(makeQ(), single);
    registerQuery(makeQ(), bus1);
    registerQuery(makeQ(), bus2);
    expect(snapshotInFlight()).toEqual([single, bus1, bus2]);
  });

  test('mixed meta + no-meta — only meta entries appear in snapshot', () => {
    // The auth_refresh subprocess registers without meta; it must NOT
    // leak into active_runs even when single-agent / bus queries are
    // running alongside it.
    const meta: InFlightMeta = {
      sessionId: 'sess-meta',
      projectId: 7,
      kind: 'single',
      startedAt: 99,
    };
    registerQuery(makeQ()); // auth_refresh-like
    registerQuery(makeQ(), meta);
    registerQuery(makeQ()); // another meta-less
    expect(inFlightCount()).toBe(3);
    expect(snapshotInFlight()).toEqual([meta]);
  });
});

describe('lifecycle / change notifications (Phase 3)', () => {
  test('onInFlightChange fires on add + remove for meta-carrying entries', () => {
    const meta: InFlightMeta = {
      sessionId: 'sess-watch',
      projectId: 1,
      kind: 'single',
      startedAt: 0,
    };
    let fires = 0;
    const unsub = onInFlightChange(() => {
      fires += 1;
    });
    const unregister = registerQuery(makeQ(), meta);
    expect(fires).toBe(1);
    unregister();
    expect(fires).toBe(2);
    unsub();
    // Post-unsub: no more notifications even if the registry mutates.
    registerQuery(makeQ(), meta);
    expect(fires).toBe(2);
  });

  test('onInFlightChange does NOT fire for meta-less registrations', () => {
    // The shutdown registry mutates for every registerQuery, but the
    // active-runs dispatcher should only re-emit when something actually
    // changes in the user-facing view. Meta-less entries (auth_refresh)
    // must not noise up the wire.
    let fires = 0;
    onInFlightChange(() => {
      fires += 1;
    });
    const unregister = registerQuery(makeQ()); // no meta
    expect(fires).toBe(0);
    unregister();
    expect(fires).toBe(0);
  });

  test('onInFlightChange listener exceptions do not block other listeners or mutations', () => {
    // One bad listener must not break the registry. The lifecycle module's
    // try/catch around the listener fan-out is what enables this.
    let goodFires = 0;
    onInFlightChange(() => {
      throw new Error('intentional');
    });
    onInFlightChange(() => {
      goodFires += 1;
    });
    const unregister = registerQuery(makeQ(), {
      sessionId: 's-iso',
      kind: 'single',
      startedAt: 0,
    });
    expect(goodFires).toBe(1);
    unregister();
    expect(goodFires).toBe(2);
  });
});

describe('lifecycle / shutdown semantics', () => {
  test('closeAllQueries closes every handle and empties the registry', () => {
    const q1 = makeQ();
    const q2 = makeQ();
    registerQuery(q1, { sessionId: 'a', kind: 'single', startedAt: 0 });
    registerQuery(q2); // no-meta auth_refresh-like
    expect(inFlightCount()).toBe(2);
    closeAllQueries();
    expect(inFlightCount()).toBe(0);
    expect(q1.closed).toBe(true);
    expect(q2.closed).toBe(true);
  });

  test('closeAllQueries fires one final notify so listeners see the drain', () => {
    // The dispatcher wires onInFlightChange to re-emit `active_runs`. The
    // shutdown path firing one last notify lets the listener emit an empty
    // snapshot as the final wire record.
    registerQuery(makeQ(), { sessionId: 'b', kind: 'single', startedAt: 0 });
    let fires = 0;
    onInFlightChange(() => {
      fires += 1;
    });
    closeAllQueries();
    expect(fires).toBe(1);
    expect(snapshotInFlight()).toEqual([]);
  });

  test('a thrown close() does not stop other handles from being closed', () => {
    const q1 = makeQ();
    const q2 = makeQ();
    q1.close = () => {
      throw new Error('boom');
    };
    registerQuery(q1);
    registerQuery(q2);
    closeAllQueries();
    expect(q2.closed).toBe(true);
    expect(inFlightCount()).toBe(0);
  });
});
