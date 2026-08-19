import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import { createChainRouter } from './chain.js';
import { createOrchestratorRouter } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import type { MultiAgentEndedReason } from './runtime.js';

/**
 * Register B09: `router.teardown()` never stopped the runner — only
 * `handle.stop()` did. So the operator's Stop button was clean and every
 * other exit was not: a budget-exhaust or a crash reported `ended` while an
 * in-flight SDK turn kept running, which is the leak `runner/lifecycle.ts`
 * exists to prevent.
 *
 * The router cannot fix that itself: it has no `runner` in scope, which is
 * exactly why it never did. The seam is `onFinalize`, already passed in by
 * the handle factory (which does have the runner) and already called first
 * inside `teardown` for the same class of cleanup. This suite pins the part
 * the router owns — that `onFinalize` is invoked with the REASON, which is
 * what lets the handle exempt a completion.
 *
 * The exemption itself is guarded by `mock_replay.test.ts`: a chain completes
 * from inside the last turn's `bus_send`, before that turn's `result`, and
 * the `--resume` checkpoint is written on `result`. Aborting on completion
 * destroys it, and that test times out when you do — it is what caught this
 * while the change was being written.
 */

withTempDataDir('cebab-teardown-finalize-');

function chainRouter(sessionId: string, onFinalize: (r: MultiAgentEndedReason) => void) {
  createMultiAgentSession(sessionId, 'chain', 'iter-1');
  return createChainRouter({
    sessionId,
    iterationId: 'iter-1',
    agentNames: ['alpha', 'beta'],
    paths: computeSessionPaths(sessionId),
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    onFinalize,
    hopBudget: 100,
  });
}

function orchestratorRouter(sessionId: string, onFinalize: (r: MultiAgentEndedReason) => void) {
  createMultiAgentSession(sessionId, 'orchestrator', 'iter-1');
  return createOrchestratorRouter({
    sessionId,
    iterationId: 'iter-1',
    workerNames: ['alpha'],
    paths: computeSessionPaths(sessionId),
    lifecycle: 'temp',
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    onFinalize,
    hopBudget: 100,
  });
}

describe('teardown tells its finalizer WHY the session ended', () => {
  test.each(['stopped', 'crashed', 'completed'] as const)(
    'chain: onFinalize receives %s',
    async (reason) => {
      const onFinalize = vi.fn();
      const router = chainRouter(`chain-fin-${reason}`, onFinalize);
      await router.teardown(reason);
      expect(onFinalize).toHaveBeenCalledWith(reason);
    },
  );

  test.each(['stopped', 'crashed', 'completed'] as const)(
    'orchestrator: onFinalize receives %s',
    async (reason) => {
      const onFinalize = vi.fn();
      const router = orchestratorRouter(`orch-fin-${reason}`, onFinalize);
      await router.teardown(reason);
      expect(onFinalize).toHaveBeenCalledWith(reason);
    },
  );

  test('it still fires exactly once per session, ended-guarded', async () => {
    const onFinalize = vi.fn();
    const router = chainRouter('chain-fin-once', onFinalize);
    await router.teardown('stopped');
    await router.teardown('crashed');
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two handle factories are what actually call `runner.stop()`, inside
 * closures that a unit test cannot reach without standing up a whole session.
 * The defect they encode is a DIVERGENCE — one exit path stops the runner and
 * another does not — so the honest guard is to read both closures and require
 * them to agree, the same shape register B11's two `onEnded` closures needed.
 */
describe('both bus handles stop the runner, and both exempt a completion', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url));

  test.each(['orchestrator.ts', 'chain.ts'])('%s guards runner.stop on the reason', (file) => {
    // Split on \r?\n: no .gitattributes, so Windows CI reads these CRLF.
    const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split(/\r?\n/);
    // Strip comment lines FIRST. The prose above each guard explains
    // `runner.stop()` by name, so a naive substring scan counts the
    // explanation as a call — the hole that let a deleted `--exclude` flag
    // ship green in PR #298, hit again here while writing this very test.
    const code = lines.filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const stopLines = code.filter((l) => l.includes('runner.stop()'));
    // Two: the handle's explicit `stop()` verb, and the onFinalize guard.
    expect(stopLines.length, `${file} should call runner.stop() twice`).toBe(2);
    const guarded = stopLines.filter((l) => l.includes("reason !== 'completed'"));
    expect(
      guarded.length,
      `${file}: exactly one runner.stop() must be the reason-guarded onFinalize one`,
    ).toBe(1);
  });
});
