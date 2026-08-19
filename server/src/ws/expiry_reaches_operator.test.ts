import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { handlePauseExpiry, rosterAgentNames } from './server.js';
import { createOrchestratorRouter, ORCHESTRATOR_AGENT_NAME } from '../bus/orchestrator.js';
import { computeSessionPaths } from '../bus/paths.js';
import {
  getLiveSession,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
  type BusSessionHandle,
} from '../bus/session_registry.js';
import {
  addParticipant,
  createMultiAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { setParticipantPause } from '../repo/per_agent_control.js';
import { upsertProject } from '../repo/projects.js';
import type { PauseExpiryEntry } from './pause_expiry.js';
import type { ServerMsg } from '@cebab/shared/protocol';

/**
 * Register B17 [security]: a pause-expiry outcome must reach whoever is
 * attached NOW, not the connection that armed the timer.
 *
 * `PauseExpiryRegistry` is a process singleton cleared on session end, not on
 * connection close — so a timer armed by one browser window routinely fires
 * after that window is gone. The old callback sent to the captured `conn.ws`,
 * which is a silent no-op on a closed socket, while
 * `executeExpireParticipant` still wrote the audit row and performed the kick.
 * The operator's live window kept showing `paused` for an agent the durable
 * trail records as kicked.
 *
 * These drive `handlePauseExpiry` directly. That function was extracted from
 * the `pause_participant` case precisely so this could be asserted — and the
 * extraction is itself part of the fix: it now captures nothing from any
 * connection.
 */

const SESSION_ID = 'expiry-sink-session';
const AGENT = 'worker-slug';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-expiry-sink-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  unregisterLiveSession(SESSION_ID);
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** `handlePauseExpiry` casts an orchestrator-mode handle to
 *  `OrchestratorSessionHandle` (pre-existing — `BusSessionHandle` does not
 *  declare the per-agent verbs), so the stub has to satisfy the three the
 *  executor actually calls. */
function stubHandle(sessionId: string): BusSessionHandle {
  return {
    sessionId,
    iterationId: 'iter-1',
    participantAgentNames: [],
    lifecycle: 'persistent',
    sessionFolder: tmpRoot,
    stop: async () => {},
    detach: () => {},
    retry: async () => {},
    continueThroughMutation: async () => {},
    kickAgent: () => {},
    resumeAgent: () => {},
    getPendingDeliveries: () => 0,
  } as unknown as BusSessionHandle;
}

/** A live session backed by a REAL router, so `sendServerMsg` genuinely
 *  delegates to the router's mutable sink the way production does. A stub that
 *  captured a sink would prove nothing about the seam under test. */
function registerRealRouterSession(): {
  sinkA: ServerMsg[];
  rebindTo: (into: ServerMsg[]) => void;
  detach: () => void;
} {
  const paths = computeSessionPaths(SESSION_ID);
  const sinkA: ServerMsg[] = [];
  const mkSink = (into: ServerMsg[]): BusSink => ({
    onEvent: () => {},
    onEnded: () => {},
    sendServerMsg: (m) => into.push(m),
  });
  const router = createOrchestratorRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    workerNames: [AGENT],
    paths,
    lifecycle: 'persistent',
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    hopBudget: 1000,
    sendServerMsg: (m) => sinkA.push(m),
  });
  registerLiveSession({
    sessionId: SESSION_ID,
    mode: 'orchestrator',
    handle: stubHandle(SESSION_ID),
    rebind: (s) => router.rebind(s),
    sendServerMsg: (m) => router.sendServerMsg(m),
  });
  return {
    sinkA,
    rebindTo: (into) => router.rebind(mkSink(into)),
    detach: () => router.detach(),
  };
}

function seedPausedParticipant(expiryAction: 'auto_resume' | 'auto_kick'): PauseExpiryEntry {
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
  const dir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const proj = upsertProject('proj', dir);
  setProjectBusInstalled(proj.id, true, AGENT);
  addParticipant(SESSION_ID, proj.id, 'worker', null);
  const pausedUntil = Date.now() + 1000;
  setParticipantPause(SESSION_ID, proj.id, pausedUntil, expiryAction);
  return {
    sessionId: SESSION_ID,
    projectId: proj.id,
    agentName: AGENT,
    pausedUntil,
    expiryAction,
    reasonCode: 'off_task',
    reasonText: null,
  };
}

