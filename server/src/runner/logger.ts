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
 * Closes that have been INITIATED but not yet finished.
 *
 * `Cebab-ndd7`: `closeLogger(sessionId)` is called **fire-and-forget** from
 * `runOneTurn`'s `finally` (`ws/server.ts`) — it removes the session from
 * `streams` and starts the close without awaiting it. That is correct for
 * production (a turn's teardown must not block on a flush), but it means the
 * all-sessions `closeLogger()` — the awaited line a test teardown runs before
 * `fs.rmSync` — would find an EMPTY map and resolve while the just-ended turn's
 * stream had not even OPENED its file yet (`fs.WriteStream` opens
 * asynchronously). The `rmSync` removes the directory first, the deferred open
 * fails with ENOENT, and the stream's `'error'` handler logs a `[logger]` line
 * AFTER the test finished: the exact `Cebab-kji` teardown race, but one the
 * rmSync-ordering gate cannot see because the test file IS compliant. Measured:
 * a late ENOENT line on every driven turn before this, none after. Tracking the in-flight closes here
 * makes `closeLogger()` mean "every close is done" — including one another
 * caller already started — rather than only "every close I could still see".
 */
const pendingCloses = new Set<Promise<void>>();

/**
 * How many closes are still in flight. Test-only: the set must drain as each
 * close finishes — `runOneTurn` starts one per turn, so a close that stayed in
 * the set would grow it for the life of the server.
 * @internal
 */
export function __pendingCloseCountForTests(): number {
  return pendingCloses.size;
}

/** Close `stream`, and keep the pending promise visible to a later `closeLogger()`. */
function trackedClose(stream: fs.WriteStream): Promise<void> {
  const done = closedOrTimeout(stream);
  pendingCloses.add(done);
  void done.finally(() => pendingCloses.delete(done));
  return done;
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
 * stream instead of writing into one being torn down. The all-sessions form
 * also awaits any close a fire-and-forget `closeLogger(sessionId)` already
 * started (`pendingCloses`, `Cebab-ndd7`). Callers that do not care may still
 * ignore the promise — the close is initiated synchronously either way.
 */
export function closeLogger(sessionId?: string): Promise<void> {
  if (sessionId) {
    const entry = streams.get(sessionId);
    streams.delete(sessionId);
    if (!entry) return Promise.resolve();
    return trackedClose(entry.stream);
  }
  const entries = [...streams.values()];
  streams.clear();
  entries.forEach((e) => trackedClose(e.stream));
  // Await every close still in flight, including any a fire-and-forget
  // `closeLogger(sessionId)` started but did not await.
  return Promise.all([...pendingCloses]).then(() => undefined);
}
