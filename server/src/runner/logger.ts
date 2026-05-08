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

/** Append one JSON-encodable event. Honors backpressure; logs once on stream error. */
export async function logEvent(sessionId: string, payload: unknown): Promise<void> {
  const entry = streamFor(sessionId);
  if (entry.failed) return; // already complained once; don't loop
  const line = JSON.stringify(payload) + '\n';
  const ok = entry.stream.write(line);
  if (!ok) {
    try {
      await once(entry.stream, 'drain');
    } catch {
      // 'error' will already have fired; the failed flag will be set.
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
