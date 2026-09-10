import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject, setProjectTrusted, type ProjectRow } from '../repo/projects.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeBusTrustGateState } from '../bus/install_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { handleClientMsg } from './server.js';

/**
 * `Cebab-6fax.17` — cancelling a trust/env gate on a single-agent turn must end
 * the turn cleanly, not surface as a crash that strands the chat.
 *
 * WHAT WENT WRONG. `runOneTurn` created the `sessions` row and THEN awaited the
 * spawn gate, outside the turn's try/finally. An operator declining the trust
 * prompt rejects the parked promise with a `GateAbandonedError` (`name`
 * `AbortError`); that propagated to the dispatch-level catch, which sends a
 * SESSIONLESS `wrapper_error`. Three symptoms followed: the toast read
 * `process_crashed` for a deliberate cancel, the chat sat at "thinking" forever
 * (no session-scoped envelope ever resolved the turn), and an orphan `sessions`
 * row with no events was left behind.
 *
 * These cases drive the real verb through `handleClientMsg` — a first-seen
 * `.mcp.json` server parks the gate, `cancel_gate` abandons it — and assert the
 * three properties directly. Before the fix `await`-ing the turn REJECTS (so the
 * assertions never run) and the row count is 1; the `.catch` below lets the
 * assertions be what fails rather than an unhandled rejection.
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

function sessionRowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-gate-cancel-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  // Trusted so `settingSources` includes 'project' and the project-root
  // `.mcp.json` actually loads; a never-decided server resolves to
  // `pending_tofu`, which is the state that parks the gate on a prompt.
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { evil: { command: 'echo' } } }),
  );
  project = upsertProject('proj', projectDir);
  setProjectTrusted(project.id, true);
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('cancelling a single-agent trust gate ends the turn cleanly', () => {
  test('cancel yields an aborted (not crashed) session-scoped error, running:false, and no orphan row', async () => {
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);

    // No session row exists before the turn starts.
    expect(sessionRowCount()).toBe(0);

    // Do NOT await: the turn parks at the gate.
    const turn = handleClientMsg(conn, {
      type: 'send_message',
      projectId: project.id,
      text: 'hi',
    } as never);
    await tick();

    // Anti-vacuity: the gate really parked on a prompt. Without this a turn that
    // never reached the gate would satisfy every assertion below for the wrong
    // reason.
    const pending = of(sent, 'mcp_auto_install_pending');
    expect(pending, 'the gate did not park — this test proves nothing').toHaveLength(1);

    // The operator dismisses the modal.
    await handleClientMsg(conn, {
      type: 'cancel_gate',
      kind: 'mcp',
      pendingId: pending[0]!.pendingId,
    } as never);
    // Before the fix the turn REJECTS here; swallow so the assertions, not an
    // unhandled rejection, are what report the regression.
    await turn.catch(() => {});

    // The turn ended with a session-scoped, aborted-classified error.
    const errs = of(sent, 'wrapper_error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.sessionId, 'the error names the session so the chat clears').toBeTruthy();
    expect(errs[0]!.kind).toBe('aborted');
    expect(errs[0]!.message.toLowerCase()).toContain('cancel');

    // The chat's "thinking" state is resolved: running flips to false for the
    // same session.
    const runs = of(sent, 'session_running').filter((m) => m.running === false);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sessionId).toBe(errs[0]!.sessionId);

    // And no orphan session row survives the cancel.
    expect(sessionRowCount()).toBe(0);
  });

  test('the sessionless dispatch fallback never fires for a cancel', async () => {
    // The defect's tell was a `wrapper_error` with no `sessionId` (the dispatch
    // catch's shape). runOneTurn now owns the classification, so every error it
    // emits on this path names its session.
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);

    const turn = handleClientMsg(conn, {
      type: 'send_message',
      projectId: project.id,
      text: 'hi',
    } as never);
    await tick();
    const pending = of(sent, 'mcp_auto_install_pending');
    expect(pending).toHaveLength(1);
    await handleClientMsg(conn, {
      type: 'cancel_gate',
      kind: 'mcp',
      pendingId: pending[0]!.pendingId,
    } as never);
    await turn.catch(() => {});

    const errs = of(sent, 'wrapper_error');
    // Exactly one error, and it names its session — before the fix runOneTurn
    // emitted none (it rejected) and the SESSIONLESS dispatch fallback carried
    // the report, so "exactly one, with a sessionId" fails in both directions
    // the defect could take.
    expect(errs).toHaveLength(1);
    expect(errs[0]!.sessionId, 'a sessionless error is the dispatch fallback firing').toBeTruthy();
  });
});
