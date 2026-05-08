import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

type StreamEntry = { stream: fs.WriteStream; failed: boolean };

const streams = new Map<string, StreamEntry>();

function streamFor(sessionId: string): StreamEntry {
  let entry = streams.get(sessionId);
  if (entry) return entry;
  fs.mkdirSync(config.logsDir, { recursive: true });
  const stream = fs.createWriteStream(path.join(config.logsDir, `${sessionId}.jsonl`), {
    flags: 'a',
  });
  entry = { stream, failed: false };
  stream.on('error', (err) => {
    if (!entry!.failed) {
      entry!.failed = true;
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

/** Append one JSON-encodable event. Honors backpressure; logs once on stream error. */
export async function logEvent(sessionId: string, payload: unknown): Promise<void> {
  const entry = streamFor(sessionId);
  if (entry.failed) return; // already complained once; don't loop
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
        console.error(`[logger] drain timeout on ${sessionId}.jsonl; suppressing further writes`);
      }
    }
  }
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
