import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const streams = new Map<string, fs.WriteStream>();

function streamFor(sessionId: string): fs.WriteStream {
  let s = streams.get(sessionId);
  if (s) return s;
  fs.mkdirSync(config.logsDir, { recursive: true });
  s = fs.createWriteStream(path.join(config.logsDir, `${sessionId}.jsonl`), { flags: 'a' });
  streams.set(sessionId, s);
  return s;
}

/** Append one JSON-encodable event. Caller passes the object as-is; we serialize. */
export function logEvent(sessionId: string, payload: unknown): void {
  streamFor(sessionId).write(JSON.stringify(payload) + '\n');
}

export function closeLogger(sessionId?: string): void {
  if (sessionId) {
    streams.get(sessionId)?.end();
    streams.delete(sessionId);
    return;
  }
  for (const s of streams.values()) s.end();
  streams.clear();
}
