import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { startChainSession } from './chain.js';
import { startOrchestratorSession, ORCHESTRATOR_AGENT_NAME } from './orchestrator.js';
import { unregisterLiveSession } from './session_registry.js';
import {
  getMultiAgentSession,
  listAgentSessions,
  listMultiAgentEvents,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import * as safetyAudit from '../notifications/safety_audit.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, SINK_RECIPIENT, USER_RECIPIENT, type ResolvedAgent } from './runtime.js';
import { closeLogger } from '../runner/logger.js';

// F13: end-to-end bus replay through the REAL `pickRunner` seam.
//
// Every other bus test injects a hand-built `runnerFactory`, so nothing
// exercised what `MOCK=1` actually does to a multi-agent session. What it did
// was nothing: the mock replayed fixture lines without executing tool calls,
// agents advance a bus session only by calling `bus_send`, so the first
// participant spoke into the void and no second participant was ever woken.
// The whole MultiAgentTab was unreachable without burning real quota.
//
// These two tests deliberately set `config.mock` and pass NO runnerFactory —
// they fail if the mock stops driving the bus, which is the regression that
// went unnoticed for the life of the feature.

let tmpRoot: string;
let originalDataDir: string;
let originalMock: boolean;
let originalInterval: number;
let originalScenario: string | null;
const started: string[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mock-replay-'));
  originalDataDir = config.dataDir;
  originalMock = config.mock;
  originalInterval = config.mockIntervalMs;
  originalScenario = config.mockScenario;
  config.dataDir = path.join(tmpRoot, '.cebab');
  config.mock = true;
  config.mockIntervalMs = 0;
  config.mockScenario = null; // each router picks its own shipped default
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(async () => {
  for (const id of started.splice(0)) unregisterLiveSession(id);
  closeDb();
  config.dataDir = originalDataDir;
  config.mock = originalMock;
  config.mockIntervalMs = originalInterval;
  config.mockScenario = originalScenario;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function participant(name: string): ResolvedAgent {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const proj = upsertProject(name, dir);
  return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
}

function workspace(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Poll until `predicate` holds. The bus dispatches hops fire-and-forget, so
 *  there is no promise to await for "the run finished". */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Agent-originated hops only — Cebab's own briefings/prompt are scaffolding. */
function agentHops(sessionId: string) {
  return listMultiAgentEvents(sessionId)
    .filter((e) => e.source !== CEBAB_SOURCE)
    .map((e) => `${e.source}->${e.destination}:${e.kind}`);
}

describe('MOCK=1 chain replay', () => {
  test('runs the fixture pipeline end to end and completes', async () => {
    const ws = workspace('chain-ws');
    const onEnded = vi.fn();
    const handle = await startChainSession({
      participants: [participant('alpha'), participant('beta'), participant('gamma')],
      initialPrompt: 'do the task',
      workspaceRoot: ws,
      onEvent: vi.fn(),
      onEnded,
      // No runnerFactory: this must go through pickRunner → runMock.
    });
    started.push(handle.sessionId);

    await waitUntil(() => onEnded.mock.calls.length > 0, 'the chain to end');

    // Every participant took its hop, the last one closed the chain.
    expect(agentHops(handle.sessionId)).toEqual([
      'alpha->beta:reply',
      'beta->gamma:reply',
      `gamma->${SINK_RECIPIENT}:final`,
    ]);
    expect(onEnded).toHaveBeenCalledWith(handle.sessionId, 'completed', handle.iterationId);
    expect(getMultiAgentSession(handle.sessionId)!.status).toBe('completed');

    // The terminal hop wrote the run's answer.
    const paths = computeSessionPaths(handle.sessionId);
    const finalMd = fs.readFileSync(
      path.join(paths.iterationDir(handle.iterationId), 'final.md'),
      'utf8',
    );
    expect(finalMd).toContain('[mock replay]');

    // The chain reports `completed` from inside the last participant's
    // `bus_send`, i.e. BEFORE that turn's `result` message — and the
    // `--resume` checkpoint is only written on `result`. So gamma's row
    // lands a beat after `onEnded`; waiting for it is the honest assertion.
    await waitUntil(
      () => listAgentSessions(handle.sessionId).length === 3,
      "the last participant's checkpoint",
    );
    // Each participant checkpointed under its OWN id — with one shared
    // 'mock-session' literal these rows would be indistinguishable and a
    // reconstruction would resume the wrong lineage.
    const rows = listAgentSessions(handle.sessionId);
    expect(rows.map((r) => r.agent_name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(new Set(rows.map((r) => r.cli_session_id)).size).toBe(3);

    // The fixture's `result` carries a cost, so mock runs exercise the F7
    // accounting path rather than leaving it live-only.
    expect(getMultiAgentSession(handle.sessionId)!.total_cost_usd).toBeGreaterThan(0);
  }, 20_000);
});

describe('MOCK=1 orchestrator replay', () => {
  test('delegates, collects the worker reply, and answers the operator', async () => {
    const ws = workspace('orch-ws');
    const onEnded = vi.fn();
    const handle = await startOrchestratorSession({
      workers: [participant('worker-one')],
      initialPrompt: 'look into this',
      workspaceRoot: ws,
      onEvent: vi.fn(),
      onEnded,
    });
    started.push(handle.sessionId);

    // Unlike a chain, an orchestrated run does NOT end when the answer lands:
    // `dest=user` delivers it and the session stays open for the operator's
    // follow-up. The completion signal is the final hop, not `onEnded`.
    await waitUntil(
      () => agentHops(handle.sessionId).some((h) => h.endsWith(`->${USER_RECIPIENT}:final`)),
      'the final answer to reach the operator',
    );

    // Delegate → reply → final. The orchestrator's second turn resolves to the
    // agent-wide script because no `orchestrator.1.jsonl` exists, which is how
    // a shipped scenario terminates without knowing the hop count in advance.
    expect(agentHops(handle.sessionId)).toEqual([
      `${ORCHESTRATOR_AGENT_NAME}->worker-one:prompt`,
      `worker-one->${ORCHESTRATOR_AGENT_NAME}:reply`,
      `${ORCHESTRATOR_AGENT_NAME}->${USER_RECIPIENT}:final`,
    ]);
    expect(onEnded).not.toHaveBeenCalled();

    const rows = listAgentSessions(handle.sessionId);
    expect(rows.map((r) => r.agent_name).sort()).toEqual([ORCHESTRATOR_AGENT_NAME, 'worker-one']);
    // The orchestrator ran twice and the worker once, each resuming its own
    // checkpoint rather than a shared literal.
    expect(new Set(rows.map((r) => r.cli_session_id)).size).toBe(2);
  }, 20_000);

  // Cebab-vie.21: the execute-mode grant fails CLOSED on the OPERATOR-REACHABLE
  // path (the execute-mode checkbox is orchestrator-only). This drives the real
  // `startOrchestratorSession`, which has no `runnerFactory` seam and calls
  // `deliver` un-awaited — so `config.mock = true` (set in beforeEach) is what
  // stops it spawning a real claude subprocess. When the audit append fails the
  // roster prompt the orchestrator is handed carries the CONSULTANT clause, not
  // the execute clause — asserting on the column alone would miss that the
  // orchestrator is still told to relay "Execute mode" to every worker.
  test('[security] a failing audit append briefs the orchestrator in consultant mode', async () => {
    const ws = workspace('orch-broken-ws');
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    let handle;
    try {
      handle = await startOrchestratorSession({
        workers: [participant('worker-broken')],
        initialPrompt: 'look into this',
        workspaceRoot: ws,
        onEvent: vi.fn(),
        onEnded: vi.fn(),
        executeMode: true, // EXPLICIT — the grant is behind `if (opts.executeMode)`.
      });
      started.push(handle.sessionId);
    } finally {
      // The grant is decided synchronously inside start (before the un-awaited
      // deliver matters), and the roster prompt is persisted before start
      // returns — so restoring here keeps the background mock replay's later
      // emits working while the assertions below read already-written rows.
      spy.mockRestore();
    }

    // Drain the un-awaited replay before asserting: startOrchestratorSession
    // calls deliver fire-and-forget, so without this the mock run is still
    // mid-flight at teardown and the worker RPC closes on a pending console log.
    await waitUntil(
      () => agentHops(handle.sessionId).some((h) => h.endsWith(`->${USER_RECIPIENT}:final`)),
      'the final answer to reach the operator',
    );

    // The persisted cebab → orchestrator roster prompt is where the clause
    // lives; assert on that, never on a renderer called with the value we just
    // handed it.
    const rosterPrompts = listMultiAgentEvents(handle.sessionId)
      .filter(
        (e) =>
          e.source === CEBAB_SOURCE &&
          e.destination === ORCHESTRATOR_AGENT_NAME &&
          e.kind === 'prompt',
      )
      .map((e) => e.text)
      .join('\n');
    expect(rosterPrompts).toContain('Consultant mode');
    expect(rosterPrompts).not.toContain('Execute mode');

    // Record and privilege agree on the safe side.
    expect(handle.executeMode).toBe(false);
    expect(getMultiAgentSession(handle.sessionId)!.execute_mode).toBe(0);
  }, 20_000);
});
