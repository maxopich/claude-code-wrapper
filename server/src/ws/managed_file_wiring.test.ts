/**
 * Cebab-ws0.10: the two WS verbs, and the cleanup a successful write owes.
 *
 * `managed_file.test.ts` proves the module decides correctly. What it cannot
 * say is that the handler is reached, that a refusal reaches the operator as a
 * reply rather than as silence, or that the stale authority snapshot beside the
 * editor is dropped afterwards — the step that is invisible when wrong: the
 * panel simply keeps reporting the declarations from before the edit, which
 * looks like the edit not having worked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { managedAgentsRoot } from '../managed_agent.js';
import { getProject, upsertProject } from '../repo/projects.js';
import { handleClientMsg } from './server.js';

let tmpRoot: string;
let originalDataDir: string;
let managedId: number;
let managedDir: string;
let ordinaryId: number;
let ordinaryDir: string;

type Conn = Parameters<typeof handleClientMsg>[0];

function makeConn(sent: ServerMsg[]): Conn {
  return {
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as ServerMsg) },
    authorityCache: new Map(),
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: { pending: new Map(), denyOnce: new Set() },
    busInstallGate: { pending: new Map(), denyOnce: new Set() },
  } as unknown as Conn;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mfw-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  managedDir = path.join(managedAgentsRoot(), 'ledger-agent');
  fs.mkdirSync(managedDir, { recursive: true });
  managedId = upsertProject('ledger-agent', managedDir).id;
  ordinaryDir = path.join(tmpRoot, 'my-repo');
  fs.mkdirSync(ordinaryDir, { recursive: true });
  ordinaryId = upsertProject('my-repo', ordinaryDir).id;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const of = <T extends ServerMsg['type']>(sent: ServerMsg[], type: T) =>
  sent.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];

describe('read_managed_file', () => {
  test('answers with the file for a managed agent', async () => {
    fs.writeFileSync(path.join(managedDir, 'CLAUDE.md'), '# agent');
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'read_managed_file',
      projectId: managedId,
      kind: 'claude_md',
    } as never);
    const [reply] = of(sent, 'managed_file');
    expect(reply!.result).toMatchObject({ ok: true, content: '# agent', exists: true });
  });

  test('an unmanaged project gets a REFUSAL, not silence', async () => {
    // A verb that answered nothing would leave the editor spinning forever,
    // which reads as a hang rather than as a boundary.
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'read_managed_file',
      projectId: ordinaryId,
      kind: 'claude_md',
    } as never);
    expect(of(sent, 'managed_file')[0]!.result).toEqual({ ok: false, refusal: 'not_managed' });
  });
});

describe('write_managed_file', () => {
  test('writes, replies, and re-emits the project list', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'write_managed_file',
      projectId: managedId,
      kind: 'mcp',
      content: '{"mcpServers":{}}',
      baseMtimeMs: 0,
    } as never);

    expect(of(sent, 'managed_file_written')[0]!.result).toMatchObject({ ok: true, created: true });
    expect(fs.readFileSync(path.join(managedDir, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}');
    // The re-emit is what re-runs `Cebab-ws0.6`'s per-project scan, so the
    // sidebar's declaration line reflects the file that was just written.
    expect(of(sent, 'projects')).toHaveLength(1);
  });

  test('a successful write DROPS the stale authority snapshot', async () => {
    // Invisible when wrong: the panel beside the editor keeps reporting the
    // declarations from before the edit, which looks like the edit failing.
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);
    conn.authorityCache.set(managedId, { capturedAt: 1, mcpServers: [] });
    conn.authorityCache.set(ordinaryId, { capturedAt: 1, mcpServers: [] });

    await handleClientMsg(conn, {
      type: 'write_managed_file',
      projectId: managedId,
      kind: 'mcp',
      content: '{}',
      baseMtimeMs: 0,
    } as never);

    expect(conn.authorityCache.has(managedId)).toBe(false);
    // Only the edited project's — clearing the whole map would make every
    // other panel re-probe for a file that did not change.
    expect(conn.authorityCache.has(ordinaryId)).toBe(true);
  });

  test('a REFUSED write leaves the snapshot and emits no project list', async () => {
    // Nothing changed on disk, so nothing downstream is stale. Re-emitting
    // anyway would be a scan per rejected keystroke-save.
    const sent: ServerMsg[] = [];
    const conn = makeConn(sent);
    conn.authorityCache.set(managedId, { capturedAt: 1, mcpServers: [] });

    await handleClientMsg(conn, {
      type: 'write_managed_file',
      projectId: managedId,
      kind: 'mcp',
      content: '{"broken":',
      baseMtimeMs: 0,
    } as never);

    expect(of(sent, 'managed_file_written')[0]!.result).toMatchObject({
      ok: false,
      refusal: 'invalid_json',
    });
    expect(conn.authorityCache.has(managedId)).toBe(true);
    expect(of(sent, 'projects')).toHaveLength(0);
  });

  test('[security] an unmanaged project cannot be written through the verb', async () => {
    const sent: ServerMsg[] = [];
    await handleClientMsg(makeConn(sent), {
      type: 'write_managed_file',
      projectId: ordinaryId,
      kind: 'claude_md',
      content: 'injected',
      baseMtimeMs: 0,
    } as never);
    expect(of(sent, 'managed_file_written')[0]!.result).toEqual({
      ok: false,
      refusal: 'not_managed',
    });
    expect(fs.existsSync(path.join(ordinaryDir, 'CLAUDE.md'))).toBe(false);
    // And the row really is the one we think it is.
    expect(getProject(ordinaryId)?.path).toBe(ordinaryDir);
  });
});
