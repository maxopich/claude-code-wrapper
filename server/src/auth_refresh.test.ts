import { describe, expect, test, afterEach, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  startAuthRefresh,
  cancelAuthRefresh,
  getActiveAuthRefreshRunId,
  _resetForTesting,
  type AuthRefreshCallbacks,
} from './auth_refresh.js';

// Cluster D Phase 6b: auth_refresh module unit tests.
//
// The real subprocess (`claude login`) opens an OAuth browser tab and
// listens on a local port — useless to spin up in a test. We inject a
// stub `spawnFn` that returns a mock ChildProcess (EventEmitter with
// stdout/stderr/kill) and exercise the wiring: callbacks fire in
// order, single-flight blocks concurrent starts, cancel kills, timeout
// fires, finalize-once invariant holds.

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

/** Build a mock ChildProcess. The returned object is the value `spawnFn`
 *  returns; the EventEmitter on it can be used by tests to simulate
 *  stdout/stderr/exit/error events. */
function makeMockChild(opts: { pid?: number } = {}) {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stdout.setEncoding = vi.fn();
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stderr.setEncoding = vi.fn();
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: opts.pid ?? 12345,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(() => {
      (child as { killed: boolean }).killed = true;
      // Simulate the kill triggering an exit event next tick
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    }),
  });
  return child;
}

function mkCallbacks(over: Partial<AuthRefreshCallbacks> = {}): {
  callbacks: AuthRefreshCallbacks;
  onStarted: ReturnType<typeof vi.fn>;
  onOutput: ReturnType<typeof vi.fn>;
  onCompleted: ReturnType<typeof vi.fn>;
} {
  const onStarted = vi.fn();
  const onOutput = vi.fn();
  const onCompleted = vi.fn();
  return {
    callbacks: { onStarted, onOutput, onCompleted, ...over },
    onStarted,
    onOutput,
    onCompleted,
  };
}

describe('startAuthRefresh — happy path', () => {
  test('spawns subprocess + fires onStarted + returns ok runId', () => {
    const child = makeMockChild({ pid: 9999 });
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onStarted } = mkCallbacks();

    const result = startAuthRefresh(callbacks, { spawnFn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.runId).toBe('string');
    expect(result.runId.length).toBeGreaterThan(0);
    expect(onStarted).toHaveBeenCalledWith({ runId: result.runId, pid: 9999 });
    expect(spawnFn).toHaveBeenCalledWith(
      'claude',
      ['login'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    expect(getActiveAuthRefreshRunId()).toBe(result.runId);
  });

  test('subscription-only env passed to spawn (ANTHROPIC_API_KEY scrubbed)', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped';
    try {
      const child = makeMockChild();
      const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
      startAuthRefresh(mkCallbacks().callbacks, { spawnFn });
      const envArg = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0][2].env;
      expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
      // PATH (or another non-blocked var) still present — wasn't a blanket wipe
      expect(envArg.PATH).toBeDefined();
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  test('stdout/stderr chunks fire onOutput with correct stream tag', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onOutput } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    child.stdout!.emit('data', 'Open https://login.claude.ai/... in your browser\n');
    child.stderr!.emit('data', 'warning: deprecated flag\n');

    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenNthCalledWith(1, {
      runId: result.runId,
      stream: 'stdout',
      text: 'Open https://login.claude.ai/... in your browser\n',
    });
    expect(onOutput).toHaveBeenNthCalledWith(2, {
      runId: result.runId,
      stream: 'stderr',
      text: 'warning: deprecated flag\n',
    });
  });

  test('clean exit(0) fires onCompleted with success=true', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    child.emit('exit', 0);

    expect(onCompleted).toHaveBeenCalledWith({
      runId: result.runId,
      exitCode: 0,
      success: true,
    });
    expect(getActiveAuthRefreshRunId()).toBeNull();
  });

  test('non-zero exit fires onCompleted with success=false', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    child.emit('exit', 1);

    expect(onCompleted).toHaveBeenCalledWith({
      runId: result.runId,
      exitCode: 1,
      success: false,
    });
  });
});

