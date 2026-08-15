import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { __setStreamFactoryForTests, closeLogger, logEvent } from './logger.js';

// A minimal stand-in for fs.WriteStream so we can simulate write errors and
// backpressure deterministically. CI runs ubuntu + windows; relying on an
// OS-specific unwritable path to provoke a real stream error would be flaky.
class FakeWriteStream extends EventEmitter {
  writableNeedDrain = false;
  lines: string[] = [];
  ended = false;
  // Mirrors `fs.WriteStream`: `closed` flips and `'close'` fires once the
  // handle is really gone. `closeLogger` waits on exactly this, so a fake that
  // never closed would make every teardown sit out the timeout — and would
  // make the close-ordering tests below pass for the wrong reason.
  closed = false;
  /** Never emit `'close'`, standing in for a wedged fd. */
  private readonly neverCloses: boolean;
  private readonly backpressure: boolean;
  constructor(opts: { backpressure?: boolean; neverCloses?: boolean } = {}) {
    super();
    this.backpressure = opts.backpressure ?? false;
    this.neverCloses = opts.neverCloses ?? false;
  }
  write(chunk: string): boolean {
    this.lines.push(chunk);
    if (this.backpressure) {
      this.writableNeedDrain = true;
      return false;
    }
    return true;
  }
  end(): void {
    this.ended = true;
    if (this.neverCloses) return;
    // Asynchronously, as the real one does — a synchronous close would let a
    // broken `closeLogger` look correct by accident.
    setImmediate(() => {
      this.closed = true;
      this.emit('close');
    });
  }
}

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  // streamFor() still mkdirs config.logsDir even with an injected factory;
  // point it at a throwaway dir so the test never touches the real ~/.cebab.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-logger-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
});

