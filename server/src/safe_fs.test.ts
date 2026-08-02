/**
 * [security] Register H02 + H03 — the bounded, TOCTOU-safe reader.
 *
 * The three hazards this closes, each asserted below:
 *
 *   BLOCKING   a FIFO parks the event loop until a writer appears. On a
 *              single-threaded server that is the WHOLE server, not one
 *              request. Asserted with a real named pipe and a timeout, so a
 *              regression FAILS the suite instead of hanging it.
 *   UNBOUNDED  a huge file is read entirely into memory.
 *   WRONG TYPE a directory or device is not a file and must not be read.
 *
 * FIFO cases are POSIX-only — `mkfifo` does not exist on Windows, and the
 * O_NONBLOCK constant it depends on is absent there too. The size and type
 * cases run everywhere, so windows-2022 still covers the caps.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readFileBounded, readTextBounded } from './safe_fs.js';

const isWindows = process.platform === 'win32';
/** FIFO tests need mkfifo; skip the whole case on Windows rather than fake it. */
const posixOnly = isWindows ? test.skip : test;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-safe-fs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, contents: string | Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('[security] readFileBounded — the happy path still works', () => {
  test('reads a regular file whole', () => {
    const p = write('ok.txt', 'hello world');
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.toString('utf8')).toBe('hello world');
    expect(r.size).toBe(11);
  });

  test('reads an empty file as empty rather than refusing', () => {
    const p = write('empty.txt', '');
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(0);
  });

  test('a file exactly at the cap is allowed', () => {
    // Off-by-one guard: the check is `size > maxBytes`, so == must pass.
    const p = write('exact.bin', Buffer.alloc(100, 0x41));
    const r = readFileBounded(p, 100);
    expect(r.ok).toBe(true);
  });

  test('readTextBounded decodes utf8', () => {
    const p = write('utf8.txt', 'héllo — ok');
    const r = readTextBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('héllo — ok');
  });

  test('invalid utf8 becomes U+FFFD instead of throwing', () => {
    const p = write('bad.bin', Buffer.from([0xff, 0xfe, 0x41]));
    const r = readTextBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('A');
  });
});

describe('[security] readFileBounded — refusals', () => {
  test('refuses a file over the cap, and does not truncate it instead', () => {
    // The load-bearing distinction for H02: callers hash these bytes, so a
    // silent prefix would make different files compare equal. Over-cap must
    // be a REFUSAL, never a partial success.
    const p = write('big.bin', Buffer.alloc(2048, 0x42));
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('too_large');
  });

  test('refuses a directory', () => {
    const r = readFileBounded(tmp, 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Windows fails at open (a dir cannot be opened O_RDONLY); POSIX opens it
    // and fstat reports a directory. Both are refusals — that is what matters.
    expect(['not_a_file', 'unreadable']).toContain(r.refusal);
  });

  test('refuses a path that does not exist', () => {
    const r = readFileBounded(path.join(tmp, 'nope.txt'), 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('unreadable');
  });

  posixOnly(
    'refuses a FIFO WITHOUT hanging — the DoS this exists for',
    () => {
      const fifo = path.join(tmp, 'pipe');
      execFileSync('mkfifo', [fifo]);

      // No writer is ever attached. A plain fs.readFileSync here parks the
      // event loop forever; O_NONBLOCK makes the open return immediately.
      // The test itself is the assertion: without the fix this never returns
      // and vitest kills the run on its timeout.
      const started = Date.now();
      const r = readFileBounded(fifo, 1024);
      const elapsed = Date.now() - started;

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe('not_a_file');
      // Generous bound — a blocking open would sit here indefinitely, not for
      // two seconds. This asserts "returned promptly", not a latency budget.
      expect(elapsed).toBeLessThan(2000);
    },
    10_000,
  );

  posixOnly(
    'refuses a character device without reading it',
    () => {
      // /dev/zero is infinite: an unbounded read never terminates and eats
      // memory as fast as it can allocate.
      const r = readFileBounded('/dev/zero', 1024);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal).toBe('not_a_file');
    },
    10_000,
  );
});

describe('[security] readFileBounded — descriptor hygiene', () => {
  test('does not leak descriptors across many refused reads', () => {
    // A leak here would be a slow-motion DoS of its own: every pre-spawn
    // resolve that hits a hostile path would burn an fd until EMFILE.
    const dir = tmp;
    const missing = path.join(tmp, 'nope');
    const big = write('leak-big.bin', Buffer.alloc(4096, 0x43));
    const good = write('leak-good.txt', 'fine');

    for (let i = 0; i < 200; i++) {
      readFileBounded(dir, 1024);
      readFileBounded(missing, 1024);
      readFileBounded(big, 1024);
      readFileBounded(good, 1024);
    }

    // If the finally-block close were missing, 800 opens would have exhausted
    // the default fd limit long before here and this last read would fail.
    const r = readFileBounded(good, 1024);
    expect(r.ok).toBe(true);
  });
});
