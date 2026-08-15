import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { connectWs } from './ws';

/**
 * Register W15: after `close()` the handle never calls back.
 *
 * The close event is asynchronous and the effect that owns the socket re-runs
 * — a Retry click, the auto-retry timer, a StrictMode remount. Cleanup calls
 * `close()`, the effect opens a replacement socket, and only then does the old
 * socket's `close` fire. Delivered to `onClose`, it dispatches `ws_close`
 * (wiping `liveSessions` / `activeRuns` / `lastBusInstallAt`) and
 * `connection_lost` — over a healthy connection. Closing a socket still in
 * CONNECTING is the loud version: code 1006 / `wasClean: false` resolves to
 * "server unreachable", so the overlay announces the server is gone while its
 * replacement is streaming.
 *
 * Every suppression case below is paired with the control that proves the
 * callback still fires when the handle has NOT been released — a version that
 * simply stopped calling back would pass half this file.
 */

type Listener = (ev: unknown) => void;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = 0;
  closeCalls = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closeCalls += 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Deliver an event the way the browser would, after the fact. */
  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function spies() {
  return { onOpen: vi.fn(), onClose: vi.fn(), onMessage: vi.fn() };
}

/** The socket `connectWs` just constructed. */
function socket(): FakeSocket {
  const s = FakeSocket.instances.at(-1);
  if (!s) throw new Error('connectWs did not construct a socket');
  return s;
}

const ABNORMAL = { code: 1006, reason: '', wasClean: false };

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ws / a released handle is silent (W15)', () => {
  test('a close event after close() does not reach onClose', () => {
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.close();
    socket().fire('close', ABNORMAL);

    expect(cb.onClose).not.toHaveBeenCalled();
  });

  test('CONTROL: the same close event DOES reach onClose when we did not close', () => {
    const cb = spies();
    connectWs({ url: 'ws://x', ...cb });

    socket().fire('close', ABNORMAL);

    expect(cb.onClose).toHaveBeenCalledTimes(1);
    expect(cb.onClose).toHaveBeenCalledWith({ code: 1006, reason: '', wasClean: false });
  });

  test('a message still in flight when we let go does not reach the store', () => {
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.close();
    socket().fire('message', { data: JSON.stringify({ type: 'ws_pong' }) });

    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  test('CONTROL: messages are delivered right up until close()', () => {
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    socket().fire('message', { data: JSON.stringify({ type: 'ws_pong' }) });
    expect(cb.onMessage).toHaveBeenCalledTimes(1);

    handle.close();
    socket().fire('message', { data: JSON.stringify({ type: 'ws_pong' }) });
    expect(cb.onMessage).toHaveBeenCalledTimes(1);
  });

  test('a socket closed while still CONNECTING never reports as open', () => {
    // The retry path's worst case: cleanup closes a socket mid-handshake.
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.close();
    socket().fire('open', {});

    expect(cb.onOpen).not.toHaveBeenCalled();
  });

  test('CONTROL: onOpen fires normally for a socket nobody released', () => {
    const cb = spies();
    connectWs({ url: 'ws://x', ...cb });

    socket().fire('open', {});

    expect(cb.onOpen).toHaveBeenCalledTimes(1);
  });

  test('close() still closes the underlying socket', () => {
    // The suppression is about callbacks, not about skipping the close —
    // a handle that went quiet without releasing the socket would leak it.
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.close();

    expect(socket().closeCalls).toBe(1);
  });

  test('unparseable frames are logged, not thrown, on a live handle', () => {
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    connectWs({ url: 'ws://x', ...cb });

    expect(() => socket().fire('message', { data: 'not json' })).not.toThrow();
    expect(cb.onMessage).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('ws / send', () => {
  test('writes when the socket is open and drops when it is not', () => {
    const cb = spies();
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.send({ type: 'list_projects' });
    expect(socket().sent).toEqual([]);

    socket().readyState = FakeSocket.OPEN;
    handle.send({ type: 'list_projects' });
    expect(socket().sent).toEqual([JSON.stringify({ type: 'list_projects' })]);
  });
});

/**
 * Register W29: `send` reported nothing.
 *
 * A socket that is CONNECTING, CLOSING or CLOSED swallowed the message with no
 * return value and no log, while callers had already applied their optimistic
 * state — the permission card flipped its buttons to "decided: …" BEFORE
 * calling this, so a decision made during a reconnect left the operator
 * looking at "Allowed" with the agent still parked in `canUseTool`.
 *
 * Each refusal is paired with the control that proves the permitted path still
 * transmits: a `send` that simply always returned false would satisfy every
 * "returns false" case in this block on its own.
 */
describe('ws / send reports whether it went out (W29)', () => {
  test('returns false and logs on a socket that is not open', () => {
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = connectWs({ url: 'ws://x', ...cb });

    // readyState 0 = CONNECTING, the reconnect window this is really about.
    expect(handle.send({ type: 'list_projects' })).toBe(false);
    expect(socket().sent).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test('CONTROL: returns true and transmits on an open socket', () => {
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = connectWs({ url: 'ws://x', ...cb });

    socket().readyState = FakeSocket.OPEN;
    expect(handle.send({ type: 'list_projects' })).toBe(true);
    expect(socket().sent).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  test('CLOSING and CLOSED report false too, not just CONNECTING', () => {
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = connectWs({ url: 'ws://x', ...cb });

    for (const state of [2, 3]) {
      socket().readyState = state;
      expect(handle.send({ type: 'list_projects' })).toBe(false);
    }
    expect(socket().sent).toEqual([]);
    err.mockRestore();
  });

  test('a released handle reports false even while the socket still reads OPEN', () => {
    // W15's flag and W29's return value have to agree: `close()` does not
    // change `readyState` synchronously, so a handle the caller let go of
    // would otherwise report a successful send on a socket it no longer owns.
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = connectWs({ url: 'ws://x', ...cb });

    socket().readyState = FakeSocket.OPEN;
    handle.close();

    expect(handle.send({ type: 'list_projects' })).toBe(false);
    expect(socket().sent).toEqual([]);
    err.mockRestore();
  });

  test('the log names the message type and never its payload', () => {
    // Dropped messages carry session ids, typed acknowledgments and operator
    // reason text. The console line is a diagnostic, not a place to spill them.
    const cb = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = connectWs({ url: 'ws://x', ...cb });

    handle.send({
      type: 'acknowledge_and_start',
      pendingStartId: 'p-1',
      typedAcknowledgment: 'inject',
      reasonText: 'CI sync, expected this',
    });

    const line = String(err.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('acknowledge_and_start');
    expect(line).not.toContain('CI sync');
    expect(line).not.toContain('p-1');
    err.mockRestore();
  });
});
