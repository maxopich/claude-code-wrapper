import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { runClaude, type RunOptions } from './claude.js';
import { runMock, type MockOptions } from './mock.js';

/**
 * Common shape exposed by both the live SDK Query and the mock fixture replay.
 * Keeps `interrupt` and `setPermissionMode` reachable from the WS layer so we
 * can flip permission mode mid-session and stop runs gracefully.
 */
export type Runner = AsyncIterable<SDKMessage> & {
  close?: () => void;
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
};

/** Picks live SDK vs fixture replay based on MOCK env var. */
export function pickRunner(opts: RunOptions & Partial<MockOptions>): Runner {
  return config.mock ? runMock(opts) : runClaude(opts);
}

export { runClaude, runMock };
export type { RunOptions, MockOptions };
