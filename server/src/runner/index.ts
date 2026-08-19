import type { ModelInfo, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { runClaude, type RunOptions } from './claude.js';
import { runMock, type MockOptions } from './mock.js';

/**
 * Common shape exposed by both the live SDK Query and the mock fixture replay.
 * Keeps `interrupt` and `setPermissionMode` reachable from the WS layer so we
 * can flip permission mode mid-session and stop runs gracefully.
 *
 * `interrupt` resolves to `unknown`, not `void`, ON PURPOSE. The SDK changed
 * `Query.interrupt()` from `Promise<void>` to
 * `Promise<SDKControlInterruptResponse | undefined>` in a patch release
 * (0.3.201 → 0.3.216), which made `Query` stop satisfying this type and broke
 * `pickRunner`'s return. Nothing here consumes the resolved value — the sole
 * caller (`executeInterrupt` in ws/server.ts) uses it purely as a completion
 * signal, `.then(emitAck)` with a zero-arg callback. Typing it `unknown`
 * accepts whatever the SDK settles on without pinning us to one version's
 * response shape, and keeps the mock's `Promise<void>` assignable too. Widen
 * the annotation rather than importing the SDK's response type: the value is
 * genuinely unused, and naming the type would just re-break on the next
 * rename.
 */
export type Runner = AsyncIterable<SDKMessage> & {
  close?: () => void;
  interrupt?: () => Promise<unknown>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  /**
   * The CLI's own list of models this account may run (Cebab-ws0.3). Optional
   * for the same reason the two above are: the live runner IS the SDK `Query`
   * and already implements it, the mock does not, and every caller must cope
   * with a runner that cannot answer.
   *
   * Measured before being relied on: unlike `setModel` and `setPermissionMode`,
   * this is NOT streaming-input-only, so it works in Cebab's one-subprocess-
   * per-message mode. It also resolves in ~0ms, because the list arrives with
   * the initialize handshake rather than costing a round trip — which is what
   * makes asking for it during the authority probe free.
   */
  supportedModels?: () => Promise<ModelInfo[]>;
};

/** Picks live SDK vs fixture replay based on MOCK env var. */
export function pickRunner(opts: RunOptions & Partial<MockOptions>): Runner {
  return config.mock ? runMock(opts) : runClaude(opts);
}

export { runClaude, runMock };
export type { RunOptions, MockOptions };
