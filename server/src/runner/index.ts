import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { runClaude, type RunOptions } from "./claude.js";
import { runMock, type MockOptions } from "./mock.js";

/** Picks live SDK vs fixture replay based on MOCK env var. */
export function pickRunner(opts: RunOptions & Partial<MockOptions>): AsyncIterable<SDKMessage> {
  return config.mock ? runMock(opts) : runClaude(opts);
}

export { runClaude, runMock };
export type { RunOptions, MockOptions };
