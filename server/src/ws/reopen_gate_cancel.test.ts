import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg, WorkspaceDiff } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject, setProjectTrusted, type ProjectRow } from '../repo/projects.js';
import {
  addParticipant,
  createMultiAgentSession,
  endMultiAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { executeReopenSessionConfirmed, gateProjectsForSpawn, handleClientMsg } from './server.js';
import { closeLogger } from '../runner/logger.js';

/**
 * `Cebab-5vqm` — declining the gate a REOPEN raises is a cancel, not a failure.
 *
 * Same shape as `resume_gate_cancel.test.ts` (`Cebab-2ros`): a Reopen of a
 * session Cebab rebuilt after a restart runs `resumeMultiAgentTarget`, which
 * awaits the real MCP TOFU gate via `reconstructForMode`. An operator who
 * DECLINES the parked prompt rejects it with a `GateAbandonedError`
 * (name 'AbortError'). Before this bead the reopen catch mapped that to
 * `reopen_session_failed { reason: 'reactivate_failed', message: 'gate
 * abandoned: ...' }`, which the modal renders as "Reactivation failed". It now
 * gets the dedicated `cancelled` reason → the modal reads "Reopen cancelled".
 *
 * The helper is driven directly (as `reopen_session_confirmed.test.ts` does)
 * with the REAL `resumeMultiAgentTarget` and real `gateParticipants`, so the
 * gate genuinely parks and `cancel_gate` genuinely abandons it — the classify
 * path under test is the production one, not a stub. The control in the same
 * case proves a genuine (non-cancel) reconstruct throw still reports as before.
 */

type Conn = Parameters<typeof handleClientMsg>[0];
const SID = 'reopen-gate-cancel';
const EMPTY_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: true,
};

let tmpRoot: string;
let originalDataDir: string;
let project: ProjectRow;
let errSpy: ReturnType<typeof vi.spyOn>;

function makeConn(sent: ServerMsg[]): Conn {
  return {
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as ServerMsg) },
    authorityCache: new Map(),
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: makeTrustGateState(),
    busTrustGate: makeBusTrustGateState(),
    startGate: makeStartGateState(),
    multiAgentStartClaim: null,
  } as unknown as Conn;
}

const of = <T extends ServerMsg['type']>(sent: ServerMsg[], type: T) =>
  sent.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];
const tick = () => new Promise((r) => setTimeout(r, 0));

function baseArgs(conn: Conn, sent: ServerMsg[]) {
  return {
    sessionId: SID,
    acknowledgedWorkspaceDiff: true,
    currentActiveSessionId: null,
    detachCurrentActive: () => {},
    adoptResumed: () => {},
    // Skip the typed-confirmation gate so the run reaches the reconstruct.
    computeDiff: async () => EMPTY_DIFF,
    resumeCallbacks: {
      onEvent: () => {},
      onEnded: () => {},
      hopBudget: 1000,
      maxTurns: 50,
      gateParticipants: (projectIds: number[]) => gateProjectsForSpawn(conn, projectIds),
    } as unknown as Parameters<typeof executeReopenSessionConfirmed>[0]['resumeCallbacks'],
    send: (m: ServerMsg) => sent.push(m),
    broadcast: (m: ServerMsg) => sent.push(m),
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reopen-gate-cancel-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }),
  );
  project = upsertProject('proj', projectDir);
  setProjectTrusted(project.id, true);
  setProjectBusInstalled(project.id, true, 'alpha');
  createMultiAgentSession(SID, 'orchestrator', '001');
  addParticipant(SID, project.id, 'worker');
  endMultiAgentSession(SID, 'crashed');
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reopen_session_confirmed — a declined gate is a cancel (Cebab-5vqm)', () => {
  test('a declined gate yields reason `cancelled`; a real throw stays `reactivate_failed`', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);

    // ---- Cancel path: real gate parks, operator declines ----
    const p = executeReopenSessionConfirmed(baseArgs(conn, sent));
    await tick();
    await tick();
    const pending = of(sent, 'mcp_auto_install_pending');
    expect(pending, 'gate did not park: ' + JSON.stringify(sent)).toHaveLength(1);
    await handleClientMsg(conn, {
      type: 'cancel_gate',
      kind: 'mcp',
      pendingId: pending[0]!.pendingId,
    } as never);
    await p.catch(() => {});

    const failed = of(sent, 'reopen_session_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe('cancelled');
    expect(failed[0]!.message).toBe(
      'Reopen cancelled: you declined a trust or environment prompt, so the session was not re-attached.',
    );
    // Nothing re-attached.
    expect(of(sent, 'multi_agent_started')).toHaveLength(0);

    // ---- Control: a genuine (non-cancel) reconstruct throw still reports
    // `reactivate_failed` with its raw message, unchanged by this bead ----
    const controlSent: ServerMsg[] = [];
    const controlConn = makeConn(controlSent);
    await executeReopenSessionConfirmed({
      ...baseArgs(controlConn, controlSent),
      resumeTarget: (async () => {
        throw new Error('boom: workspace gone');
      }) as unknown as Parameters<typeof executeReopenSessionConfirmed>[0]['resumeTarget'],
    });
    const controlFailed = of(controlSent, 'reopen_session_failed');
    expect(controlFailed).toHaveLength(1);
    expect(controlFailed[0]!.reason).toBe('reactivate_failed');
    expect(controlFailed[0]!.message).toBe('boom: workspace gone');
  });
});
