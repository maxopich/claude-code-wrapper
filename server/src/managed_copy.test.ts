// Cebab-ws0.9: the BE-1 dual-write contract for the copy, actually checked.
//
// The consequential act here is not "a directory appeared" — it is duplicating
// an agent's tree, credentials included, into a second location. So the audit
// row must land before any file content does, and a failed append must leave
// nothing behind: no tree, no project row, and no empty directory squatting on
// a name that a later copy would then have to disambiguate around.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from './config.js';
import { getDb } from './db.js';
import { managedAgentsRoot } from './managed_agent.js';
import { preflightManagedCopy, runManagedCopy } from './managed_copy.js';
import * as safetyAudit from './notifications/safety_audit.js';
import { listProjects, upsertProject } from './repo/projects.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

/** Every audit row in write order, genesis markers included — see
 *  `project_start_mode.test.ts` for why filtering by kind would hide a bug. */
function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}

function auditRowsSince(baseline: number): AuditRow[] {
  return auditRows().slice(baseline);
}

function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

/** A project with a small real tree behind it. */
function seedProject(root: string, name: string): number {
  const dir = path.join(root, name);
  write(path.join(dir, 'CLAUDE.md'), `# ${name}\n`);
  write(path.join(dir, '.claude', 'settings.json'), '{}');
  return upsertProject(name, dir).id;
}

function managedDirs(): string[] {
  try {
    return fs.readdirSync(managedAgentsRoot()).sort();
  } catch {
    return [];
  }
}

describe('preflightManagedCopy', () => {
  const tmp = withTempDataDir('managed-preflight');

  test('measures without writing anything', async () => {
    const id = seedProject(tmp.root(), 'measured');
    const sent: ServerMsg[] = [];
    await preflightManagedCopy(id, (m) => sent.push(m));

    const msg = sent.find((m) => m.type === 'managed_copy_preflight');
    expect(msg?.preflight?.files).toBe(2);
    expect(msg?.preflight?.overCap).toBe(false);
    // The whole point of a preflight.
    expect(managedDirs()).toEqual([]);
    expect(listProjects().filter((p) => p.managed_source_path !== null)).toEqual([]);
  });

  test('a project that has gone away answers null rather than throwing', async () => {
    const sent: ServerMsg[] = [];
    await preflightManagedCopy(999_999, (m) => sent.push(m));
    const msg = sent.find((m) => m.type === 'managed_copy_preflight');
    expect(msg?.preflight).toBe(null);
  });
});

