/**
 * Tails the bus log file and emits parsed JSONL events.
 *
 * The bus.log is append-only JSONL written by `bus-send-msg.sh` (workers)
 * and by Cebab itself (`appendBusLogEvent` helper). Each line is one event:
 *
 *     {"ts":...,"source":"...","destination":"...","kind":"...","text":"..."}
 *
 * This tailer is the bridge between filesystem state and the WS layer: it
 * watches the file, parses each new line, and hands the event to the
 * `onEvent` callback (which the chain runtime turns into `multi_agent_event`
 * ServerMsgs).
 *
 * Implementation: `fs.watch` on the file, plus a tracked read position.
 * Partial trailing lines are buffered until the next newline arrives — the
 * writer may flush a header before the body has hit disk.
 *
 * macOS-only by Cebab's overall constraint; uses FSEvents under the hood.
 * Tolerates "not yet present" by deferring the open until the file appears
 * (caller can start the tailer before the first event is written).
 */
import fs from 'node:fs';
import { busLogPath } from './paths.js';

export type BusLogEvent = {
  ts: number;
  source: string;
  destination: string;
  kind: string;
  text: string;
};

export type BusLogTailerHandle = {
  /** Stop watching. Idempotent. */
  stop: () => void;
};

export type TailBusLogOpts = {
  /** Where to start reading. Default: from EOF (only new events). */
  from?: 'eof' | 'start';
  /** Override path (tests). Default: ~/.cebab/bus/bus.log. */
  path?: string;
  /** Called once per parsed event. */
  onEvent: (ev: BusLogEvent) => void;
  /** Called when a line fails to parse. Default: log a warning. */
  onParseError?: (line: string, err: unknown) => void;
};

export function tailBusLog(opts: TailBusLogOpts): BusLogTailerHandle {
  const path = opts.path ?? busLogPath();
  const from = opts.from ?? 'eof';
  const onParseError =
    opts.onParseError ??
    ((line: string, err: unknown) => console.warn(`[bus-log] bad JSONL line: ${line}`, err));

  let position = 0;
  let buffer = '';
  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  function readChunk(): void {
    if (stopped) return;
    try {
      const fd = fs.openSync(path, 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size < position) {
          // File was truncated (rare — operator wiped logs). Reset.
          position = 0;
          buffer = '';
        }
        const remaining = stat.size - position;
        if (remaining <= 0) return;
        const buf = Buffer.alloc(remaining);
        fs.readSync(fd, buf, 0, remaining, position);
        position = stat.size;
        buffer += buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return; // file vanished — wait for it
      throw err;
    }

    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) emitLine(line);
      nl = buffer.indexOf('\n');
    }
  }

  function emitLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      onParseError(line, err);
      return;
    }
    const ev = validateEvent(parsed);
    if (!ev) {
      onParseError(line, new Error('shape mismatch'));
      return;
    }
    opts.onEvent(ev);
  }

  function start(): void {
    if (stopped) return;
    try {
      const stat = fs.statSync(path);
      position = from === 'start' ? 0 : stat.size;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      position = 0;
    }
    // Use fs.watch on the parent directory in case the file is recreated.
    // fs.watch on the file itself is fine in steady state, but if `bus.log`
    // is briefly removed (e.g. operator `rm` to test recovery), the watch
    // dies. Watching the parent gives us the create event.
    const parent = path.replace(/\/[^/]+$/, '');
    watcher = fs.watch(parent, { persistent: false }, (_event, filename) => {
      // `filename` is the basename of the changed entry. Multiple events
      // may fire per write; readChunk is idempotent and seeks to the last
      // known position so spurious wakes are cheap.
      if (filename && !path.endsWith(`/${filename}`)) return;
      try {
        readChunk();
      } catch (err) {
        console.error('[bus-log] readChunk failed', err);
      }
    });
    // Also do an initial drain in case events landed between stat and the
    // watcher attaching.
    try {
      readChunk();
    } catch (err) {
      console.error('[bus-log] initial readChunk failed', err);
    }
  }

  start();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      watcher = null;
    },
  };
}

function validateEvent(v: unknown): BusLogEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ts !== 'number') return null;
  if (typeof o.source !== 'string') return null;
  if (typeof o.destination !== 'string') return null;
  if (typeof o.kind !== 'string') return null;
  if (typeof o.text !== 'string') return null;
  return {
    ts: o.ts,
    source: o.source,
    destination: o.destination,
    kind: o.kind,
    text: o.text,
  };
}

/**
 * Append a single JSONL event to the bus log. Mirrors the format that
 * `bus-send-msg.sh` writes so the tailer can't tell Cebab-originated events
 * apart from agent-originated ones. Used when Cebab itself is the source
 * (e.g. emitting a chain briefing).
 */
export function appendBusLogEvent(
  ev: Omit<BusLogEvent, 'ts'> & { ts?: number },
  path: string = busLogPath(),
): BusLogEvent {
  const full: BusLogEvent = {
    ts: ev.ts ?? Date.now(),
    source: ev.source,
    destination: ev.destination,
    kind: ev.kind,
    text: ev.text,
  };
  fs.appendFileSync(path, JSON.stringify(full) + '\n');
  return full;
}
