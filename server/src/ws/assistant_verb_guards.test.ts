/**
 * Cebab-8x8.1.3: the projectId-bearing verbs must refuse the Cebab-owned help
 * assistant. `assertWorkspaceProject` decides correctly (identity.test.ts); this
 * file proves each verb is WIRED to it — the guard existing but not called is
 * exactly the leak the issue closes.
 *
 * COVERAGE, stated honestly (Cebab-fy1). Commit 11e7b3a wired NINE sites in
 * `server.ts`. Eight have a case here: open_project, set_trusted,
 * get_project_authority, set_permission_mode, read_project_facts,
 * add_multi_agent_participant, install_bus_integration (:4800) and the
 * `start_multi_agent` participant filter (:4915). The ninth — the
 * `reopen_session` probe at :1581 — does NOT, and this comment is the record of
 * that rather than a claim it does. The verb list below is hand-written, so it
 * cannot detect a NEW projectId-bearing verb going unguarded; the durable fix is
 * a table typed against `ClientMsg` in the style of
 * `shared/src/protocol.client_verbs.test.ts`, which is a real compile-time gate.
 *
 * The one that matters is `add_multi_agent_participant`: unguarded it reaches
 * `addWorker -> installBusForProject` and runs the assistant as a bus worker
 * under the full posture. The positive control makes `addWorker` a spy that
 * throws a sentinel, so a WORKSPACE project provably reaches it while the
 * assistant provably does not — the test is not vacuous.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { ensureAssistantProject } from '../assistant/identity.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import {
  getProject,
  setProjectBusTrust,
  upsertProject,
  type ProjectRow,
} from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { handleClientMsg } from './server.js';

type Conn = Parameters<typeof handleClientMsg>[0];

let tmpRoot: string;
let originalDataDir: string;
let assistant: ProjectRow;
let workspace: ProjectRow;

const KB = '/tmp/cebab-avg-kb';

function makeConn(sent: ServerMsg[], extra: Partial<Record<string, unknown>> = {}): Conn {
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
    ...extra,
  } as unknown as Conn;
}

const of = <T extends ServerMsg['type']>(sent: ServerMsg[], type: T) =>
  sent.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-avg-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const wsDir = path.join(tmpRoot, 'my-repo');
  fs.mkdirSync(path.join(wsDir, '.claude'), { recursive: true });
  workspace = upsertProject('my-repo', wsDir);
  assistant = ensureAssistantProject(KB)!;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('add_multi_agent_participant refuses the assistant (the leak that matters)', () => {
  function connWithWorker(sent: ServerMsg[], addWorker: (pid: number) => Promise<unknown>): Conn {
    return makeConn(sent, { multiAgent: { sessionId: 'ma1', addWorker } });
  }

  test('the assistant never reaches addWorker; a wrapper_error is sent instead', async () => {
    const sent: ServerMsg[] = [];
    const calls: number[] = [];
    const conn = connWithWorker(sent, async (pid) => {
      calls.push(pid);
      throw new Error('ADDWORKER_REACHED');
    });

    await handleClientMsg(conn, {
      type: 'add_multi_agent_participant',
      sessionId: 'ma1',
      projectId: assistant.id,
    } as never);

    // The guard fired before the auto-install side effect.
    expect(calls).toEqual([]);
    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).toContain('not one of your workspace projects');
  });

  test('a workspace project passes the guard and DOES reach addWorker', async () => {
    // Persisted trust so the bus-install TOFU gate short-circuits without a
    // prompt; the empty `.claude` dir means the MCP/env/hook spawn-gate has
    // nothing to park on. So the only thing between the verb and addWorker is
    // the guard under test — and it must let a workspace project through.
    setProjectBusTrust(workspace.id, 'trusted');
    const sent: ServerMsg[] = [];
    const calls: number[] = [];
    const conn = connWithWorker(sent, async (pid) => {
      calls.push(pid);
      throw new Error('ADDWORKER_REACHED');
    });

    await handleClientMsg(conn, {
      type: 'add_multi_agent_participant',
      sessionId: 'ma1',
      projectId: workspace.id,
    } as never);

    expect(calls).toEqual([workspace.id]);
    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).toContain('ADDWORKER_REACHED');
    expect(err[0]!.message).not.toContain('not one of your workspace projects');
  });
});

describe('the throwing guards surface through the connection catch', () => {
  // set_trusted / get_project_authority / open_project place the guard OUTSIDE
  // a try, so it rejects out of handleClientMsg (production's ws.on('message')
  // catch turns that into a wrapper_error). A direct test sees the rejection.
  test('set_trusted rejects for the assistant and never flips trusted', async () => {
    const sent: ServerMsg[] = [];
    await expect(
      handleClientMsg(makeConn(sent), {
        type: 'set_trusted',
        projectId: assistant.id,
        trusted: true,
      } as never),
    ).rejects.toThrow(/not one of your workspace projects/);
    expect(getProject(assistant.id)?.trusted).toBe(0);
  });

  test('set_trusted still works for a workspace project', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'set_trusted',
      projectId: workspace.id,
      trusted: true,
    } as never);
    expect(getProject(workspace.id)?.trusted).toBe(1);
  });

  test('get_project_authority rejects for the assistant', async () => {
    const sent: ServerMsg[] = [];
    await expect(
      handleClientMsg(makeConn(sent), {
        type: 'get_project_authority',
        projectId: assistant.id,
        mode: 'cache',
      } as never),
    ).rejects.toThrow(/not one of your workspace projects/);
  });

  test('open_project rejects for the assistant', async () => {
    const sent: ServerMsg[] = [];
    await expect(
      handleClientMsg(makeConn(sent), {
        type: 'open_project',
        projectId: assistant.id,
      } as never),
    ).rejects.toThrow(/not one of your workspace projects/);
  });
});

describe('set_permission_mode is a DB-row kind check, not an inFlight check', () => {
  test('the assistant is refused even with NOTHING in flight', async () => {
    // The bug the issue calls out: an inFlight-based guard is a no-op here,
    // because `if (!f) return` bails first when nothing is in flight. The DB-row
    // check must fire regardless of inFlight — this session is NOT in flight.
    createSession('as-sess', assistant.id);
    const sent: ServerMsg[] = [];
    await expect(
      handleClientMsg(makeConn(sent), {
        type: 'set_permission_mode',
        sessionId: 'as-sess',
        mode: 'acceptEdits',
      } as never),
    ).rejects.toThrow(/not one of your workspace projects/);
  });

  test('a workspace session not in flight is not refused (guard does not over-fire)', async () => {
    createSession('ws-sess', workspace.id);
    const sent: ServerMsg[] = [];
    // Resolves silently — the `if (!f) return` path — with no wrapper_error.
    await handleClientMsg(makeConn(sent), {
      type: 'set_permission_mode',
      sessionId: 'ws-sess',
      mode: 'acceptEdits',
    } as never);
    expect(of(sent, 'wrapper_error')).toHaveLength(0);
    expect(of(sent, 'permission_mode_changed')).toHaveLength(0);
  });
});

describe('read_project_facts answers with a resolving stub for the assistant', () => {
  test('no facts leak and the pending request still resolves', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'read_project_facts',
      projectId: assistant.id,
    } as never);
    const facts = of(sent, 'project_facts');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.projectId).toBe(assistant.id);
    // Path is blanked — the assistant's real KB path is not disclosed.
    expect(facts[0]!.facts.path).toBe('');
    expect(facts[0]!.facts.name).toContain('unavailable');
  });
});

// Cebab-fy1: both guards below were wired by 11e7b3a with no assertion anywhere,
// so deleting either line reddened nothing. Each case pairs the assistant
// (must be refused) with a workspace project (must get through) — a filter that
// dropped everything would satisfy the first half alone.
describe('start_multi_agent drops the assistant from the participant set', () => {
  test('the assistant is filtered out, so a chain of [assistant, workspace] falls below the minimum', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'start_multi_agent',
      mode: 'chain',
      participants: [assistant.id, workspace.id],
    } as never);

    // Two ids in, one survives the filter — so the chain minimum is what fires.
    // Without the filter both would survive and this message would NOT be sent.
    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).toContain('at least two participants');
    // And the assistant is never echoed back as a participant.
    expect(of(sent, 'multi_agent_started')).toHaveLength(0);
  });

  test('workspace projects SURVIVE the filter — two of them clear the minimum', async () => {
    const otherDir = path.join(tmpRoot, 'other-repo');
    fs.mkdirSync(path.join(otherDir, '.claude'), { recursive: true });
    const other = upsertProject('other-repo', otherDir);

    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'start_multi_agent',
      mode: 'chain',
      participants: [workspace.id, other.id],
    } as never);

    // Neither has the bus installed, so this fails LATER, in the resolver. The
    // point is only that it got past the participant filter: a filter that
    // dropped workspace projects too would have produced the minimum error.
    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).not.toContain('at least two participants');
  });
});

describe('install_bus_integration refuses the assistant before the TOFU gate', () => {
  test('the assistant is refused and never reaches the trust gate', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'install_bus_integration',
      projectId: assistant.id,
    } as never);

    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).toContain('not one of your workspace projects');
    // The guard sits ABOVE awaitBusTrustDecision, so the operator is never
    // prompted to trust a project that can never be installed.
    expect(of(sent, 'bus_auto_install_pending')).toHaveLength(0);
  });

  test('a workspace project passes the guard and DOES reach the trust gate', async () => {
    // A persisted `denied` makes the gate short-circuit and answer, so the
    // observable proves the verb got past the guard without the test hanging on
    // an un-answered TOFU prompt.
    setProjectBusTrust(workspace.id, 'denied');
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'install_bus_integration',
      projectId: workspace.id,
    } as never);

    const err = of(sent, 'wrapper_error');
    expect(err).toHaveLength(1);
    expect(err[0]!.message).toContain('bus install refused');
    expect(err[0]!.message).not.toContain('not one of your workspace projects');
  });
});