describe('runManagedCopy', () => {
  const tmp = withTempDataDir('managed-copy-handler');

  test('copies, registers the copy, and records provenance', async () => {
    const id = seedProject(tmp.root(), 'source');
    const sent: ServerMsg[] = [];

    const outcome = await runManagedCopy(id, (m) => sent.push(m));
    expect(outcome.registered).toBe(true);

    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result.ok).toBe(true);
    if (!result || result.type !== 'managed_copy_result' || !result.result.ok) throw new Error('x');
    const ok = result.result;

    const managed = listProjects().find((p) => p.id === ok.managedProjectId);
    expect(managed?.managed_source_path).toBe(path.join(tmp.root(), 'source'));
    expect(managed?.managed_copied_at).toBeGreaterThan(0);
    // The snapshot is really on disk, and the original is untouched.
    expect(fs.readFileSync(path.join(managed!.path, 'CLAUDE.md'), 'utf8')).toBe('# source\n');
    expect(fs.existsSync(path.join(tmp.root(), 'source', 'CLAUDE.md'))).toBe(true);
  });

  test('the copy is named apart from its source rather than colliding', async () => {
    const id = seedProject(tmp.root(), 'twin');
    const sent: ServerMsg[] = [];
    await runManagedCopy(id, (m) => sent.push(m));
    const names = listProjects().map((p) => p.name);
    // `projects.name` is UNIQUE; the copy goes through the same disambiguation
    // every other project does rather than needing its own.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('twin');
  });

  test('a SECOND copy makes a second managed agent, leaving the first alone', async () => {
    // The operator's chosen shape. Nothing is overwritten and nothing refused.
    const id = seedProject(tmp.root(), 'again');
    const sent: ServerMsg[] = [];
    await runManagedCopy(id, (m) => sent.push(m));
    await runManagedCopy(id, (m) => sent.push(m));

    const managed = listProjects().filter((p) => p.managed_source_path !== null);
    expect(managed).toHaveLength(2);
    expect(new Set(managed.map((p) => p.path)).size).toBe(2);
    for (const p of managed) {
      expect(fs.existsSync(path.join(p.path, 'CLAUDE.md'))).toBe(true);
    }
  });

  test('emits one audit row BEFORE the copy, naming source and target', async () => {
    const id = seedProject(tmp.root(), 'audited');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];
    await runManagedCopy(id, (m) => sent.push(m));

    const rows = auditRowsSince(baseline);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('project.managed_copy_started');
    expect(rows[0].reason_code).toBe('managed_copy_started');
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload.sourcePath).toBe(path.join(tmp.root(), 'audited'));
    expect(String(payload.targetPath)).toContain(managedAgentsRoot());
  });

  test('[security] a failing audit append copies NOTHING and registers NOTHING', async () => {
    const id = seedProject(tmp.root(), 'refused');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      const outcome = await runManagedCopy(id, (m) => sent.push(m));
      expect(outcome.registered).toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(auditRowsSince(baseline)).toEqual([]);
    expect(listProjects().filter((p) => p.managed_source_path !== null)).toEqual([]);
    // And the directory claimed to name the target in the audit row is gone —
    // an empty squatter would push the next copy to `refused-2` for no reason.
    expect(managedDirs()).toEqual([]);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result.ok).toBe(false);
  });

  test('the positive control: the same copy succeeds when the audit works', async () => {
    // Without this, a handler that refused unconditionally would pass the case
    // above and ship a feature that never copies anything.
    const id = seedProject(tmp.root(), 'works');
    const sent: ServerMsg[] = [];
    const outcome = await runManagedCopy(id, (m) => sent.push(m));
    expect(outcome.registered).toBe(true);
    expect(managedDirs()).toContain('works');
  });

  test('a tree past the cap is refused, and NOTHING is written', async () => {
    // The refusal has to happen before the first byte, not after: the whole
    // point of the cap is that a mis-aimed copy cannot fill the disk. The
    // directory must not survive either — an empty squatter would push the next
    // copy of this project to `capped-2` for no reason.
    const dir = path.join(tmp.root(), 'capped');
    for (let i = 0; i < 20; i++) write(path.join(dir, `f${i}.txt`), 'x'.repeat(100));
    const id = upsertProject('capped', dir).id;
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const outcome = await runManagedCopy(id, (m) => sent.push(m), { maxBytes: 50, maxFiles: 2 });

    expect(outcome.registered).toBe(false);
    expect(managedDirs()).toEqual([]);
    // And no audit row: nothing consequential happened to record.
    expect(auditRowsSince(baseline)).toEqual([]);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result.ok).toBe(false);
    if (result?.type === 'managed_copy_result' && !result.result.ok) {
      expect(result.result.error).toContain('larger than Cebab will copy');
    }
  });

  test('control: the same tree under a generous cap copies', async () => {
    // Without this, a handler that refused every copy would pass the case above
    // and ship a feature that never works.
    const dir = path.join(tmp.root(), 'uncapped');
    for (let i = 0; i < 20; i++) write(path.join(dir, `f${i}.txt`), 'x'.repeat(100));
    const id = upsertProject('uncapped', dir).id;
    const sent: ServerMsg[] = [];
    const outcome = await runManagedCopy(id, (m) => sent.push(m), {
      maxBytes: 1024 * 1024,
      maxFiles: 1000,
    });
    expect(outcome.registered).toBe(true);
    expect(managedDirs()).toContain('uncapped');
  });

  test('the preflight reports the cap it was measured against', async () => {
    const dir = path.join(tmp.root(), 'reported');
    write(path.join(dir, 'f.txt'), 'x');
    const id = upsertProject('reported', dir).id;
    const sent: ServerMsg[] = [];
    await preflightManagedCopy(id, (m) => sent.push(m), { maxBytes: 77, maxFiles: 7 });
    const msg = sent.find((m) => m.type === 'managed_copy_preflight');
    expect(msg?.preflight?.maxBytes).toBe(77);
    expect(msg?.preflight?.maxFiles).toBe(7);
  });

  test('a project that has gone away fails cleanly', async () => {
    const sent: ServerMsg[] = [];
    const outcome = await runManagedCopy(999_999, (m) => sent.push(m));
    expect(outcome.registered).toBe(false);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result).toEqual({ ok: false, error: 'that project no longer exists' });
    expect(managedDirs()).toEqual([]);
  });

  test('progress messages carry the totals the preflight measured', async () => {
    const dir = path.join(tmp.root(), 'progressive');
    for (let i = 0; i < 4; i++) write(path.join(dir, `f${i}.txt`), 'x'.repeat(10));
    const id = upsertProject('progressive', dir).id;
    const sent: ServerMsg[] = [];
    await runManagedCopy(id, (m) => sent.push(m));

    // Throttled, so there may be none at all for a tiny tree — what is asserted
    // is that any that DO arrive are self-consistent, not that some arrive.
    for (const m of sent) {
      if (m.type !== 'managed_copy_progress') continue;
      expect(m.totalFiles).toBe(4);
      expect(m.files).toBeLessThanOrEqual(m.totalFiles);
    }
  });
});

