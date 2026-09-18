/**
 * `Cebab-a6wm`, ORCHESTRATOR mode — the half that shipped with no test at all.
 *
 * The chain half arrived with `chain.turn_errors.test.ts`; the orchestrator
 * half landed earlier and had none, so the behaviour here was asserted only by
 * the comment above it. That asymmetry is worth removing on its own: the two
 * routers are a pair that has drifted before, and the one with no test is the
 * one that drifts.
 *
 * What is pinned, in both directions:
 *   - an UNEXPECTED failure keeps its stack in the per-session `turn-errors.log`
 *     (the message alone names no file and no frame, and the `deliver().catch`
 *     that printed the whole object goes to a pipe nobody retains);
 *   - a control signal Cebab RAISED does NOT (criterion 2, which neither half
 *     met until now — the append was unconditional and `isBusControlSignal`
 *     appeared in neither router).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createOrchestratorRouter } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { MaxTurnsReachedError } from './errors.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import { _resetCoalesceState } from '../notifications/dispatcher.js';
import { closeLogger } from '../runner/logger.js';

const SESSION_ID = 'orch-turn-errors-session';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orch-turn-errors-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(async () => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRouter() {
  const paths = computeSessionPaths(SESSION_ID);
  // Creating the iteration dir recursively creates the session folder that
  // `turn-errors.log` is written into, exactly as session start would.
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  return createOrchestratorRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    workerNames: ['reviewer', 'editor'],
    paths,
    lifecycle: 'persistent',
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    hopBudget: 1000,
  });
}

const readTurnErrors = () => {
  const p = path.join(computeSessionPaths(SESSION_ID).folder, 'turn-errors.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

describe('an unexpected orchestrator worker failure keeps its stack (Cebab-a6wm)', () => {
  test('the stack is written to the session folder, not only the discarded message', () => {
    const router = makeRouter();
    const boom = new Error('Maximum call stack size exceeded');
    function deepFrameThatNamesTheCycle() {
      return null;
    }
    boom.stack = `RangeError: Maximum call stack size exceeded\n    at ${deepFrameThatNamesTheCycle.name} (orchestrator.ts:1)`;

    router.onWorkerFailed('reviewer', 'do the thing', boom);

    const log = readTurnErrors();
    expect(log).not.toBeNull();
    expect(log).toContain('deepFrameThatNamesTheCycle');
    expect(log).toContain('agent=reviewer');
  });

  test('[security-adjacent] a control signal Cebab RAISED writes no stack', () => {
    const router = makeRouter();
    router.onWorkerFailed('reviewer', 'do the thing', new MaxTurnsReachedError('reviewer', 60, 61));
    expect(readTurnErrors()).toBeNull();
  });

  test('ANTI-VACUITY: the same router DOES write for an ordinary error', () => {
    // "Writes nothing, ever" — a wrong folder, a guard that swallowed
    // everything — passes the case above just as well as the intended
    // behaviour. Both answers must come from one router in one test.
    const router = makeRouter();
    router.onWorkerFailed('reviewer', 'do the thing', new MaxTurnsReachedError('reviewer', 60, 61));
    expect(readTurnErrors()).toBeNull();

    router.onWorkerFailed('reviewer', 'do the thing', new Error('a genuine surprise'));
    expect(readTurnErrors()).toContain('a genuine surprise');
  });
});
