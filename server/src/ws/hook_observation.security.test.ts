import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { HookView, ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import { verifyChain } from '../notifications/safety_audit.js';
import { gateProjectsForSpawn, reportHookObservations } from './server.js';
import { makeTrustGateState } from '../repo/mcp_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { BUS_SETTING_SCOPES } from '../repo/project_authority.js';

// F6: the spawn path's hook reporter. `hook_trust.test.ts` covers the ledger's
// identity and change rules; this covers the half that makes them visible —
// the hash-chained audit row and the operator notification.
//
// The audit row is the obligation here, not the notification. A hook runs
// whether or not a browser is attached, so the forensic record has to exist
// even when nobody is looking; that is why this goes through the dispatcher's
// safety class (audit written BEFORE the WS send, BE-1) rather than a bare
// `send`.

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-hook-obs-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude', 'hooks'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function hook(over: Partial<HookView> = {}): HookView {
  return {
    hookKind: 'PreToolUse',
    scope: 'project',
    scopePath: path.join(projectDir, '.claude', 'settings.json'),
    command: './.claude/hooks/guard.sh',
    ...over,
  };
}

function auditRows() {
  return getDb()
    .prepare<[], { kind: string; reason_code: string; payload_json: string }>(
      "SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind LIKE 'hook.%' ORDER BY ts ASC, rowid ASC",
    )
    .all();
}

function collect() {
  const sent: ServerMsg[] = [];
  return { sent, send: (m: ServerMsg) => sent.push(m) };
}

describe('[security] reportHookObservations', () => {
  test('a first-seen hook writes an audit row AND notifies', () => {
    fs.writeFileSync(path.join(projectDir, '.claude/hooks/guard.sh'), 'echo ok');
    const { sent, send } = collect();

    reportHookObservations(projectId, [hook()], send);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('hook.first_seen');
    expect(rows[0]!.reason_code).toBe('first_seen');
    const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
    // The payload has to name what would run, where it was declared, and what
    // it hashed to — a row saying only "a hook was seen" is not a forensic
    // record of anything.
    expect(payload).toMatchObject({
      projectId,
      hookKind: 'PreToolUse',
      command: './.claude/hooks/guard.sh',
    });
    expect(payload.scriptSha).toMatch(/^[0-9a-f]{64}$/);

    const notes = sent.filter((m) => m.type === 'notification');
    expect(notes).toHaveLength(1);
    // Hooks bypass tool approval entirely; the copy must say so rather than
    // leaving the operator to assume the usual gate applies.
    expect(JSON.stringify(notes[0])).toContain('not gated by tool approval');
  });

  test('a changed script is reported at higher severity than a new hook', () => {
    const script = path.join(projectDir, '.claude/hooks/guard.sh');
    fs.writeFileSync(script, 'original');
    const first = collect();
    reportHookObservations(projectId, [hook()], first.send);

    fs.writeFileSync(script, 'rm -rf /');
    const second = collect();
    reportHookObservations(projectId, [hook()], second.send);

    const rows = auditRows();
    expect(rows.map((r) => r.kind)).toEqual(['hook.first_seen', 'hook.script_changed']);
    const payload = JSON.parse(rows[1]!.payload_json) as Record<string, unknown>;
    // Both hashes, so the operator can tell which version they approved.
    expect(payload.previousScriptSha).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.scriptSha).not.toBe(payload.previousScriptSha);

    const note = second.sent.find((m) => m.type === 'notification') as
      (ServerMsg & { severity: string }) | undefined;
    // A script rewritten under a command the operator already approved is a
    // stronger signal than a new hook they are about to read for the first
    // time — it is the shape a supply-chain change takes.
    expect(note?.severity).toBe('danger');
  });

  test('the audit chain still verifies after reporting', () => {
    fs.writeFileSync(path.join(projectDir, '.claude/hooks/guard.sh'), 'x');
    const { send } = collect();
    reportHookObservations(projectId, [hook(), hook({ hookKind: 'Stop', command: 'jq .' })], send);
    expect(verifyChain()).toMatchObject({ ok: true });
  });

  test('steady state is silent — no rows, no notifications', () => {
    fs.writeFileSync(path.join(projectDir, '.claude/hooks/guard.sh'), 'x');
    reportHookObservations(projectId, [hook()], collect().send);
    const second = collect();
    reportHookObservations(projectId, [hook()], second.send);
    expect(second.sent).toEqual([]);
    expect(auditRows()).toHaveLength(1);
  });

  test('no hooks and a missing project are both no-ops', () => {
    const a = collect();
    reportHookObservations(projectId, [], a.send);
    const b = collect();
    reportHookObservations(999_999, [hook()], b.send);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
});

describe('[security] gateProjectsForSpawn wires the hook reporter', () => {
  // Without this, deleting the one call line in `gateProjectsForSpawn` leaves
  // every unit test above green while the feature is completely inert — the
  // ledger stops being written and no hook is ever reported again. The unit
  // tests prove the reporter works; only this proves it RUNS.
  test('a spawn against a project with hooks writes the audit row', async () => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude/hooks/guard.sh'), 'echo ok');
    fs.writeFileSync(
      path.join(projectDir, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: './.claude/hooks/guard.sh' }] }],
        },
      }),
    );

    // Minimal Conn: `send` short-circuits on a non-OPEN socket, and the audit
    // row is written before the send, so the WS output is not needed here.
    const conn = {
      ws: { readyState: 0 } as unknown as never,
      authorityCache: new Map(),
      trustGate: makeTrustGateState(),
      startGate: makeStartGateState(),
    } as unknown as Parameters<typeof gateProjectsForSpawn>[0];

    await gateProjectsForSpawn(conn, [projectId], BUS_SETTING_SCOPES);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('hook.first_seen');
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      hookKind: 'PreToolUse',
      command: './.claude/hooks/guard.sh',
    });
  });
});
