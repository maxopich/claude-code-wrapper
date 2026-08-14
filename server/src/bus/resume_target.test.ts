import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
} from '../repo/multi_agent.js';
import {
  hasLiveSession,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
} from './session_registry.js';
import { resumeMultiAgentTarget } from './resume.js';

/**
 * Register B32: a failed targeted resume must leave the DB and the live-session
 * registry agreeing with each other.
 *
 * `resumeMultiAgentTarget`'s catch already restores the row's terminal status.
 * What it did not do was clean up a registry entry it had just created — and
 * `reconstructOrchestratorSession` early-returns `true` on `hasLiveSession`, so
 * the NEXT resume would skip the rebuild and re-attach to a half-built session
 * nobody owns, while the row says `crashed`.
 *
 * REACHABILITY, stated so nobody reads more into these cases than is there:
 * neither production `rebind` can throw — both are `sink = next; return
 * ++sinkEpoch`. This is a defensive path. The registry accepts any
 * `LiveBusSession`, so the contract is worth pinning before some future handle
 * throws; it is not a bug an operator has hit.
 *
 * The pair below is the whole point. The register's suggested fix was an
 * unconditional unregister, which passes the second case and BREAKS the first:
 * it would evict a healthy, already-live session because a rebind failed —
 * converting a recoverable re-attach into an unrecoverable one.
 */

const SID = 'b32-target';

/**
 * Set by the R-B case only: stands in for a rebuild that succeeds and registers
 * a session whose rebind then fails. The real `reconstructOrchestratorSession`
 * cannot produce that combination — the routers it builds hand back a `rebind`
 * that only assigns — and a row that is NOT reconstructable bails before the
 * rebind is ever reached, which would make the case pass while proving nothing.
 * Everything else in the module stays real.
 */
let fakeReconstruct: ((sessionId: string) => boolean) | null = null;

vi.mock('./reconstruct.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reconstruct.js')>();
  return {
    ...actual,
    reconstructOrchestratorSession: (
      row: Parameters<typeof actual.reconstructOrchestratorSession>[0],
      cbs: Parameters<typeof actual.reconstructOrchestratorSession>[1],
    ) =>
      fakeReconstruct ? fakeReconstruct(row.id) : actual.reconstructOrchestratorSession(row, cbs),
  };
});

let tmpRoot: string;
let originalDataDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-b32-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  fakeReconstruct = null;
  unregisterLiveSession(SID);
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const CALLBACKS = {
  onEvent: vi.fn(),
  onEnded: vi.fn(),
  hopBudget: 1000,
};

/** Register a live session whose `rebind` behaves however the case needs. */
function registerFakeLive(sessionId: string, rebind: (sink: BusSink) => number): void {
  registerLiveSession({
    sessionId,
    mode: 'orchestrator',
    handle: {
      sessionId,
      iterationId: 'iter-1',
      participantAgentNames: [],
      lifecycle: 'temp',
      sessionFolder: '',
      stop: async () => {},
      detach: () => {},
      retry: async () => {},
      continueThroughMutation: async () => {},
    },
    rebind,
    sendServerMsg: () => {},
  });
}

function throwingRebind(): number {
  throw new Error('rebind blew up');
}

describe('resumeMultiAgentTarget — a failed rebind cleans up only what it built (B32)', () => {
  test('an ALREADY-LIVE session is not evicted when its rebind throws', async () => {
    // R-A: the session survived in this process, the operator clicked Resume,
    // and only the sink swap failed. The entry is still the real, running
    // session — unregistering it here would strand it for good.
    createMultiAgentSession(SID, 'orchestrator', '001');
    endMultiAgentSession(SID, 'crashed');
    registerFakeLive(SID, throwingRebind);

    const result = await resumeMultiAgentTarget(SID, CALLBACKS);

    expect(result).toEqual({ ok: false, reason: 'reattach-failed' });
    expect(hasLiveSession(SID)).toBe(true);
    // …and the row is back to where it started, which is the half of the
    // contract that already worked.
    expect(getMultiAgentSession(SID)?.status).toBe('crashed');
  });

  test('a session THIS call reconstructed is unregistered when its rebind throws', async () => {
    // R-B: nothing was live, the rebuild put an entry in the registry, and the
    // rebind then failed. Leaving that entry behind is what makes the next
    // resume skip the rebuild and re-attach to a session nobody owns.
    createMultiAgentSession(SID, 'orchestrator', '001');
    endMultiAgentSession(SID, 'crashed');
    expect(hasLiveSession(SID)).toBe(false);

    let rebuilt = false;
    fakeReconstruct = (sessionId) => {
      registerFakeLive(sessionId, throwingRebind);
      rebuilt = true;
      return true;
    };

    const result = await resumeMultiAgentTarget(SID, CALLBACKS);

    // Guard against the vacuous version of this case: if the rebuild had bailed
    // (an unreconstructable row), the function returns before the rebind and
    // `hasLiveSession` would be false for a reason that has nothing to do with
    // the cleanup under test.
    expect(rebuilt).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'reattach-failed' });
    expect(hasLiveSession(SID)).toBe(false);
    expect(getMultiAgentSession(SID)?.status).toBe('crashed');
  });

  test('a successful rebind leaves the entry registered', async () => {
    // The control: the cleanup is scoped to the failure path. Without this, a
    // change that unregistered unconditionally — success included — would pass
    // both cases above while breaking every resume.
    createMultiAgentSession(SID, 'orchestrator', '001');
    endMultiAgentSession(SID, 'crashed');
    registerFakeLive(SID, () => 7);

    const result = await resumeMultiAgentTarget(SID, CALLBACKS);

    expect(result.ok).toBe(true);
    expect(hasLiveSession(SID)).toBe(true);
    expect(getMultiAgentSession(SID)?.status).toBe('running');
  });
});
