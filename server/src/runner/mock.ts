import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunOptions } from "./claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixturesDir(): string {
  // src/runner/mock.ts → ../../../fixtures (or dist/runner/mock.js → ../../../fixtures)
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "fixtures"),
    path.resolve(__dirname, "..", "..", "fixtures"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`fixtures dir not found, tried: ${candidates.join(", ")}`);
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
export function runMock(opts: MockOptions): AsyncIterable<SDKMessage> & { close: () => void } {
  const file = path.join(fixturesDir(), opts.fixture ?? "hello.jsonl");
  if (!fs.existsSync(file)) throw new Error(`fixture not found: ${file}`);
  const intervalMs = opts.intervalMs ?? 50;
  const sessionId = opts.sessionId ?? opts.resume ?? "mock-session";

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let cancelled = false;
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      opts.abortController?.signal.addEventListener("abort", onAbort, { once: true });
    });

  async function* iter(): AsyncGenerator<SDKMessage, void, unknown> {
    for (const line of lines) {
      if (cancelled || opts.abortController?.signal.aborted) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerant: skip bad lines, the consumer's parse_error path is for SDK output
      }
      parsed.session_id = sessionId;
      yield parsed as unknown as SDKMessage;
      await sleep(intervalMs).catch(() => {
        cancelled = true;
      });
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
  };
}
