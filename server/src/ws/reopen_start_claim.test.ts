import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
import {
  claimSessionStart,
  isSessionStartInFlight,
  listLiveSessionIds,
  releaseSessionStart,
  unregisterLiveSession,
} from '../bus/session_registry.js';
import { handleClientMsg } from './server.js';
import { closeLogger } from '../runner/logger.js';

/**
 * `Cebab-xm95` [security] — a reopen must hold the process-wide start slot
 * ACROSS its trust-gate park, so a run another browser window starts during the
 * park cannot go live and then be crash-displaced by reopen's step 5.
 *
 * WHAT WENT WRONG. `reopen_session_confirmed` took no claim. Step 4
 * (`gateProjectsForSpawn`) parks until the operator answers the MCP trust
 * prompt, and step 5 reads `listLiveSessionIds()` AFTER that park — so a start
 * that raced in during the park was both live in the process AND reached by the
 * displacement, which crashed it. This drives the real verb through
 * `handleClientMsg` and asserts the claim is held while the gate is parked, and
 * released on the operator-cancel path.
 *
 * THE VACUITY TRAP. `claimSessionStart` refuses for TWO reasons — a live
 * incumbent OR an in-flight claim — and reopen almost always has something live,
 * so "a concurrent start is refused" passes on unfixed code the moment the
 * registry is non-empty. Two guards kill that: assert `listLiveSessionIds()` is
 * `[]` at the moment of the assertion, and assert `isSessionStartInFlight()`,
 * which can only be true if a claim is actually held.
 */

type Conn = Parameters<typeof handleClientMsg>[0];

let tmpRoot: string;
let originalDataDir: string;
let project: ProjectRow;

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
  } as unknown as Conn;
}

const of = <T extends ServerMsg['type']>(sent: ServerMsg[], type: T) =>
  sent.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Tick until `sent` carries a message of `type`, bounded. The reopen's
 *  `computeWorkspaceDiff` spawns real `git` before it reaches the gate, so a
 *  single microtask is not enough; this is the gate-message handshake, not a
 *  wall-clock assertion. */
async function tickUntil<T extends ServerMsg['type']>(
  sent: ServerMsg[],
  type: T,
): Promise<Extract<ServerMsg, { type: T }>[]> {
  for (let i = 0; i < 200; i++) {
    const hit = of(sent, type);
    if (hit.length > 0) return hit;
    await tick();
  }
  return of(sent, type);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reopen-claim-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  // Trusted so `busSettingScopesFor` includes 'project' and the project-root
  // `.mcp.json` actually loads; a never-decided server resolves to
  // `pending_tofu`, which is what parks the gate on a prompt.
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }),
  );
  project = upsertProject('proj', projectDir);
  setProjectTrusted(project.id, true);
  // The gate resolves participants via `resumeParticipantProjectIds`, which only
  // counts worker rows whose project carries a `bus_agent_name`. Without this the
  // gate sees no projects and never parks (the anti-vacuity assertion catches it).
  setProjectBusInstalled(project.id, true, 'worker-agent');

  // A crashed, reopenable orchestrator session whose participant is the trusted
  // project above — so the reopen's gate parks on that project's MCP prompt.
  createMultiAgentSession('target', 'orchestrator', '001');
  endMultiAgentSession('target', 'crashed');
  addParticipant('target', project.id, 'worker', null);
});

afterEach(async () => {
  // The live registry + claim set are process singletons.
  unregisterLiveSession('target');
  releaseSessionStart('other-window');
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reopen holds the start claim across its trust-gate park (Cebab-xm95)', () => {
  test('a start is refused while the reopen is parked, and the claim is released on cancel', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);

    // The vulnerable state, and what makes the assertions below mean something.
    expect(listLiveSessionIds()).toEqual([]);

    // Do NOT await: the reopen parks at the MCP trust gate. `typedConfirmation`
    // because the temp project dir is not a git repo (fullDiffAvailable false),
    // so the typed gate fires; harmless if the diff comes back clean.
    const reopen = handleClientMsg(conn, {
      type: 'reopen_session_confirmed',
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
    } as never);

    // Anti-vacuity FIRST: the reopen really parked on the gate. Without this a
    // reopen that never reached step 4 would satisfy the assertions for the
    // wrong reason.
    const pending = await tickUntil(sent, 'mcp_auto_install_pending');
    expect(pending, 'the reopen did not park on the gate — this test proves nothing').toHaveLength(
      1,
    );

    // The claim is held across the park. `listLiveSessionIds()` is `[]`, so the
    // refusal can ONLY come from the reopen's claim — not from a live session.
    expect(listLiveSessionIds()).toEqual([]);
    expect(isSessionStartInFlight()).toBe(true);
    expect(claimSessionStart('other-window')).toBe(false);

    // Resolve the park: the operator dismisses the trust modal.
    await handleClientMsg(conn, {
      type: 'cancel_gate',
      kind: 'mcp',
      pendingId: pending[0]!.pendingId,
    } as never);
    await reopen.catch(() => {});

    // The claim was released on the operator-cancel path (the `Cebab-6fax.16`
    // leak, on the new site): a start is now permitted again.
    expect(isSessionStartInFlight()).toBe(false);
    expect(claimSessionStart('other-window')).toBe(true);
    releaseSessionStart('other-window');
  });
});