describe('[security] a managed agent cannot be committed (Cebab-ws0.11)', () => {
  const tmp = withTempDataDir('managed-uncommittable');

  /**
   * The bead's bullet, as a property rather than a hope.
   *
   * Two separate mechanisms, and both are needed. The data dir's bare-`*`
   * `.gitignore` keeps an OUTER repository from staging anything under it. The
   * `.git` exclusion keeps the managed tree from being a repository of its own
   * — `gitignore(5)` consults parent ignore files only up to the top of the
   * working tree, so a copied `.git` puts a boundary between the managed agent
   * and the ignore file that was covering it, and git run from inside the copy
   * sees a repo with the ORIGINAL'S remotes.
   *
   * The second assertion is the one the exclusion buys; the first would pass
   * with `.git` copied, which is exactly why it is not the only one here.
   */
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  async function copiedInsideARepo(): Promise<{ repo: string; managed: string }> {
    const repo = tmp.root();
    git(repo, ['init', '-q']);
    const src = path.join(repo, 'source');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    // Assembled at runtime — see the sibling suite for why a literal would
    // weaken the repo's own secret scan.
    const filler = 'A1b2C3d4E5f6G7h8J9k0';
    write(path.join(src, '.mcp.json'), JSON.stringify({ k: filler + filler }));
    write(
      path.join(src, '.git', 'config'),
      '[remote "origin"]\n\turl = git@example.com:me/x.git\n',
    );
    write(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const id = upsertProject('source', src).id;
    const sent: ServerMsg[] = [];
    const outcome = await runManagedCopy(id, (m) => sent.push(m));
    expect(outcome.registered).toBe(true);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    if (!result || result.type !== 'managed_copy_result' || !result.result.ok) {
      throw new Error('copy did not succeed');
    }
    const ok = result.result;
    const managed = listProjects().find((p) => p.id === ok.managedProjectId)!.path;
    return { repo, managed };
  }

  test('git add -A in the surrounding checkout stages nothing from the copy', async () => {
    const { repo } = await copiedInsideARepo();
    git(repo, ['add', '-A']);
    const staged = git(repo, ['diff', '--cached', '--name-only']);
    expect(staged).not.toContain('.cebab');
    // Positive control: the SOURCE project is inside the same repo and does
    // get staged, so this is not passing because `git add` did nothing.
    expect(staged).toContain('source/CLAUDE.md');
  });

  test('negative control: without the data-dir gitignore, the copy IS staged', async () => {
    // Without this, a bug that made the managed tree empty would pass the
    // assertion above for the wrong reason.
    const { repo } = await copiedInsideARepo();
    fs.rmSync(path.join(config.dataDir, '.gitignore'));
    git(repo, ['add', '-A']);
    expect(git(repo, ['diff', '--cached', '--name-only'])).toContain('.cebab');
  });

  test('the managed tree is NOT a git repository of its own', async () => {
    // The assertion the `.git` exclusion buys. With `.git` copied this returns
    // the managed tree itself — a repository carrying the original's remotes,
    // outside the reach of the ignore file two levels up.
    const { repo, managed } = await copiedInsideARepo();
    const top = git(managed, ['rev-parse', '--show-toplevel']).trim();
    expect(fs.realpathSync(top)).toBe(fs.realpathSync(repo));
    expect(fs.existsSync(path.join(managed, '.git'))).toBe(false);
  });

  test('the copy carries no trace of the original remote', async () => {
    const { managed } = await copiedInsideARepo();
    // Belt for the assertion above: `.git/config` is where the push URL lives,
    // and it is on the redactor's credential-path list for that reason.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.isFile()) files.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(managed);
    expect(files.join('\n')).not.toContain('git@example.com');
  });
});
