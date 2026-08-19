/**
 * [security] Cebab-ws0.13 — listing and deleting leftover session folders.
 *
 * The delete path takes an operator-supplied name and ends in `fsp.rm(...,
 * {recursive: true})`, so the interesting assertions are not about the response
 * envelope. They are about the filesystem afterwards: an executor that deleted
 * everything and reported refusals would satisfy every envelope check in here,
 * which is why each refusal case also asserts the folder is STILL ON DISK.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { createMultiAgentSession } from './repo/multi_agent.js';
import { registerQuery } from './runner/lifecycle.js';
import { setWorkspaceRoot } from './workspace.js';
import {
  deleteStraySessionFolders,
  scanStraySessionFolders,
  sessionIdFromLegacyName,
} from './stray_session_folders.js';

const isWindows = process.platform === 'win32';
/** Unprivileged symlink creation fails on Windows; named so the skip is visible. */
const posixOnly = isWindows ? test.skip : test;

let tmpRoot: string;
let workspace: string;
let originalDataDir: string;

/** Create a legacy-shaped session folder with one file in it. */
function makeFolder(id: string, bytes = 16): string {
  const dir = path.join(workspace, `.cebab-session-${id}`);
  fs.mkdirSync(path.join(dir, 'iterations', '001'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'iterations', '001', 'final.md'), 'x'.repeat(bytes));
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-stray-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  closeDb();
  getDb();
  workspace = path.join(tmpRoot, 'agents');
  fs.mkdirSync(workspace, { recursive: true });
  setWorkspaceRoot(workspace);
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sessionIdFromLegacyName', () => {
  test('extracts the id, and rejects everything else', () => {
    expect(sessionIdFromLegacyName('.cebab-session-abc-123')).toBe('abc-123');
    expect(sessionIdFromLegacyName('.cebab-session-')).toBeNull();
    expect(sessionIdFromLegacyName('cebab-session-abc')).toBeNull();
    expect(sessionIdFromLegacyName('MyProject')).toBeNull();
  });
});

describe('scanStraySessionFolders', () => {
  test('lists only legacy session folders, with sizes and reference status', async () => {
    makeFolder('orphan', 32);
    const referenced = makeFolder('kept', 16);
    createMultiAgentSession('kept', 'chain', '001', referenced);
    // Decoys that must NOT appear: a real project, and a lookalike with no dot.
    fs.mkdirSync(path.join(workspace, 'RealAgent'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'cebab-session-nodot'), { recursive: true });

    const res = await scanStraySessionFolders();
    const names = res.folders.map((f) => f.name).sort();
    expect(names).toEqual(['.cebab-session-kept', '.cebab-session-orphan']);
    expect(res.workspaceRoot).toBe(workspace);
    expect(res.truncated).toBe(false);

    const byName = new Map(res.folders.map((f) => [f.name, f]));
    // The orphan is deletable; the referenced one is listed for its cost only.
    expect(byName.get('.cebab-session-orphan')!.sessionStatus).toBeNull();
    expect(byName.get('.cebab-session-kept')!.sessionStatus).toBe('running');
    expect(byName.get('.cebab-session-orphan')!.sizeBytes).toBeGreaterThan(
      byName.get('.cebab-session-kept')!.sizeBytes,
    );
  });

  test('an unreadable or missing workspace reports zero folders, not a throw', async () => {
    setWorkspaceRoot(workspace);
    fs.rmSync(workspace, { recursive: true, force: true });
    await expect(scanStraySessionFolders()).resolves.toMatchObject({ folders: [] });
  });
});

