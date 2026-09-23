import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject, setProjectTrusted, type ProjectRow } from '../repo/projects.js';
import {
  addParticipant,
  createMultiAgentSession,
  setAwaitingContinue,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { executeContinueMultiAgent, gateProjectsForSpawn, handleClientMsg } from './server.js';
import { closeLogger } from '../runner/logger.js';

/**
 * `Cebab-5vqm` — declining the gate a CONTINUE raises is a cancel, not a crash.
 *
 * The R-B recovery Continue awaits the MCP TOFU gate before its `query()`
 * spawns (a restart is exactly when a participant's settings can have gained a
 * server). An operator who DECLINES rejects it with a `GateAbandonedError`
 * (name 'AbortError'). Before this bead the catch hard-coded
 * `kind: 'process_crashed'` — a sticky red "Server error" toast for a
 * deliberate cancel. It now routes through `classifyBusStartFailure`, so the
 * (sessionless) `wrapper_error` is `aborted` and `notifyFromServerMsg` shows
 * the transient "Cancelled" info toast instead.
 *
 * Drives the extracted helper with the REAL `gateProjectsForSpawn` so the gate
 * genuinely parks and `cancel_gate` genuinely abandons it. The control in the
 * same case proves a genuine (non-cancel) gate throw still reports as before.
 */

type Conn = Parameters<typeof handleClientMsg>[0];
const SID = 'continue-gate-cancel';
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

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-continue-gate-cancel-'));
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
  setAwaitingContinue(SID, true);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('continue_multi_agent — a declined gate is a cancel (Cebab-5vqm)', () => {
  test('a declined gate yields a sessionless `aborted`; a real throw stays `process_crashed`', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);
    const deliver = vi.fn(async () => {});

    // ---- Cancel path: real gate parks, operator declines ----
    const p = executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: deliver,
      gateProjects: (projectIds) => gateProjectsForSpawn(conn, projectIds),
      applyMcpDenials: () => {},
      send: (m) => sent.push(m),
    });
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

    // The nudge never fired — the gate refused before delivery.
    expect(deliver).not.toHaveBeenCalled();
    const errs = of(sent, 'wrapper_error');
    expect(errs).toHaveLength(1);
    // Sessionless (so notifyFromServerMsg surfaces the "Cancelled" toast) and
    // `aborted`, not `process_crashed`.
    expect(errs[0]!.sessionId).toBeUndefined();
    expect(errs[0]!.kind).toBe('aborted');
    expect(errs[0]!.message).toBe(
      'Continue cancelled: you declined a trust or environment prompt, so the session was not continued.',
    );

    // ---- Control: a genuine (non-cancel) gate throw still reports
    // `process_crashed` with its raw message, unchanged by this bead ----
    const controlSent: ServerMsg[] = [];
    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: vi.fn(async () => {}),
      gateProjects: async () => {
        throw new Error('operator denied the MCP server');
      },
      applyMcpDenials: () => {},
      send: (m) => controlSent.push(m),
    });
    const controlErrs = of(controlSent, 'wrapper_error');
    expect(controlErrs).toHaveLength(1);
    expect(controlErrs[0]!.kind).toBe('process_crashed');
    expect(controlErrs[0]!.message).toBe('operator denied the MCP server');
  });
});
