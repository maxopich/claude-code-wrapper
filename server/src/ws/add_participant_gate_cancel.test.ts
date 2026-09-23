import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  upsertProject,
  setProjectTrusted,
  setProjectBusTrust,
  type ProjectRow,
} from '../repo/projects.js';
import {
  addParticipant,
  createMultiAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { handleClientMsg } from './server.js';
import { closeLogger } from '../runner/logger.js';

/**
 * `Cebab-5vqm` — declining the gate a mid-run ADD raises is a cancel, not a
 * failure.
 *
 * `add_multi_agent_participant` runs the same MCP TOFU gate the start paths do
 * (`gateProjectsForSpawn`) before enrolling the worker. An operator who
 * DECLINES rejects it with a `GateAbandonedError` (name 'AbortError'). Before
 * this bead the catch reported it session-scoped as `process_crashed`
 * ("add_multi_agent_participant failed: gate abandoned: ...") — which the
 * store's busScoped guard swallows into nothing. It now reports a SESSIONLESS
 * `aborted` `wrapper_error` so `notifyFromServerMsg` shows the transient
 * "Cancelled" info toast.
 *
 * Drives the real verb through `handleClientMsg`. The active handle is a
 * fake with an `addWorker` (the gate runs before it, so it is never reached on
 * the cancel path); the gate genuinely parks and `cancel_gate` genuinely
 * abandons it. The control in the same case makes `addWorker` throw for an
 * untrusted project (nothing project-scoped to gate → no park) and proves a
 * genuine (non-cancel) failure still reports session-scoped `process_crashed`
 * with its "add_multi_agent_participant failed:" wording.
 */

type Conn = Parameters<typeof handleClientMsg>[0];
const SID = 'add-gate-cancel';
let tmpRoot: string;
let originalDataDir: string;
let trustedProject: ProjectRow;
let untrustedProject: ProjectRow;
let errSpy: ReturnType<typeof vi.spyOn>;
let addWorker: ReturnType<typeof vi.fn>;

function makeConn(sent: ServerMsg[]): Conn {
  const conn = {
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
    // A fake active orchestrator handle: the gate runs before `addWorker`, so on
    // the cancel path it is never called; the control makes it throw.
    multiAgent: { sessionId: SID, addWorker },
  };
  return conn as unknown as Conn;
}

const of = <T extends ServerMsg['type']>(sent: ServerMsg[], type: T) =>
  sent.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeProjectDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }),
  );
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-add-gate-cancel-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();

  // The cancel target: trusted, so its `.mcp.json` server is read and the
  // gate parks on it.
  trustedProject = upsertProject('trusted', makeProjectDir('trusted'));
  setProjectTrusted(trustedProject.id, true);
  setProjectBusInstalled(trustedProject.id, true, 'alpha');
  setProjectBusTrust(trustedProject.id, 'trusted');

  // The control target: untrusted, so nothing project-scoped is gated (no
  // park), letting `addWorker` be reached and throw.
  untrustedProject = upsertProject('untrusted', makeProjectDir('untrusted'));
  setProjectTrusted(untrustedProject.id, false);
  setProjectBusInstalled(untrustedProject.id, true, 'beta');
  setProjectBusTrust(untrustedProject.id, 'trusted');

  createMultiAgentSession(SID, 'orchestrator', '001');
  addParticipant(SID, trustedProject.id, 'worker');
  addWorker = vi.fn(async () => {
    throw new Error('bus went away');
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('add_multi_agent_participant — a declined gate is a cancel (Cebab-5vqm)', () => {
  test('a declined gate yields a sessionless `aborted`; a real throw stays session-scoped `process_crashed`', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);

    // ---- Cancel path: real gate parks, operator declines ----
    const p = handleClientMsg(conn, {
      type: 'add_multi_agent_participant',
      sessionId: SID,
      projectId: trustedProject.id,
    } as never);
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

    expect(addWorker).not.toHaveBeenCalled();
    const errs = of(sent, 'wrapper_error');
    expect(errs).toHaveLength(1);
    // Sessionless (so notifyFromServerMsg surfaces the "Cancelled" toast — a
    // bus-scoped wrapper_error is swallowed by the store) and `aborted`.
    expect(errs[0]!.sessionId).toBeUndefined();
    expect(errs[0]!.kind).toBe('aborted');
    expect(errs[0]!.message).toBe(
      'Add cancelled: you declined a trust or environment prompt, so the participant was not added.',
    );

    // ---- Control: a genuine (non-cancel) failure still reports session-scoped
    // `process_crashed` with its unchanged wording ----
    const controlSent: ServerMsg[] = [];
    const controlConn = makeConn(controlSent);
    await handleClientMsg(controlConn, {
      type: 'add_multi_agent_participant',
      sessionId: SID,
      projectId: untrustedProject.id,
    } as never);
    expect(addWorker).toHaveBeenCalledTimes(1);
    const controlErrs = of(controlSent, 'wrapper_error');
    expect(controlErrs).toHaveLength(1);
    expect(controlErrs[0]!.sessionId).toBe(SID);
    expect(controlErrs[0]!.kind).toBe('process_crashed');
    expect(controlErrs[0]!.message).toBe('add_multi_agent_participant failed: bus went away');
  });
});
