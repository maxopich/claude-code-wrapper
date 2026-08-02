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
  private readonly backpressure: boolean;
  constructor(opts: { backpressure?: boolean } = {}) {
    super();
    this.backpressure = opts.backpressure ?? false;
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

afterEach(() => {
  closeLogger(); // clear the module-level streams map between cases
  __setStreamFactoryForTests(null);
  config.dataDir = originalDataDir;
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    // A real stream, since the mode on disk is the point — but captured, so
    // the assertion can wait for the fd. `createWriteStream` opens
    // asynchronously and `closeLogger()`'s `end()` does not block, so statting
    // straight afterwards races the open. The opts still come from
    // `streamFor`, so this exercises the production mode, not the test's.
    let captured: fs.WriteStream | null = null;
    __setStreamFactoryForTests((filePath, opts) => {
      captured = fs.createWriteStream(filePath, opts);
      return captured;
    });

    await logEvent('sess-perm', { n: 1 });
    await new Promise<void>((resolve) => captured!.end(resolve));

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
    closeLogger();

    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    // And the pre-existing content is still there — tightening, not clobbering.
    expect(fs.readFileSync(p, 'utf8')).toContain('"old":1');
  });
});
