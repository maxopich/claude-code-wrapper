import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type LogFailureReason = 'stream_error' | 'drain_timeout';
export type LogWriteResult = { ok: true } | { ok: false; reason: LogFailureReason };

type StreamEntry = { stream: fs.WriteStream; failed: boolean; reason?: LogFailureReason };

const streams = new Map<string, StreamEntry>();

// Test seam: overridable so a unit test can inject a fake WriteStream that
// emits 'error' or stays `writableNeedDrain` deterministically, rather than
// relying on OS-specific unwritable paths (CI runs ubuntu + windows).
let createStream: (filePath: string, opts: { flags: string }) => fs.WriteStream = (
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
  fs.mkdirSync(config.logsDir, { recursive: true });
  const stream = createStream(path.join(config.logsDir, `${sessionId}.jsonl`), {
    flags: 'a',
  });
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

export function closeLogger(sessionId?: string): void {
  if (sessionId) {
    streams.get(sessionId)?.stream.end();
    streams.delete(sessionId);
    return;
  }
  for (const e of streams.values()) e.stream.end();
  streams.clear();
}
