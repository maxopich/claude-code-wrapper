/**
 * Cebab-ws0.10: reading and writing a managed agent's own config.
 *
 * The properties here are not all of equal weight. Two carry the feature:
 *
 *   - an UNMANAGED project is refused, which is the entire safety argument for
 *     shipping a file editor at all;
 *   - an over-cap file refuses to OPEN rather than opening truncated, because
 *     the operator would then save the head and lose the tail.
 *
 * The rest guard the shape: the audit lands before the bytes, it carries no
 * content, and a stale token does not overwrite a concurrent edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { getDb } from './db.js';
import { managedAgentsRoot } from './managed_agent.js';
import * as safetyAudit from './notifications/safety_audit.js';
import { upsertProject } from './repo/projects.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import {
  MANAGED_EDITABLE,
  MANAGED_FILE_KINDS,
  MAX_MANAGED_FILE_BYTES,
  readManagedFile,
  relPathIsContained,
  resolveManagedFile,
  writeManagedFile,
} from './managed_file.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}

const sink = (): void => {};

/** A real managed agent: a directory under `managedAgentsRoot()` plus its row.
 *  Managed-ness is decided by WHERE the path is, so nothing here sets a column. */
function makeManagedProject(name: string): { id: number; dir: string } {
  const dir = path.join(managedAgentsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  return { id: upsertProject(name, dir).id, dir };
}

function makeOrdinaryProject(name: string, root: string): { id: number; dir: string } {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { id: upsertProject(name, dir).id, dir };
}

describe('relPathIsContained', () => {
  // Tested directly rather than through `resolveManagedFile`, because every
  // input that function can supply is a constant that passes. Reaching it only
  // that way would be measuring the constant and calling it containment.
  test('rejects escapes, absolutes and the root itself', () => {
    for (const bad of ['..', '../x', 'a/../../x', '', '.', '/etc/passwd']) {
      expect(relPathIsContained(bad)).toBe(false);
    }
  });

  test('accepts ordinary nested paths', () => {
    for (const good of ['CLAUDE.md', '.mcp.json', '.claude/settings.json', 'a/b/c.json']) {
      expect(relPathIsContained(good)).toBe(true);
    }
  });

  test('every editable kind is contained — the guard on a future fourth entry', () => {
    for (const kind of MANAGED_FILE_KINDS) {
      expect(relPathIsContained(MANAGED_EDITABLE[kind])).toBe(true);
    }
    // And the set really is the three documented ones; a silent addition
    // should have to update this line and think about it.
    expect(MANAGED_FILE_KINDS.sort()).toEqual(['claude_md', 'mcp', 'settings']);
  });
});

describe('the managed gate', () => {
  const tmp = withTempDataDir('managed-file-gate');

  test('[security] an UNMANAGED project is refused for read AND write', () => {
    // The whole safety argument: Cebab owns every byte under the managed root
    // and none outside it. A gate on the read alone would leave the write open.
    const { id, dir } = makeOrdinaryProject('outside', tmp.root());
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original');

    expect(readManagedFile(id, 'claude_md')).toEqual({ ok: false, refusal: 'not_managed' });
    expect(writeManagedFile(id, 'claude_md', 'overwritten', 0, sink)).toEqual({
      ok: false,
      refusal: 'not_managed',
    });
    // And nothing was touched on the way to refusing.
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('original');
  });

  test('an unknown project and an unknown kind refuse distinctly', () => {
    const { id } = makeManagedProject('agent-kinds');
    expect(resolveManagedFile(999_999, 'mcp')).toEqual({ ok: false, refusal: 'unknown_project' });
    expect(resolveManagedFile(id, 'settings.local')).toEqual({
      ok: false,
      refusal: 'unknown_kind',
    });
    // The one that matters most: a path where a kind belongs is not a kind.
    expect(resolveManagedFile(id, '../../../etc/passwd')).toEqual({
      ok: false,
      refusal: 'unknown_kind',
    });
  });

  test('a managed agent whose directory was deleted still resolves, then fails on use', () => {
    // Managed-ness is about where a path IS, not whether it exists — the
    // distinction `isManagedProjectPath`'s header records. The honest order is
    // "yours to edit, and gone", not "not yours".
    const { id, dir } = makeManagedProject('agent-vanished');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(resolveManagedFile(id, 'mcp').ok).toBe(true);
    // An absent parent reads as an absent file, which is the create path.
    const r = readManagedFile(id, 'mcp');
    expect(r.ok && r.read.exists).toBe(false);
  });
});

describe('reading', () => {
  withTempDataDir('managed-file-read');

  test('an absent file opens empty and is marked absent', () => {
    const { id } = makeManagedProject('agent-absent');
    const r = readManagedFile(id, 'mcp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read).toMatchObject({ content: '', exists: false, mtimeMs: 0 });
  });

  test('an existing file comes back byte-for-byte with a concurrency token', () => {
    const { id, dir } = makeManagedProject('agent-read');
    // Deliberately ugly formatting: the editor shows raw bytes, so nothing may
    // reformat on the way through.
    const raw = '{\n  "mcpServers":{"a":{"command":"x"}}\n\n}\n';
    fs.writeFileSync(path.join(dir, '.mcp.json'), raw);
    const r = readManagedFile(id, 'mcp');
    expect(r.ok && r.read.content).toBe(raw);
    expect(r.ok && r.read.exists).toBe(true);
    expect(r.ok && r.read.mtimeMs).toBeGreaterThan(0);
  });

  test('an over-cap file REFUSES rather than opening truncated', () => {
    // `readFilePrefixBounded` here would be data loss, not a display nicety:
    // the operator edits the head and the save drops the tail. Swapping the
    // read for a prefix read reddens here.
    const { id, dir } = makeManagedProject('agent-huge');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'z'.repeat(MAX_MANAGED_FILE_BYTES + 1));
    expect(readManagedFile(id, 'claude_md')).toEqual({ ok: false, refusal: 'too_large' });
  });

  test('the sensitive flag follows pathLooksSensitive, not the editor guessing', () => {
    const { id } = makeManagedProject('agent-sensitive');
    const mcp = readManagedFile(id, 'mcp');
    const settings = readManagedFile(id, 'settings');
    const md = readManagedFile(id, 'claude_md');
    expect(mcp.ok && mcp.read.sensitive).toBe(true);
    expect(settings.ok && settings.read.sensitive).toBe(true);
    expect(md.ok && md.read.sensitive).toBe(false);
  });
});

describe('writing', () => {
  withTempDataDir('managed-file-write');

  test('creates a file that did not exist, and reports that it created it', () => {
    const { id, dir } = makeManagedProject('agent-create');
    const w = writeManagedFile(id, 'mcp', '{"mcpServers":{}}', 0, sink);
    expect(w.ok && w.created).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}');
  });

  test('creates the .claude directory when the copy did not bring one', () => {
    // An agent copied from a project with no `.claude/` would otherwise be
    // unable to gain a settings file from the UI at all.
    const { id, dir } = makeManagedProject('agent-mkdir');
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
    const w = writeManagedFile(id, 'settings', '{}', 0, sink);
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });

  test('malformed JSON refuses and leaves the file untouched', () => {
    const { id, dir } = makeManagedProject('agent-badjson');
    const p = path.join(dir, '.mcp.json');
    fs.writeFileSync(p, '{"ok":true}');
    const base = fs.statSync(p).mtimeMs;
    const w = writeManagedFile(id, 'mcp', '{"broken":', base, sink);
    expect(w.ok).toBe(false);
    expect(!w.ok && w.refusal).toBe('invalid_json');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"ok":true}');
  });

  test('CLAUDE.md is not parse-checked — it is not JSON', () => {
    const { id } = makeManagedProject('agent-md');
    expect(writeManagedFile(id, 'claude_md', '# Not { valid ] json', 0, sink).ok).toBe(true);
  });

  test('an empty JSON file is allowed — that is how you clear one', () => {
    const { id } = makeManagedProject('agent-empty');
    expect(writeManagedFile(id, 'mcp', '', 0, sink).ok).toBe(true);
  });

  test('a stale concurrency token refuses instead of overwriting', () => {
    const { id, dir } = makeManagedProject('agent-stale');
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, 'v1');
    const staleToken = fs.statSync(p).mtimeMs;
    // Somebody else writes in between. `utimesSync` rather than a sleep: the
    // point is that the mtime MOVED, and waiting for a real clock tick makes
    // the test slow and flaky on coarse filesystems.
    fs.writeFileSync(p, 'v2');
    fs.utimesSync(p, new Date(), new Date(staleToken + 5_000));

    const w = writeManagedFile(id, 'claude_md', 'v3', staleToken, sink);
    expect(!w.ok && w.refusal).toBe('stale');
    expect(fs.readFileSync(p, 'utf8')).toBe('v2');
  });

  test('over-cap content refuses and the file on disk is unchanged', () => {
    const { id, dir } = makeManagedProject('agent-toobig');
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, 'small');
    const base = fs.statSync(p).mtimeMs;
    const w = writeManagedFile(id, 'claude_md', 'z'.repeat(MAX_MANAGED_FILE_BYTES + 1), base, sink);
    expect(!w.ok && w.refusal).toBe('too_large');
    expect(fs.readFileSync(p, 'utf8')).toBe('small');
  });

  test('the returned token is the one a later write can use', () => {
    // A round trip: without this the concurrency check would refuse every
    // second save, which is worse than not having it.
    const { id } = makeManagedProject('agent-roundtrip');
    const first = writeManagedFile(id, 'claude_md', 'one', 0, sink);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(writeManagedFile(id, 'claude_md', 'two', first.mtimeMs, sink).ok).toBe(true);
  });
});

