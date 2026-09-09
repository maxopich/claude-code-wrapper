import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { WebSocket } from 'ws';
import type { ServerMsg } from '@cebab/shared/protocol';

import { stripComments } from '../test_support/strip_comments.js';
import { broadcastTo } from './server.js';

/**
 * `Cebab-6fax.45` item 7 — a bus run's END must reach every open tab, not just
 * the socket that happened to own the sink.
 *
 * WHAT WENT WRONG, measured on the Playground 2026-09-08. A bus session has
 * exactly ONE wire sink, and a re-attach SWAPS it (`live.rebind`) rather than
 * adding a subscriber. So a second browser tab attached to a session that was
 * then stopped from the first kept showing it as RUNNING, with a live Stop
 * button, for a whole five-minute run on the other connection — and never
 * learned a new session had started.
 *
 * `active_runs` cannot substitute: it is registered per QUERY, one entry per
 * hop, so a bus session is legitimately absent between hops and absence there
 * is not an end signal.
 *
 * WHY A SOURCE TEST FOR THE SITES. The failure mode is a send that reaches one
 * socket and looks identical from outside — a fourth `multi_agent_ended` emit
 * added later with `send(conn.ws, …)` would reintroduce exactly this defect
 * and no behavioural test would notice, because the tab that DID get the
 * message behaves correctly. Counting the sites is the only check that scales
 * to a site nobody has written yet. The same argument `reattach_sink_routing`
 * makes for the run-scoped callbacks.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** Every line that opens a `multi_agent_ended` envelope, 1-based. */
export function endedEmitLines(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes("type: 'multi_agent_ended'"))
    .map(({ n }) => n);
}

/**
 * The ~6 lines before each emit, so the call it belongs to is visible. The
 * envelope is written both inline (`send(x, { type: … })`) and as a multi-line
 * object literal, so the caller is on the same line or just above it.
 */
function callerContext(source: string, line: number): string {
  const lines = stripComments(source).split('\n');
  return lines.slice(Math.max(0, line - 6), line).join('\n');
}

describe('[security] every multi_agent_ended emit is a broadcast', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  test('the scan finds all three emit sites — anti-vacuity', () => {
    // The shared resume/re-attach sink, the fresh-start `onEnded`, and the
    // synthetic ended written when `stop()` throws. A rename that made this
    // zero would let the assertion below pass over an empty list
    // (`project_gates_pass_vacuously`).
    expect(endedEmitLines(source)).toHaveLength(3);
  });

  test('none of them goes to a single socket', () => {
    const perSocket = endedEmitLines(source).filter((n) => {
      const ctx = callerContext(source, n) + stripComments(source).split('\n')[n - 1];
      return !ctx.includes('broadcastServerMsg(');
    });
    expect(
      perSocket,
      'a multi_agent_ended emit sends to one socket. Every other tab watching ' +
        'that run keeps showing it as RUNNING with a live Stop button — the ' +
        'defect Cebab-6fax.45 measured. Use broadcastServerMsg.',
    ).toEqual([]);
  });

  test('the predicate detects a per-socket emit — the other direction', () => {
    // A checker that returned [] for all input would pass the case above
    // forever. Feed it the pre-fix shape.
    const broken = ["send(conn.ws, { type: 'multi_agent_ended', sessionId, reason });"].join('\n');
    expect(endedEmitLines(broken)).toEqual([1]);
    const ctx = broken;
    expect(ctx.includes('broadcastServerMsg(')).toBe(false);
  });

  test('the connection registry is added on connect and dropped on close', () => {
    // The set is what makes the broadcast reach anything, and a leak in it is
    // a send to a dead socket on every future run end.
    const body = stripComments(source);
    expect(body).toContain('openConns.add(conn)');
    expect(body).toContain('openConns.delete(conn)');
    const closeAt = body.indexOf("ws.on('close'");
    expect(closeAt).toBeGreaterThan(-1);
    expect(body.indexOf('openConns.delete(conn)')).toBeGreaterThan(closeAt);
  });
});

describe('broadcastTo reaches the open sockets and only those', () => {
  function fake(readyState: number): { ws: WebSocket; sent: string[] } {
    const sent: string[] = [];
    const ws = {
      readyState,
      send: (raw: string) => sent.push(raw),
    } as unknown as WebSocket;
    return { ws, sent };
  }

  const ended: ServerMsg = {
    type: 'multi_agent_ended',
    sessionId: 'bus-1',
    reason: 'stopped',
    iterationId: null,
  };

  test('an open socket receives it', () => {
    const a = fake(WebSocket.OPEN);
    broadcastTo([a], ended);
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0]!)).toMatchObject({ type: 'multi_agent_ended', reason: 'stopped' });
  });

  test('a socket that has closed is skipped rather than thrown at', () => {
    // The case the registry cannot prevent: a close landing between the run's
    // teardown and this call.
    const open = fake(WebSocket.OPEN);
    const closed = fake(WebSocket.CLOSED);
    broadcastTo([open, closed], ended);
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toEqual([]);
  });

  test('every open socket gets its own copy — the point of the change', () => {
    const a = fake(WebSocket.OPEN);
    const b = fake(WebSocket.OPEN);
    const c = fake(WebSocket.OPEN);
    broadcastTo([a, b, c], ended);
    expect([a.sent.length, b.sent.length, c.sent.length]).toEqual([1, 1, 1]);
  });
});
