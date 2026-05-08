import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunOptions } from './claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixturesDir(): string {
  // src/runner/mock.ts → ../../../fixtures (or dist/runner/mock.js → ../../../fixtures)
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'fixtures'),
    path.resolve(__dirname, '..', '..', 'fixtures'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`fixtures dir not found, tried: ${candidates.join(', ')}`);
  return found;
}

export type MockOptions = RunOptions & {
  /** Fixture filename under fixtures/. Defaults to "hello.jsonl". */
  fixture?: string;
  /** Delay between yielded events in ms. Default 50. */
  intervalMs?: number;
};

/**
 * Async-iterable that mimics the real SDK Query but yields events from a fixture.
 * The yielded objects have their `session_id` rewritten to match the active session,
 * so downstream persistence and WS forwarding work without surprises.
 */
export function runMock(opts: MockOptions): AsyncIterable<SDKMessage> & {
  close: () => void;
  interrupt: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
} {
  const file = path.join(fixturesDir(), opts.fixture ?? 'hello.jsonl');
  if (!fs.existsSync(file)) throw new Error(`fixture not found: ${file}`);
  const intervalMs = opts.intervalMs ?? 50;
  const sessionId = opts.sessionId ?? opts.resume ?? 'mock-session';

  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let cancelled = false;
  // Single listener for the whole run rather than one per sleep iteration —
  // long fixtures previously accumulated O(n) listeners on the signal.
  opts.abortController?.signal.addEventListener(
    'abort',
    () => {
      cancelled = true;
    },
    { once: true },
  );

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  async function* iter(): AsyncGenerator<SDKMessage, void, unknown> {
    for (const line of lines) {
      if (cancelled) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerant: skip bad lines, the consumer's parse_error path is for SDK output
      }
      parsed.session_id = sessionId;
      yield parsed as unknown as SDKMessage;
      if (cancelled) return;
      await sleep(intervalMs);
    }
  }

  const it = iter();
  return {
    [Symbol.asyncIterator]() {
      return it;
    },
    close() {
      cancelled = true;
    },
    async interrupt() {
      cancelled = true;
    },
    async setPermissionMode() {
      // no-op in mock; real Query forwards to the spawned claude
    },
  };
}