describe('[security] deleteStraySessionFolders', () => {
  test('deletes an orphan and reports the bytes it freed', async () => {
    const dir = makeFolder('gone', 64);
    const res = await deleteStraySessionFolders(['.cebab-session-gone']);
    expect(res.deleted).toEqual(['.cebab-session-gone']);
    expect(res.failed).toEqual([]);
    expect(res.freedBytes).toBeGreaterThanOrEqual(64);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('refuses a folder a session row still points at — and leaves it ON DISK', async () => {
    const dir = makeFolder('kept');
    createMultiAgentSession('kept', 'chain', '001', dir);

    const res = await deleteStraySessionFolders(['.cebab-session-kept']);
    expect(res.deleted).toEqual([]);
    expect(res.failed[0]).toMatchObject({ reason: 'referenced' });
    // The assertion that matters. Checking only the envelope above would pass
    // an executor that deleted the folder and reported a refusal.
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('refuses a RUNNING session even with no row pointing at the folder', async () => {
    const dir = makeFolder('live');
    // Running is decided by what is in flight, not by the DB row — a stale or
    // re-rooted session_folder cannot defeat this guard, which is the whole
    // reason it does not consult the row.
    const unregister = registerQuery(
      { close: () => {} },
      {
        sessionId: 'live',
        kind: 'orchestrator',
        startedAt: Date.now(),
      },
    );
    try {
      const res = await deleteStraySessionFolders(['.cebab-session-live']);
      expect(res.failed[0]).toMatchObject({ reason: 'running' });
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      unregister();
    }
  });

  test('processes a mixed batch per-name instead of failing the whole request', async () => {
    const orphan = makeFolder('a');
    const kept = makeFolder('b');
    createMultiAgentSession('b', 'chain', '001', kept);

    const res = await deleteStraySessionFolders([
      '.cebab-session-a',
      '.cebab-session-b',
      '.cebab-session-missing',
      'not-a-session-folder',
    ]);
    expect(res.deleted).toEqual(['.cebab-session-a']);
    expect(res.failed.map((f) => f.reason).sort()).toEqual([
      'bad_name',
      'referenced',
      'unresolvable',
    ]);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  test.each([
    ['a traversal', '../../etc'],
    ['an absolute path', path.join(path.sep, 'etc')],
    ['a plain project directory', 'RealAgent'],
  ])('refuses %s without touching anything', async (_label, name) => {
    fs.mkdirSync(path.join(workspace, 'RealAgent'), { recursive: true });
    const res = await deleteStraySessionFolders([name]);
    expect(res.deleted).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(fs.existsSync(path.join(workspace, 'RealAgent'))).toBe(true);
  });

  posixOnly('refuses a symlink shaped like a session folder, target intact', async () => {
    const precious = path.join(tmpRoot, 'precious');
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, 'keep.txt'), 'do not delete me');
    fs.symlinkSync(precious, path.join(workspace, '.cebab-session-evil'), 'dir');

    const res = await deleteStraySessionFolders(['.cebab-session-evil']);
    expect(res.failed[0]).toMatchObject({ reason: 'symlink' });
    expect(fs.existsSync(path.join(precious, 'keep.txt'))).toBe(true);
  });

  test('writes ONE audit row for the deletions, and none for refusals', async () => {
    makeFolder('x');
    makeFolder('y');
    const kept = makeFolder('z');
    createMultiAgentSession('z', 'chain', '001', kept);

    await deleteStraySessionFolders(['.cebab-session-x', '.cebab-session-y', '.cebab-session-z']);
    const rows = getDb()
      .prepare<[], { kind: string; payload_json: string }>(
        "SELECT kind, payload_json FROM safety_audit WHERE kind = 'session.stray_folders_deleted'",
      )
      .all();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json) as { names: string[]; count: number };
    expect(payload.names.sort()).toEqual(['.cebab-session-x', '.cebab-session-y']);
    expect(payload.count).toBe(2);
    // Names and counts only. An audit row is append-only and outlives the
    // session, so it must not embed the operator's home directory.
    expect(rows[0]!.payload_json).not.toContain(workspace);
  });

  test('writes NO audit row when every name was refused', async () => {
    const kept = makeFolder('only');
    createMultiAgentSession('only', 'chain', '001', kept);
    await deleteStraySessionFolders(['.cebab-session-only']);
    const n = getDb()
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM safety_audit WHERE kind = 'session.stray_folders_deleted'",
      )
      .get()!.c;
    expect(n).toBe(0);
  });
});
