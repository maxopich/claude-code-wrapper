// Cebab-m1f: the managed-agent delete, and the BE-1 contract it destroys under.
//
// The consequential act here is not "a directory vanished" — it is destroying
// an agent's tree, its sessions, its events and its per-session JSONL logs,
// none of which come back. So the audit row must land before any of that goes,
// and a failed append must leave EVERYTHING behind: the tree, the rows and the
// logs. The positive controls next to each refusal stop a handler that refused
// unconditionally from passing while shipping a delete that never deletes.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from './config.js';
import { getDb } from './db.js';
import { managedAgentsRoot } from './managed_agent.js';
import { runManagedCopy } from './managed_copy.js';
import { runManagedDelete } from './managed_delete.js';
import * as safetyAudit from './notifications/safety_audit.js';
import { getProject, upsertProject } from './repo/projects.js';
import { createSession } from './repo/sessions.js';
import { registerQuery } from './runner/lifecycle.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}

function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

/** A source project with a small real tree behind it. */
function seedProject(root: string, name: string): number {
  const dir = path.join(root, name);
  write(path.join(dir, 'CLAUDE.md'), `# ${name}\n`);
  write(path.join(dir, '.claude', 'settings.json'), '{}');
  return upsertProject(name, dir).id;
}

/** Copy `name` into managed space and return the managed project's row id. */
async function makeManagedAgent(root: string, name: string): Promise<number> {
  const sourceId = seedProject(root, name);
  const sent: ServerMsg[] = [];
  await runManagedCopy(sourceId, (m) => sent.push(m));
  const result = sent.find((m) => m.type === 'managed_copy_result');
  if (!result || result.type !== 'managed_copy_result' || !result.result.ok) {
    throw new Error('copy did not succeed');
  }
  return result.result.managedProjectId;
}

/**
 * Give a managed agent one session with an event on disk and in the DB, plus
 * its `<id>.jsonl` log under the data dir. Returns the session id so a test can
 * check every trace of it is gone.
 */
function seedSession(projectId: number): string {
  const sid = `sess-${projectId}-${Math.abs(projectId * 7 + 1)}`;
  createSession(sid, projectId, 'a conversation');
  getDb()
    .prepare('INSERT INTO events (session_id, seq, ts, raw, type) VALUES (?, 1, 1, ?, ?)')
    .run(sid, '{"hello":true}', 'assistant');
  write(path.join(config.logsDir, `${sid}.jsonl`), '{"hello":true}\n');
  return sid;
}

function managedDirs(): string[] {
  try {
    return fs.readdirSync(managedAgentsRoot()).sort();
  } catch {
    return [];
  }
}

function eventCount(sid: string): number {
  return (
    getDb()
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
      .get(sid)?.n ?? 0
  );
}

describe('runManagedDelete', () => {
  const tmp = withTempDataDir('managed-delete');

  test('removes the tree, the sessions, the events and the logs, and drops the row', async () => {
    const managedId = await makeManagedAgent(tmp.root(), 'doomed');
    const managed = getProject(managedId)!;
    const managedPath = managed.path;
    const sid = seedSession(managedId);
    // Everything is really there first, or the assertions below prove nothing.
    expect(fs.existsSync(managedPath)).toBe(true);
    expect(eventCount(sid)).toBe(1);
    expect(fs.existsSync(path.join(config.logsDir, `${sid}.jsonl`))).toBe(true);

    const sent: ServerMsg[] = [];
    const outcome = await runManagedDelete(managedId, (m) => sent.push(m));
    expect(outcome.removed).toBe(true);

    // The row, the tree, the session, its events and its log are all gone.
    expect(getProject(managedId)).toBeUndefined();
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(managedDirs()).toEqual([]);
    expect(eventCount(sid)).toBe(0);
    expect(fs.existsSync(path.join(config.logsDir, `${sid}.jsonl`))).toBe(false);

    const result = sent.find((m) => m.type === 'managed_delete_result');
    expect(result?.result).toEqual({ ok: true, name: managed.name, sessionsRemoved: 1 });
  });

  test('emits one audit row BEFORE the act, naming the agent and its session count', async () => {
    const managedId = await makeManagedAgent(tmp.root(), 'audited');
    seedSession(managedId);
    const baseline = auditRows().length;

    await runManagedDelete(managedId, () => {});

    const rows = auditRows().slice(baseline);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('project.managed_delete_started');
    expect(rows[0].reason_code).toBe('managed_delete_started');
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(String(payload.path)).toContain(managedAgentsRoot());
    expect(payload.sessions).toBe(1);
  });

  test('[security] a failing audit append removes NOTHING', async () => {
    const managedId = await makeManagedAgent(tmp.root(), 'spared');
    const managedPath = getProject(managedId)!.path;
    const sid = seedSession(managedId);
    const baseline = auditRows().length;

    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('disk full');
    });
    let outcome;
    try {
      outcome = await runManagedDelete(managedId, () => {});
    } finally {
      spy.mockRestore();
    }

    expect(outcome.removed).toBe(false);
    expect(auditRows().slice(baseline)).toEqual([]);
    // Tree, row, session, events and log all still there.
    expect(getProject(managedId)).toBeDefined();
    expect(fs.existsSync(managedPath)).toBe(true);
    expect(eventCount(sid)).toBe(1);
    expect(fs.existsSync(path.join(config.logsDir, `${sid}.jsonl`))).toBe(true);
  });

  test('[security] an ordinary workspace project is refused, and its files are untouched', async () => {
    const sourceId = seedProject(tmp.root(), 'not-managed');
    const sourcePath = getProject(sourceId)!.path;

    const sent: ServerMsg[] = [];
    const outcome = await runManagedDelete(sourceId, (m) => sent.push(m));

    expect(outcome.removed).toBe(false);
    expect(getProject(sourceId)).toBeDefined();
    expect(fs.existsSync(path.join(sourcePath, 'CLAUDE.md'))).toBe(true);
    const result = sent.find((m) => m.type === 'managed_delete_result');
    expect(result?.result.ok).toBe(false);
    if (result?.type === 'managed_delete_result' && !result.result.ok) {
      expect(result.result.error).toContain('ordinary workspace project');
    }
  });

  test('a running session blocks the delete, and nothing is removed', async () => {
    const managedId = await makeManagedAgent(tmp.root(), 'busy');
    const managedPath = getProject(managedId)!.path;
    const stop = registerQuery(
      { close: () => {} },
      { sessionId: 'x', projectId: managedId, kind: 'single', startedAt: 0 },
    );
    try {
      const outcome = await runManagedDelete(managedId, () => {});
      expect(outcome.removed).toBe(false);
    } finally {
      stop();
    }
    // The refusal is before the audit, so nothing was destroyed.
    expect(getProject(managedId)).toBeDefined();
    expect(fs.existsSync(managedPath)).toBe(true);
  });

  test('a project that has gone away fails cleanly', async () => {
    const sent: ServerMsg[] = [];
    const outcome = await runManagedDelete(999_999, (m) => sent.push(m));
    expect(outcome.removed).toBe(false);
    const result = sent.find((m) => m.type === 'managed_delete_result');
    expect(result?.result).toEqual({ ok: false, error: 'that project no longer exists' });
  });
});