afterEach(async () => {
  // Real timers FIRST: `closeLogger` now waits on a `setTimeout` budget, and a
  // case that left fake timers installed would hang that wait forever.
  vi.useRealTimers();
  // Awaited (Cebab-kji): clears the module-level streams map between cases AND
  // waits for the handles, so the rmSync below cannot race an open fd.
  await closeLogger();
  __setStreamFactoryForTests(null);
  config.dataDir = originalDataDir;
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('logEvent', () => {
  test('writes a line and returns ok on success', async () => {
    const fake = new FakeWriteStream();
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);

    const result = await logEvent('sess-ok', { hello: 'world' });

    expect(result).toEqual({ ok: true });
    expect(fake.lines).toEqual([JSON.stringify({ hello: 'world' }) + '\n']);
  });

  test('a stream error is reported and suppresses further writes', async () => {
    const fake = new FakeWriteStream();
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // First write succeeds; the I/O error fires asynchronously afterwards —
    // mirroring a real WriteStream, where write() buffers and the underlying
    // fd errors on a later tick.
    expect(await logEvent('sess-err', { n: 1 })).toEqual({ ok: true });
    fake.emit('error', new Error('ENOSPC: no space left on device'));

    // Now suppressed, and the failure reason is surfaced on EVERY subsequent
    // call (so a late-attaching operator still gets the sticky notice).
    expect(await logEvent('sess-err', { n: 2 })).toEqual({ ok: false, reason: 'stream_error' });
    expect(await logEvent('sess-err', { n: 3 })).toEqual({ ok: false, reason: 'stream_error' });

    // Lines 2 and 3 were never written; we only complained to the console once.
    expect(fake.lines).toEqual([JSON.stringify({ n: 1 }) + '\n']);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  test('a drain timeout is reported and suppresses further writes', async () => {
    vi.useFakeTimers();
    const fake = new FakeWriteStream({ backpressure: true });
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // write() returns false → logEvent awaits drainOrTimeout; the stream never
    // emits 'drain', so the 5s timeout wins and the stream is given up on.
    const pending = logEvent('sess-drain', { n: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, reason: 'drain_timeout' });

    expect(await logEvent('sess-drain', { n: 2 })).toEqual({ ok: false, reason: 'drain_timeout' });
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

// [security] Register H01 — transcripts were created with the ambient umask.
//
// The JSONL files hold the full conversation for every session. `auth.ts`
// guarded the 64-byte token beside them at 0600 while these sat at 0644,
// readable by any other local account. Windows-gated exactly as
// `auth.test.ts:32` gates its own mode assertions: Node maps only the write
// bit there, so the check would fail on a difference that means nothing.
describe('[security] transcript permissions', () => {
  test('a new transcript is created owner-only', async () => {
    if (process.platform === 'win32') return;
    // A real stream, since the mode on disk is the point. This used to capture
    // the stream and await `end(resolve)` by hand, because
    // `createWriteStream` opens asynchronously and `closeLogger()` did not
    // wait — statting straight afterwards raced the open. Cebab-kji moved that
    // wait into `closeLogger` itself, so the workaround is gone and this reads
    // as the ordinary teardown it always should have been.
    await logEvent('sess-perm', { n: 1 });
    await closeLogger('sess-perm');

    const p = path.join(config.logsDir, 'sess-perm.jsonl');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(config.logsDir).mode & 0o777).toBe(0o700);
  });

  test('a transcript left 0644 by an earlier build is tightened on next use', async () => {
    // `createWriteStream`'s `mode` applies only on create, so appending to an
    // existing transcript would otherwise keep it world-readable forever.
    if (process.platform === 'win32') return;
    fs.mkdirSync(config.logsDir, { recursive: true });
    const p = path.join(config.logsDir, 'sess-old.jsonl');
    fs.writeFileSync(p, '{"old":1}\n');
    fs.chmodSync(p, 0o644);

    await logEvent('sess-old', { n: 2 });
    await closeLogger('sess-old');

    // Read before stat: a stat-then-read pair on one path is the check-then-use
    // shape CodeQL's js/file-system-race flags, and the ordering is arbitrary
    // here anyway.
    const contents = fs.readFileSync(p, 'utf8');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    // And the pre-existing content is still there — tightening, not clobbering.
    expect(contents).toContain('"old":1');
  });
});

// Cebab-kji. `closeLogger` used to return `void` while `end()` was still
// flushing and `createWriteStream`'s open was still in flight. Two callers
// were relying on it meaning "closed": test teardown, which then removed the
// directory out from under the open fd, and `shutdown.ts`, which then exited
// the process. These pin the promise, not the logging.
describe('closeLogger resolves only once the stream is really closed', () => {
  test('the stream is closed when the promise resolves, and not before', async () => {
    const fake = new FakeWriteStream();
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    await logEvent('sess-close', { n: 1 });

    const pending = closeLogger();
    // The fake closes on a later tick, exactly as fs.WriteStream does, so this
    // is the window the old `void` version returned in.
    expect(fake.closed).toBe(false);

    await pending;
    expect(fake.closed).toBe(true);
  });

  test('a stream that has not closed keeps the promise PENDING', async () => {
    // Anti-vacuity for the case above: a `closeLogger` that returned
    // `Promise.resolve()` immediately satisfies it, because the assertion
    // after the await would still find the fake closed by then.
    const fake = new FakeWriteStream({ neverCloses: true });
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    await logEvent('sess-pending', { n: 1 });

    let settled = false;
    void closeLogger().then(() => {
      settled = true;
    });
    // Several macrotasks — far more than the real close would need.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(settled).toBe(false);
    expect(fake.ended).toBe(true); // the close WAS initiated, just not finished
  });

  test('a wedged stream is released by the timeout rather than hanging', async () => {
    vi.useFakeTimers();
    const fake = new FakeWriteStream({ neverCloses: true });
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    await logEvent('sess-wedged', { n: 1 });

    let settled = false;
    void closeLogger().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(settled).toBe(true);
  });

  test('an ERRORED stream still resolves — the case that hangs on `finish`', async () => {
    // fs.WriteStream emits `'error'` when its open fails (the ENOENT this bug
    // is made of) and may never emit `'finish'`. It does emit `'close'`,
    // because autoClose is the default. Awaiting the wrong event turns the
    // teardown race into a teardown hang, which is worse.
    const fake = new FakeWriteStream();
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    await logEvent('sess-errored', { n: 1 });
    fake.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(closeLogger()).resolves.toBeUndefined();
  });

  test('it resolves from the CLOSE event, not by waiting out the timeout', async () => {
    // The timeout is a safety net, and a safety net makes every wrong
    // implementation eventually pass: awaiting `'finish'` (which fs.WriteStream
    // may never emit after a failed open) still resolves in 2s, so a plain
    // "does it resolve?" assertion cannot tell the two apart. Measured — that
    // revert reddened nothing until this case existed.
    //
    // Fake ONLY setTimeout, so the timeout budget can never elapse while the
    // fake's `setImmediate`-driven close still fires for real. A correct
    // implementation resolves here; one waiting on the wrong event hangs.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fake = new FakeWriteStream();
    __setStreamFactoryForTests(() => fake as unknown as fs.WriteStream);
    await logEvent('sess-event', { n: 1 });

    let settled = false;
    void closeLogger().then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(settled).toBe(true);
  });

  test('closing one session leaves the others open', async () => {
    const a = new FakeWriteStream();
    const b = new FakeWriteStream();
    __setStreamFactoryForTests((p) => (p.includes('sess-a') ? a : b) as unknown as fs.WriteStream);
    await logEvent('sess-a', { n: 1 });
    await logEvent('sess-b', { n: 1 });

    await closeLogger('sess-a');

    expect(a.closed).toBe(true);
    expect(b.ended).toBe(false);
  });

  test('closing an unknown session resolves without waiting', async () => {
    await expect(closeLogger('sess-never-opened')).resolves.toBeUndefined();
  });

  test('a write after close opens a FRESH stream, not the one being torn down', async () => {
    // The map is cleared before the await, so a concurrent `logEvent` must not
    // land in the stream that is closing.
    const first = new FakeWriteStream();
    const second = new FakeWriteStream();
    let made = 0;
    __setStreamFactoryForTests(() => (made++ === 0 ? first : second) as unknown as fs.WriteStream);
    await logEvent('sess-race', { n: 1 });

    const pending = closeLogger();
    await logEvent('sess-race', { n: 2 });
    await pending;

    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);
  });
});

describe('[security] the teardown ordering this exists to protect', () => {
  /** Spy on console.error and return the captured `[logger]` lines. */
  function captureLoggerErrors(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[logger]')) lines.push(first);
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  test('awaiting closeLogger before removing the dir emits no late [logger] error', async () => {
    // A REAL stream, because the defect is in the real one's async open.
    const { lines, restore } = captureLoggerErrors();
    await logEvent('sess-ordered', { n: 1 });
    await closeLogger();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    restore();

    expect(lines).toEqual([]);
    // The transcript really was written — otherwise this passes because
    // nothing ever opened a stream.
    expect(fs.existsSync(path.join(tmpRoot, '.cebab'))).toBe(false);
  });

  test('positive control: the stream DOES report a broken directory', async () => {
    // Without this, the case above proves only that `[logger]` never logs.
    // Removing the directory and then forcing a fresh open must produce the
    // very line the ordering is designed to avoid.
    const { lines, restore } = captureLoggerErrors();
    await logEvent('sess-control', { n: 1 });
    await closeLogger();
    // Break the OPEN specifically, not the mkdir: `streamFor` calls
    // `secureMkdir` synchronously and a broken directory would throw straight
    // out of `logEvent`, never reaching the stream's `'error'` handler — which
    // is the path under test. A directory sitting where the transcript file
    // goes lets the mkdir succeed and fails `createWriteStream`'s open, exactly
    // as the ENOENT does in CI.
    fs.rmSync(path.join(config.logsDir, 'sess-control.jsonl'), { force: true });
    fs.mkdirSync(path.join(config.logsDir, 'sess-control.jsonl'), { recursive: true });

    await logEvent('sess-control', { n: 2 }).catch(() => undefined);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    restore();

    expect(lines.some((l) => l.startsWith('[logger] write to sess-control.jsonl failed:'))).toBe(
      true,
    );
  });
});