describe('startAuthRefresh — single-flight', () => {
  test('second call returns already_running with the first runId', () => {
    const child1 = makeMockChild();
    const spawnFn = vi.fn(() => child1) as unknown as typeof import('node:child_process').spawn;
    const r1 = startAuthRefresh(mkCallbacks().callbacks, { spawnFn });
    if (!r1.ok) throw new Error('expected first ok');

    const { callbacks: cb2, onStarted: onStarted2 } = mkCallbacks();
    const r2 = startAuthRefresh(cb2, { spawnFn });

    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('already_running');
    if (r2.reason !== 'already_running') return;
    expect(r2.existingRunId).toBe(r1.runId);
    // Second call did NOT spawn or fire onStarted
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(onStarted2).not.toHaveBeenCalled();
  });

  test('after first completes, second call succeeds', () => {
    const child1 = makeMockChild();
    const child2 = makeMockChild();
    let callIdx = 0;
    const spawnFn = vi.fn(() =>
      callIdx++ === 0 ? child1 : child2,
    ) as unknown as typeof import('node:child_process').spawn;

    const r1 = startAuthRefresh(mkCallbacks().callbacks, { spawnFn });
    if (!r1.ok) throw new Error('expected first ok');
    child1.emit('exit', 0);
    expect(getActiveAuthRefreshRunId()).toBeNull();

    const r2 = startAuthRefresh(mkCallbacks().callbacks, { spawnFn });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.runId).not.toBe(r1.runId);
  });
});

describe('startAuthRefresh — spawn failure', () => {
  test('sync throw → returns spawn_failed', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT: claude not found');
    }) as unknown as typeof import('node:child_process').spawn;

    const { callbacks, onStarted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn_failed');
    if (result.reason !== 'spawn_failed') return;
    expect(result.error).toContain('ENOENT');
    expect(onStarted).not.toHaveBeenCalled();
    expect(getActiveAuthRefreshRunId()).toBeNull();
  });

  test('async error event → fires onCompleted(exitCode=null) once', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    child.emit('error', new Error('async spawn failure'));

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith({
      runId: result.runId,
      exitCode: null,
      success: false,
    });
  });
});

describe('cancelAuthRefresh', () => {
  test('kills active subprocess + fires onCompleted with exitCode=null', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    const cancelled = cancelAuthRefresh(result.runId);
    expect(cancelled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // The mock kill's queueMicrotask emits the exit event — flush.
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onCompleted).toHaveBeenCalledWith({
          runId: result.runId,
          exitCode: null,
          success: false,
        });
        resolve();
      });
    });
  });

  test('returns false for unknown runId (defensive — stale cancel)', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const r = startAuthRefresh(mkCallbacks().callbacks, { spawnFn });
    if (!r.ok) throw new Error('expected ok');

    expect(cancelAuthRefresh('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('returns false when no run is active', () => {
    expect(cancelAuthRefresh('whatever')).toBe(false);
  });
});

describe('timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test('subprocess that never exits gets killed after timeoutMs', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn, timeoutMs: 1000 });
    if (!result.ok) throw new Error('expected ok');

    // Hasn't fired yet
    vi.advanceTimersByTime(999);
    expect(child.kill).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // finalize fires synchronously from the timer callback
    expect(onCompleted).toHaveBeenCalledWith({
      runId: result.runId,
      exitCode: null,
      success: false,
    });
  });

  test('natural exit before timeout cancels the timer (no double finalize)', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn, timeoutMs: 1000 });
    if (!result.ok) throw new Error('expected ok');

    child.emit('exit', 0);
    expect(onCompleted).toHaveBeenCalledTimes(1);

    // Advance past timeout — should NOT fire a second completion.
    vi.advanceTimersByTime(2000);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('finalize-once invariant', () => {
  test('exit + late error event does not double-fire onCompleted', () => {
    const child = makeMockChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const { callbacks, onCompleted } = mkCallbacks();
    const result = startAuthRefresh(callbacks, { spawnFn });
    if (!result.ok) throw new Error('expected ok');

    child.emit('exit', 0);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    child.emit('error', new Error('late error'));
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});
