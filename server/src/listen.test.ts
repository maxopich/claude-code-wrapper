import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { startListening, type ListenTarget } from './listen.js';

/**
 * A server that cannot bind its port must fail loudly and change nothing
 * (Cebab-ygu.41).
 *
 * It used to do the opposite. `listen` had no `'error'` listener, so a bind
 * failure became an uncaught exception, and the blanket containment handler
 * logged "contained; server stays up" — leaving a process alive with no
 * listening socket, after it had already unlinked and rewritten the RUNNING
 * server's `~/.cebab/auth-token`.
 *
 * The load-bearing assertion here is `onBound` NOT being called. Every
 * destructive and process-global step of boot now lives inside it, so that one
 * line stands for "the healthy server's token file is untouched" without
 * needing two servers and a port.
 */

/** `http.Server`'s two relevant surfaces, with `listen` recorded rather than
 *  performed. The emitter half is real so the `'error'` path is exercised the
 *  way Node drives it. */
class FakeServer extends EventEmitter implements ListenTarget {
  listenCalls: Array<{ port: number; host: string }> = [];
  /** Set when `listen` is called, so a test can fire the success path. */
  private boundCb: (() => void) | null = null;
  /** Listeners present at the moment `listen` was called — the ordering
   *  question, captured rather than inferred. */
  errorListenersAtListen = -1;

  listen(port: number, host: string, callback: () => void): this {
    this.listenCalls.push({ port, host });
    this.errorListenersAtListen = this.listenerCount('error');
    this.boundCb = callback;
    return this;
  }

  /** Simulate a successful bind. */
  succeed(): void {
    this.boundCb?.();
  }

  /** Simulate Node's async bind failure. */
  fail(code: string, message = `listen ${code} 127.0.0.1:4319`): void {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    this.emit('error', err);
  }
}

function harness() {
  const server = new FakeServer();
  const logs: string[] = [];
  const exits: number[] = [];
  let bound = 0;
  startListening({
    server,
    port: 4319,
    host: '127.0.0.1',
    onBound: () => {
      bound += 1;
    },
    exit: (code) => exits.push(code),
    log: (msg) => logs.push(msg),
  });
  return { server, logs, exits, boundCount: () => bound };
}

describe('startListening', () => {
  test('a re-emitting source is guarded too, and reports once', () => {
    // `ws`'s WebSocketServer attaches its own forwarder to the http server and
    // re-emits the failure on ITSELF — and because it is constructed first,
    // its listener runs first, so an unguarded WSS throws before this module's
    // handler is ever reached. Found by running the fix end to end; the case
    // below is what stops it coming back.
    const server = new FakeServer();
    const wss = new EventEmitter();
    const logs: string[] = [];
    const exits: number[] = [];
    let bound = 0;
    startListening({
      server,
      errorSources: [wss],
      port: 4319,
      host: '127.0.0.1',
      onBound: () => {
        bound += 1;
      },
      exit: (code) => exits.push(code),
      log: (msg) => logs.push(msg),
    });
    expect(wss.listenerCount('error')).toBe(1);

    // Node delivers it to both. One failure must read as one problem.
    const err = new Error('listen EADDRINUSE 127.0.0.1:4319') as NodeJS.ErrnoException;
    err.code = 'EADDRINUSE';
    wss.emit('error', err);
    server.emit('error', err);

    expect(bound).toBe(0);
    expect(exits).toEqual([1]);
    expect(logs).toHaveLength(1);
  });

  test('the error listener is attached BEFORE listen is called', () => {
    // Attaching it afterwards is the same bug wearing a different hat: `listen`
    // can emit `'error'` before a later statement runs, and an unheard
    // `'error'` on an EventEmitter is thrown.
    const h = harness();
    expect(h.server.listenCalls).toEqual([{ port: 4319, host: '127.0.0.1' }]);
    expect(h.server.errorListenersAtListen).toBe(1);
  });

  test('a successful bind runs onBound exactly once and never exits', () => {
    const h = harness();
    h.server.succeed();
    expect(h.boundCount()).toBe(1);
    expect(h.exits).toEqual([]);
  });

  test('EADDRINUSE exits non-zero and onBound never runs', () => {
    // THE CASE. `onBound` is where the auth-token write and the containment
    // handlers live, so this is also the assertion that a doomed boot leaves
    // the running server's token file alone.
    const h = harness();
    h.server.fail('EADDRINUSE');
    expect(h.boundCount()).toBe(0);
    expect(h.exits).toEqual([1]);
  });

  test('the EADDRINUSE message names the address and the remedy', () => {
    // The old failure printed a stack trace whose only negative signal was the
    // ABSENCE of "listening at" further down the scrollback.
    const h = harness();
    h.server.fail('EADDRINUSE');
    const msg = h.logs.join('\n');
    expect(msg).toContain('127.0.0.1:4319');
    expect(msg).toContain('already in use');
    expect(msg).toContain('scripts/predev-server.mjs');
    // It also promises the thing this bead is about; if that promise ever
    // stops being true, this line is a lie in the operator's terminal.
    expect(msg).toContain('auth token');
  });

  test('any other listen failure is fatal too, and says which', () => {
    // EACCES on a privileged port, EADDRNOTAVAIL on a non-local host. Staying
    // up to report them is what produced the zombie in the first place.
    const h = harness();
    h.server.fail('EACCES', 'listen EACCES 127.0.0.1:80');
    expect(h.boundCount()).toBe(0);
    expect(h.exits).toEqual([1]);
    expect(h.logs.join('\n')).toContain('EACCES');
  });

  test('an error with no code is still fatal', () => {
    // Nothing guarantees `code` is set; a missing one must not fall through
    // into "carry on" — the branch that has no `exit` is the bug.
    const h = harness();
    const err = new Error('something else went wrong');
    h.server.emit('error', err);
    expect(h.boundCount()).toBe(0);
    expect(h.exits).toEqual([1]);
    expect(h.logs.join('\n')).toContain('something else went wrong');
  });
});