describe('[security][B17] a pause expiry reaches the window attached NOW', () => {
  test('after a re-attach, the kick envelope goes to the NEW sink', () => {
    const { sinkA, rebindTo } = registerRealRouterSession();
    const entry = seedPausedParticipant('auto_kick');
    const sinkB: ServerMsg[] = [];
    rebindTo(sinkB);

    handlePauseExpiry(entry);

    expect(sinkB.map((m) => m.type)).toContain('participant_kicked');
    expect(sinkA).toHaveLength(0);
  });

  test('CONTROL: with no re-attach, the original sink still receives it', () => {
    // Without this, "send nowhere" would satisfy the case above.
    const { sinkA } = registerRealRouterSession();
    const entry = seedPausedParticipant('auto_kick');

    handlePauseExpiry(entry);

    expect(sinkA.map((m) => m.type)).toContain('participant_kicked');
  });

  test('auto_resume follows the sink too', () => {
    const { sinkA, rebindTo } = registerRealRouterSession();
    const entry = seedPausedParticipant('auto_resume');
    const sinkB: ServerMsg[] = [];
    rebindTo(sinkB);

    handlePauseExpiry(entry);

    expect(sinkB.map((m) => m.type)).toContain('participant_pause_changed');
    expect(sinkA).toHaveLength(0);
  });

  test('a detached session drops the envelope rather than reviving a dead sink', () => {
    // The other half of resolving at call time: `detach()` swaps the router's
    // sink for NOOP_SINK, and reading it late must honour that. A registry-
    // side copy of the sink would keep sending here.
    const { sinkA, detach } = registerRealRouterSession();
    const entry = seedPausedParticipant('auto_kick');
    detach();

    handlePauseExpiry(entry);

    expect(sinkA).toHaveLength(0);
  });

  test('the durable side happens either way — the envelope is not the record', () => {
    // Anti-regression: routing the envelope must not have made the kick
    // conditional on someone listening. Nobody is attached at all here.
    const entry = seedPausedParticipant('auto_kick');
    expect(getLiveSession(SESSION_ID)).toBeUndefined();

    handlePauseExpiry(entry);

    const audits = getDb()
      .prepare(`SELECT kind FROM safety_audit WHERE session_id = ?`)
      .all(SESSION_ID) as Array<{ kind: string }>;
    expect(audits.map((a) => a.kind)).toContain('pause.expired_without_resume');
  });
});

describe('[Cebab-74q] the roster comes from the DB, not a start-time snapshot', () => {
  function seedSession(mode: 'chain' | 'orchestrator', agents: string[]): void {
    createMultiAgentSession(SESSION_ID, mode, 'iter-1');
    agents.forEach((name, i) => {
      const dir = path.join(tmpRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      const proj = upsertProject(name, dir);
      setProjectBusInstalled(proj.id, true, name);
      addParticipant(SESSION_ID, proj.id, 'worker', mode === 'chain' ? i : null);
    });
  }

  test('a worker added after the session started appears', () => {
    seedSession('orchestrator', ['coder']);
    expect(rosterAgentNames(SESSION_ID, 'orchestrator')).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'coder',
    ]);

    // What `addWorker` does mid-run: a participant row. The handle's array is
    // untouched by design — this is the source that grows.
    const dir = path.join(tmpRoot, 'newbie');
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject('newbie', dir);
    setProjectBusInstalled(proj.id, true, 'newbie');
    addParticipant(SESSION_ID, proj.id, 'worker', null);

    expect(rosterAgentNames(SESSION_ID, 'orchestrator')).toContain('newbie');
  });

  test('CONTROL: chain mode has no orchestrator entry', () => {
    seedSession('chain', ['first', 'second']);
    expect(rosterAgentNames(SESSION_ID, 'chain')).toEqual(['first', 'second']);
  });

  test('a session with no participants yields an empty roster, not a throw', () => {
    createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
    expect(rosterAgentNames(SESSION_ID, 'orchestrator')).toEqual([ORCHESTRATOR_AGENT_NAME]);
    expect(rosterAgentNames(SESSION_ID, 'chain')).toEqual([]);
  });

  test('the WS layer never reads the handle roster snapshot', () => {
    // The helper passing while the call site still read `handle
    // .participantAgentNames` is exactly how this shipped — so the call site
    // needs its own gate, and the re-attach envelope is assembled inline in a
    // handler that needs a live WS connection to drive.
    //
    // The invariant is stable under reformatting: the WS layer has no
    // legitimate reason to read that array at all. The roster of record is
    // the participants table.
    const src = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    // Strip comments first — a scan that matches the prose explaining a thing
    // is the recurring hole in this repo's source gates.
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    // Positive control: the scan can find something that IS there, so an
    // empty/misread file cannot pass this test vacuously.
    expect(code).toContain('rosterAgentNames(');
    expect(code).not.toContain('handle.participantAgentNames');
  });
});
