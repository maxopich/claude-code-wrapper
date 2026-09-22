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
  endMultiAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { handleClientMsg } from './server.js';
import { closeLogger } from '../runner/logger.js';

/**
 * `Cebab-2ros` — declining the gate a RESUME raises is a cancel, not a crash.
 *
 * Drives the real `resume_multi_agent` verb through `handleClientMsg`, lets a
 * real MCP TOFU gate park (a trusted participant whose `.mcp.json` declares an
 * unapproved server), cancels it the way the modal does, and reads what went
 * over the wire. `bus_start_failure_kind.test.ts` pins the catch's SOURCE
 * shape; this pins its OUTCOME, which the shape cannot: classifying something
 * other than the caught error (`new Error(String(err))` loses the AbortError
 * name) or dropping the resume wording both pass a shape check and redden
 * here. The session is ended `crashed` and never registered live, so the
 * resume takes the reconstruct path — the only one that runs the gate.
 */

type Conn = Parameters<typeof handleClientMsg>[0];
const SID = 'resume-gate-cancel';
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-resume-gate-cancel-'));
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

describe('resume_multi_agent — a declined gate is a cancel (Cebab-2ros)', () => {
  test('yields a session-scoped aborted wrapper_error with the resume wording', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);
    const p = handleClientMsg(conn, { type: 'resume_multi_agent', sessionId: SID } as never);
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
    const errs = of(sent, 'wrapper_error');
    expect(errs).toHaveLength(1);
    // Session-scoped, as shipped (see the resume catch's comment and
    // Cebab-7vl4 for whether it should stay so).
    expect(errs[0]!.sessionId).toBe(SID);
    expect(errs[0]!.kind).toBe('aborted');
    // The resume wording, not the start one ("… before it began").
    expect(errs[0]!.message).toBe(
      'Resume cancelled: you declined a trust or environment prompt, so the session was not re-attached.',
    );
    // Nothing re-attached.
    expect(of(sent, 'multi_agent_started')).toHaveLength(0);
  });
});
