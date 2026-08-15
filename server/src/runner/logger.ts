import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { newFileMode, secureFile, secureMkdir } from '../data_perms.js';

export type LogFailureReason = 'stream_error' | 'drain_timeout';
export type LogWriteResult = { ok: true } | { ok: false; reason: LogFailureReason };

type StreamEntry = { stream: fs.WriteStream; failed: boolean; reason?: LogFailureReason };

const streams = new Map<string, StreamEntry>();

// Test seam: overridable so a unit test can inject a fake WriteStream that
// emits 'error' or stays `writableNeedDrain` deterministically, rather than
// relying on OS-specific unwritable paths (CI runs ubuntu + windows).
let createStream: (filePath: string, opts: { flags: string; mode?: number }) => fs.WriteStream = (
  filePath,
  opts,
) => fs.createWriteStream(filePath, opts);

/** @internal test-only: override the write-stream factory (or reset with `null`). */
export function __setStreamFactoryForTests(fn: typeof createStream | null): void {
  createStream = fn ?? ((filePath, opts) => fs.createWriteStream(filePath, opts));
}

function streamFor(sessionId: string): StreamEntry {
  let entry = streams.get(sessionId);
  if (entry) return entry;
  // H01: transcripts hold the full conversation, so they are owner-only. The
  // `mode` applies on creation; `secureFile` covers a transcript written by a
  // build that predates this (the boot sweep gets the rest).
  secureMkdir(config.logsDir);
  const logPath = path.join(config.logsDir, `${sessionId}.jsonl`);
  const stream = createStream(logPath, { flags: 'a', mode: newFileMode() });
  secureFile(logPath);
  entry = { stream, failed: false };
  stream.on('error', (err) => {
    if (!entry!.failed) {
      entry!.failed = true;
      entry!.reason = 'stream_error';
      console.error(`[logger] write to ${sessionId}.jsonl failed:`, err);
    }
  });
  streams.set(sessionId, entry);
  return entry;
}

/** How long we'll wait on a single drain cycle before giving up on the stream. */
const DRAIN_TIMEOUT_MS = 5000;

function drainOrTimeout(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      resolve();
    }, DRAIN_TIMEOUT_MS);
    once(stream, 'drain', { signal: ac.signal })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Append one JSON-encodable event. Honors backpressure. Returns a result so
 * the caller can surface a failure to the operator: once a session's stream
 * hits a write `'error'` or a drain timeout it is suppressed for the rest of
 * that session's life (the `failed` flag is sticky, as before), and every
 * subsequent call returns `{ ok: false, reason }`. Returning on every call
 * (not just the first) lets the caller emit a coalesced/sticky notification
 * that a late-attaching operator still sees. Still logs once to the console
 * on the first failure.
 */
export async function logEvent(sessionId: string, payload: unknown): Promise<LogWriteResult> {
  const entry = streamFor(sessionId);
  if (entry.failed) return { ok: false, reason: entry.reason ?? 'stream_error' };
  const line = JSON.stringify(payload) + '\n';
  const ok = entry.stream.write(line);
  if (!ok) {
    // Race the drain against a 5s timeout so a wedged FS handle (full disk on
    // some filesystems, locked NFS) can't stall every subsequent persist.
    await drainOrTimeout(entry.stream);
    if (entry.stream.writableNeedDrain) {
      // Still backed up after the timeout — give up on this stream.
      if (!entry.failed) {
        entry.failed = true;
        entry.reason = 'drain_timeout';
        console.error(`[logger] drain timeout on ${sessionId}.jsonl; suppressing further writes`);
      }
      return { ok: false, reason: 'drain_timeout' };
    }
  }
  // A write `'error'` can fire asynchronously (during the await above, or on a
  // later tick); surface it on this call if it already landed.
  if (entry.failed) return { ok: false, reason: entry.reason ?? 'stream_error' };
  return { ok: true };
}

/** How long a single stream gets to finish closing before we stop waiting. */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Resolve when `stream` has actually closed, or when the budget runs out.
 *
 * Waits for `'close'` rather than `'finish'` on purpose. A stream whose
 * `open(2)` failed emits `'error'` and may never emit `'finish'`, so awaiting
 * the latter would hang exactly the case this exists for; `fs.WriteStream`
 * defaults to `autoClose`, so `'close'` follows `'error'` too. An
 * already-closed stream resolves immediately rather than waiting for an event
 * that has been and gone.
 *
 * The timeout is shorter than `DRAIN_TIMEOUT_MS` deliberately: a caller that
 * reaches here has already given up on the data, and this budget is spent
 * inside a SIGINT handler that the shutdown failsafe will kill at 3s.
 */
function closedOrTimeout(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      stream.off('close', done);
      resolve();
    }, CLOSE_TIMEOUT_MS);
    // `.unref()` where available: a pending timer must not be the reason a
    // clean shutdown stays alive.
    timer.unref?.();
    stream.once('close', done);
    stream.end();
  });
}

/**
 * Close the session's transcript stream (or every stream), and **resolve once
 * it is really closed**.
 *
 * The returned promise is the point. `stream.end()` does not block, and
 * `fs.createWriteStream` opens its fd on a later tick, so the old `void`
 * version returned while a write — or even the initial `open` — was still in
 * flight. Two consequences, one per caller:
 *
 *   - a test that removed its temp data dir straight afterwards raced that
 *     `open`, which then failed `ENOENT` and logged from the stream's `'error'`
 *     handler AFTER the test had finished. vitest ships console output to its
 *     parent over rpc, and a line landing during worker teardown fails the
 *     whole run with every test green (`Cebab-kji`);
 *   - `shutdown.ts` called this and then `process.exit`, so a Ctrl+C could
 *     drop buffered transcript bytes.
 *
 * The map is cleared BEFORE awaiting so a concurrent `logEvent` opens a fresh
 * stream instead of writing into one being torn down. Callers that do not care
 * may still ignore the promise — the close is initiated synchronously either
 * way.
 */
export function closeLogger(sessionId?: string): Promise<void> {
  if (sessionId) {
    const entry = streams.get(sessionId);
    streams.delete(sessionId);
    if (!entry) return Promise.resolve();
    return closedOrTimeout(entry.stream);
  }
  const entries = [...streams.values()];
  streams.clear();
  return Promise.all(entries.map((e) => closedOrTimeout(e.stream))).then(() => undefined);
}