describe('[security] file modes and the audit row', () => {
  withTempDataDir('managed-file-audit');

  test.runIf(process.platform !== 'win32')(
    'credential-bearing kinds land at 0600, CLAUDE.md does not',
    () => {
      // `Cebab-ws0.11` gave these files 0600 at copy time. An edit that
      // relaxed the mode would undo that silently, on the file that holds the
      // token. Skipped on Windows, which has no POSIX mode bits to assert.
      const { id, dir } = makeManagedProject('agent-modes');
      writeManagedFile(id, 'mcp', '{}', 0, sink);
      writeManagedFile(id, 'settings', '{}', 0, sink);
      writeManagedFile(id, 'claude_md', 'hi', 0, sink);
      const mode = (p: string): number => fs.statSync(p).mode & 0o777;
      expect(mode(path.join(dir, '.mcp.json'))).toBe(0o600);
      expect(mode(path.join(dir, '.claude', 'settings.json'))).toBe(0o600);
      expect(mode(path.join(dir, 'CLAUDE.md'))).not.toBe(0o600);
    },
  );

  test('one audit row per write, naming the file and whether it existed', () => {
    const { id } = makeManagedProject('agent-audit');
    const baseline = auditRows().length;
    const first = writeManagedFile(id, 'mcp', '{"a":1}', 0, sink);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeManagedFile(id, 'mcp', '{"a":2}', first.mtimeMs, sink);

    const rows = auditRows().slice(baseline);
    expect(rows.map((r) => r.kind)).toEqual([
      'project.managed_file_edited',
      'project.managed_file_edited',
    ]);
    // Free-form strings on the dispatcher, so tsc cannot catch a typo here.
    expect(rows[0]!.reason_code).toBe('managed_file_edited');
    const payloads = rows.map((r) => JSON.parse(r.payload_json) as { existed: boolean });
    // Create then edit — the distinction a forensic reader needs and the one a
    // snapshot-shaped row would lose.
    expect(payloads.map((p) => p.existed)).toEqual([false, true]);
  });

  test('[security] no file CONTENT reaches the audit row', () => {
    // These are the files `pathLooksSensitive` names. An audit log quoting them
    // is the leak `Cebab-of0` closed, reopened from the other side. The secret
    // is assembled at runtime so the literal is not committed and cannot trip
    // the repo's own secret scan.
    const secret = ['sk', 'ant', 'managedfileeditor', 'THISMUSTNOTBELOGGED'].join('-');
    const { id } = makeManagedProject('agent-secret');
    const baseline = auditRows().length;
    writeManagedFile(id, 'mcp', JSON.stringify({ env: { API_KEY: secret } }), 0, sink);

    const rows = auditRows().slice(baseline);
    expect(rows).toHaveLength(1);
    // The whole row, not just the payload: title and message are stored too.
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(JSON.stringify(rows[0])).not.toContain('API_KEY');
    // The hash is what makes the row useful without the bytes.
    const payload = JSON.parse(rows[0]!.payload_json) as { sha256: string; bytes: number };
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.bytes).toBeGreaterThan(0);
  });

  test('[security] a failing audit append leaves the file UNWRITTEN', () => {
    // The BE-1 ordering contract. Invisible when both writes succeed, so the
    // only way to see it is to break one — and this is the direction that
    // matters: an authority change nobody recorded.
    const { id, dir } = makeManagedProject('agent-auditfail');
    const p = path.join(dir, '.mcp.json');
    fs.writeFileSync(p, '{"before":true}');
    const base = fs.statSync(p).mtimeMs;

    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    try {
      const w = writeManagedFile(id, 'mcp', '{"after":true}', base, sink);
      expect(!w.ok && w.refusal).toBe('audit_failed');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(p, 'utf8')).toBe('{"before":true}');
  });
});
