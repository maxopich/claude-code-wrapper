/**
 * `Cebab-a6wm`, chain mode.
 *
 * When a chain hop fails with an UNEXPECTED error — a V8 RangeError, a
 * bad-shape TypeError, an ENOENT — only `err.message` survives into the
 * operator's `cebab → user kind=error` row, and that message alone names no
 * file and no frame. The full object is printed by the `deliver().catch`, but
 * that stdout goes to a pipe nobody retains once the server runs in the
 * background. So `onWorkerFailed` also writes the stack to `turn-errors.log`
 * in the per-session folder, where the next debugger can read it.
 *
 * This drives `createChainRouter` standalone with an injected `deliver`, the
 * same harness `chain.stranded.test.ts` uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter } from './chain.js';
import { TurnStalledError } from './errors.js';
import { computeSessionPaths } from './paths.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import { _resetCoalesceState } from '../notifications/dispatcher.js';

const SESSION_ID = 'chain-turn-errors-session';
const AGENTS = ['coder', 'reviewer'];

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-chain-turn-errors-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'chain', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRouter() {
  const paths = computeSessionPaths(SESSION_ID);
  // Creating the iteration dir recursively creates the session folder that
  // `turn-errors.log` is written into, exactly as session start would.
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames: AGENTS,
    paths,
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    deliver: vi.fn(),
    hopBudget: 1000,
    sendNotification: vi.fn(),
  });
  return { router, paths };
}

const readTurnErrors = () => {
  const p = path.join(computeSessionPaths(SESSION_ID).folder, 'turn-errors.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

describe('an unexpected chain-hop failure keeps its stack (Cebab-a6wm)', () => {
  test('the stack is written to the session folder, not only the discarded message', () => {
    const { router } = makeRouter();
    // A surprise error whose message is unactionable on its own — the value is
    // the stack, and the frame below is the string a debugger would grep for.
    const boom = new Error('Maximum call stack size exceeded');
    function deepFrameThatNamesTheCycle() {
      return new Error('unexpected').stack;
    }
    boom.stack = `RangeError: Maximum call stack size exceeded\n    at ${deepFrameThatNamesTheCycle.name} (chain.ts:1)`;

    router.onWorkerFailed('coder', 'do the thing', boom);

    const log = readTurnErrors();
    expect(log).not.toBeNull();
    // The stack — not just `err.message` — is what landed on disk.
    expect(log).toContain('deepFrameThatNamesTheCycle');
    expect(log).toContain('agent=coder');
  });

  test('a non-Error rejection still records what little it carries', () => {
    // The `String(err)` fallback: a thrown string has no stack, but discarding
    // it entirely would lose the one line there is.
    const { router } = makeRouter();
    router.onWorkerFailed('coder', 'do the thing', 'bare string blew up');
    expect(readTurnErrors()).toContain('bare string blew up');
  });

  test('[security-adjacent] a control signal Cebab RAISED writes no stack', () => {
    // `Cebab-a6wm` criterion 2, which the first cut of this feature did not
    // meet in either router: a cap hit, a stall, a refused turn and a pause are
    // Cebab stopping the turn, and their message is already the whole
    // actionable story. Dumping frames for those buries the unexpected stacks
    // this log exists to keep, in a file whose only reader is hunting one.
    const { router } = makeRouter();
    router.onWorkerFailed('coder', 'do the thing', new TurnStalledError('coder', 90_000));
    expect(readTurnErrors()).toBeNull();
  });

  test('ANTI-VACUITY: the same router DOES write for an ordinary error', () => {
    // Pairing the case above. "Writes nothing, ever" — a broken path, a wrong
    // folder, a guard that swallowed everything — passes a one-directional
    // assertion just as well as the intended behaviour does.
    const { router } = makeRouter();
    router.onWorkerFailed('coder', 'do the thing', new TurnStalledError('coder', 90_000));
    expect(readTurnErrors()).toBeNull();

    router.onWorkerFailed('coder', 'do the thing', new Error('a genuine surprise'));
    expect(readTurnErrors()).toContain('a genuine surprise');
  });
});
