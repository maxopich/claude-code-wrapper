// Cebab-ws0.9: the BE-1 dual-write contract for the copy, actually checked.
//
// The consequential act here is not "a directory appeared" — it is duplicating
// an agent's tree, credentials included, into a second location. So the audit
// row must land before any file content does, and a failed append must leave
// nothing behind: no tree, no project row, and no empty directory squatting on
// a name that a later copy would then have to disambiguate around.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from './config.js';
import { getDb } from './db.js';
import * as managedAgent from './managed_agent.js';
import { managedAgentsRoot } from './managed_agent.js';
import { preflightManagedCopy, runManagedCopy } from './managed_copy.js';
import * as safetyAudit from './notifications/safety_audit.js';
import {
  getProject,
  listProjects,
  setProjectStartPermissionMode,
  setProjectTrusted,
  upsertProject,
} from './repo/projects.js';
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

  test('[security] a copy of a TRUSTED source is trusted, and the audit row records it (Cebab-gkme)', async () => {
    // Cebab-gkme: a managed copy of a trusted project inherits the source's
    // Trust as a SNAPSHOT, so it loads its own `.claude/settings*` and
    // `.mcp.json` (hooks, env injections, `apiKeyHelper`) on its first session
    // and every bus hop instead of silently running as if untrusted.
    //
    // The flip is load-bearing: `seedProject` goes through `upsertProject`,
    // which hardcodes `trusted` 0, so WITHOUT this `setProjectTrusted` the case
    // would assert 0 === 0 and could never redden on a revert.
    const id = seedProject(tmp.root(), 'trusted-src');
    setProjectTrusted(id, true);
    // Cebab-yih6: a Trusted source that asks before every tool. The copy must
    // keep that, or it would auto-accept edits its original asks about.
    setProjectStartPermissionMode(id, 'default');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const outcome = await runManagedCopy(id, (m) => sent.push(m));
    expect(outcome.registered).toBe(true);

    // 7a — reddens on a revert: without the inheritance the copy reads back 0.
    const copy = listProjects().find((p) => p.managed_source_path !== null);
    expect(getProject(copy!.id)?.trusted).toBe(1);
    expect(getProject(copy!.id)?.start_permission_mode).toBe('default');

    // 7b — reddens on a revert: the field is `undefined` once it is gone.
    const rows = auditRowsSince(baseline);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload.sourceTrusted).toBe(true);
    expect(payload.sourceStartPermissionMode).toBe('default');
  });

  test('a copy of an UNTRUSTED source stays untrusted (Cebab-gkme control)', async () => {
    // 7c — the CONTROL. `expect(copy.trusted).toBe(0)` is today's behaviour
    // (`upsertProject` inserts `trusted` 0) and CANNOT redden on a revert, so it
    // is a pure control. The half that DOES redden is the audit payload:
    // `sourceTrusted` reads `undefined` once the field is removed.
    const id = seedProject(tmp.root(), 'untrusted-src');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const outcome = await runManagedCopy(id, (m) => sent.push(m));
    expect(outcome.registered).toBe(true);

    const copy = listProjects().find((p) => p.managed_source_path !== null);
    expect(getProject(copy!.id)?.trusted).toBe(0);
    // Control: a source with no starting mode gives a copy with none.
    expect(getProject(copy!.id)?.start_permission_mode).toBeNull();

    const rows = auditRowsSince(baseline);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload.sourceTrusted).toBe(false);
    expect(payload.sourceStartPermissionMode).toBeNull();
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

  test('[security] a copy that cannot be registered is removed, not left orphaned', async () => {
    // The tree copies successfully, then the project-row registration throws —
    // `upsertProject`'s name-disambiguation loop gives up after 20 tries. Its
    // catch must take the tree back, because a rowless managed directory holds
    // `.claude/credentials.json` in the clear and no delete verb will touch it.
    //
    // Seed the source `tpl` plus `tpl (2)`..`tpl (20)` so every disambiguation
    // candidate collides. The 19 fillers need distinct paths but not real
    // trees — `upsertProject` inserts by name and never stats the path.
    const id = seedProject(tmp.root(), 'tpl');
    for (let n = 2; n <= 20; n++) {
      upsertProject(`tpl (${n})`, path.join(tmp.root(), `filler-${n}`));
    }
    const sent: ServerMsg[] = [];

    // Capture the settled outcome rather than bare-awaiting, so a REVERTED fix
    // (the registration rejects) still reaches every assertion below instead of
    // aborting the case on the first rejection.
    const settled = await runManagedCopy(id, (m) => sent.push(m)).then(
      (outcome) => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(settled.ok).toBe(true);
    expect(settled.ok && settled.outcome.registered).toBe(false);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result.ok).toBe(false);
    // The orphan the fix exists to prevent: `claimManagedDir` runs once and
    // takes the first free slug `tpl`, so a reverted fix leaves it here.
    expect(managedDirs()).toEqual([]);
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

describe('[security] runManagedCopy refuses an incomplete copy (Cebab-6z6a)', () => {
  const tmp = withTempDataDir('managed-copy-incomplete');

  // A `copy_failed` skip is produced by making `fsp.copyFile` reject, NOT by a
  // chmod-based denial. `fsp` here is the same `node:fs` promises singleton
  // `managed_agent.ts` calls, so the spy intercepts the real copy. This is
  // deliberate and load-bearing: the first attempt at these tests denied read
  // with `chmod 000`, which root silently bypasses (DAC does not bind uid 0) —
  // so under the gate's root runner the cases SKIPPED and the revert-check saw
  // no added test redden. An injected rejection binds regardless of uid or OS.
  //
  // `mockRestore` in `finally` so a failed assertion cannot leave the spy in
  // place for the next test in the worker.
  function failCopyOn(match: (src: string) => boolean): ReturnType<typeof vi.spyOn> {
    const realCopyFile = fsp.copyFile.bind(fsp);
    return vi.spyOn(fsp, 'copyFile').mockImplementation((src, dest, mode?) => {
      if (match(String(src))) {
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      return realCopyFile(src, dest, mode as number | undefined);
    });
  }

  /** The last result message for a given project, ok/false either way. */
  function resultFor(sent: ServerMsg[], projectId: number) {
    for (let i = sent.length - 1; i >= 0; i--) {
      const m = sent[i];
      if (m.type === 'managed_copy_result' && m.projectId === projectId) return m;
    }
    return undefined;
  }

  // Each test pairs a case that MUST refuse (which reddens on revert — without
  // the guard the incomplete copy registers) with a case that MUST register
  // (the embedded anti-vacuity control, proving the refusal discriminates
  // rather than rejecting every `copy_failed`). Folding the control into the
  // same test is deliberate: the revert-check requires every ADDED test to
  // redden on revert, and a standalone control passes both ways — so it has to
  // ride on an assertion that does redden, or it silently fails the gate.

  test('[security] refuses a lost credential, but not a benign per-file failure', async () => {
    // `leaky` loses its `.env` (a credential) → refused. `mostly-fine` loses
    // only a non-sensitive build cache among healthy files → still registered,
    // which is the `Cebab-ygu.14` behaviour the refusal must not undo.
    const leaky = path.join(tmp.root(), 'leaky');
    write(path.join(leaky, 'CLAUDE.md'), '# leaky\n');
    write(path.join(leaky, 'src', 'index.ts'), 'export {}\n');
    write(path.join(leaky, '.env'), 'API_KEY=live\n');
    const leakyId = upsertProject('leaky', leaky).id;

    const fine = path.join(tmp.root(), 'mostly-fine');
    write(path.join(fine, 'CLAUDE.md'), '# fine\n');
    write(path.join(fine, 'src', 'a.ts'), 'export const a = 1\n');
    write(path.join(fine, 'src', 'b.ts'), 'export const b = 2\n');
    write(path.join(fine, 'build', 'cache.tmp'), 'x'.repeat(10));
    const fineId = upsertProject('mostly-fine', fine).id;

    const sent: ServerMsg[] = [];
    let leakyOut, fineOut;
    const spy = failCopyOn((src) => src.endsWith(`${path.sep}.env`) || src.endsWith('cache.tmp'));
    try {
      leakyOut = await runManagedCopy(leakyId, (m) => sent.push(m));
      fineOut = await runManagedCopy(fineId, (m) => sent.push(m));
    } finally {
      spy.mockRestore();
    }

    // Reddens on revert: a managed agent missing its `.env` looks configured
    // and is not, so it is never registered and its tree is removed.
    expect(leakyOut.registered).toBe(false);
    expect(managedDirs()).not.toContain('leaky');
    const leakyResult = resultFor(sent, leakyId);
    expect(leakyResult?.result.ok).toBe(false);
    if (leakyResult && !leakyResult.result.ok) {
      expect(leakyResult.result.error).toContain('.env');
      expect(leakyResult.result.error).toContain('credentials or settings');
    }

    // Embedded control: the benign failure registers, with the skip reported.
    expect(fineOut.registered).toBe(true);
    expect(managedDirs()).toContain('mostly-fine');
    const fineResult = resultFor(sent, fineId);
    expect(fineResult?.result.ok).toBe(true);
    if (fineResult && fineResult.result.ok) {
      expect(fineResult.result.skips.some((s) => s.reason === 'copy_failed')).toBe(true);
    }
  });

  test('[security] refuses a systemic failure, but registers a complete copy', async () => {
    // `doomed` loses every file (the ENOSPC/EACCES-on-target shape: had files,
    // none arrived) → refused. `complete` copies cleanly → registered.
    const doomed = path.join(tmp.root(), 'doomed');
    for (let i = 0; i < 5; i++) write(path.join(doomed, `f${i}.txt`), 'x'.repeat(20));
    const doomedId = upsertProject('doomed', doomed).id;

    const complete = path.join(tmp.root(), 'complete');
    write(path.join(complete, 'CLAUDE.md'), '# complete\n');
    write(path.join(complete, 'a.txt'), 'a\n');
    write(path.join(complete, 'b.txt'), 'b\n');
    const completeId = upsertProject('complete', complete).id;

    const sent: ServerMsg[] = [];
    let doomedOut, completeOut;
    // Fail everything under `doomed/`; leave `complete/` untouched.
    const spy = failCopyOn((src) => src.includes(`${path.sep}doomed${path.sep}`));
    try {
      doomedOut = await runManagedCopy(doomedId, (m) => sent.push(m));
      completeOut = await runManagedCopy(completeId, (m) => sent.push(m));
    } finally {
      spy.mockRestore();
    }

    // Reddens on revert: an essentially empty tree is never registered.
    expect(doomedOut.registered).toBe(false);
    expect(managedDirs()).not.toContain('doomed');
    const doomedResult = resultFor(sent, doomedId);
    expect(doomedResult?.result.ok).toBe(false);
    if (doomedResult && !doomedResult.result.ok) {
      expect(doomedResult.result.error).toContain('most of the tree');
    }

    // Embedded control: a fully-successful copy registers.
    expect(completeOut.registered).toBe(true);
    expect(managedDirs()).toContain('complete');
  });

  test('[security] an ordinary source file with a credential-shaped NAME is not config, and does not destroy the copy', async () => {
    // The refusal deletes a finished tree, so its predicate has to be narrow.
    // `pathLooksSensitive` — the redactor's — is deliberately wide: it matches
    // any basename whose stem is `token`, `secret`, `credentials`, `key` or
    // `pem`, which covers `src/token.ts`, `ui/Secret.tsx` and
    // `node_modules/marked/lib/token.js`. Erring wide is right for redaction
    // and wrong here: one transient failure on a file with an unlucky name
    // would discard the whole copy, which is the class `Cebab-ygu.14` closed.
    //
    // Reddens against a refusal keyed on `pathLooksSensitive`: `named` loses
    // only such files and MUST still register; `real` loses actual agent
    // config and MUST still refuse, so the case cannot pass by refusing
    // nothing.
    const named = path.join(tmp.root(), 'named');
    write(path.join(named, 'CLAUDE.md'), '# named\n');
    write(path.join(named, 'src', 'token.ts'), 'export const t = 1\n');
    write(path.join(named, 'src', 'a.ts'), 'export const a = 1\n');
    write(path.join(named, 'node_modules', 'marked', 'token.js'), 'module.exports = {}\n');
    const namedId = upsertProject('named', named).id;

    const real = path.join(tmp.root(), 'real-config');
    write(path.join(real, 'CLAUDE.md'), '# real\n');
    write(path.join(real, 'src', 'a.ts'), 'export const a = 1\n');
    write(path.join(real, '.mcp.json'), '{"mcpServers":{}}\n');
    const realId = upsertProject('real-config', real).id;

    const sent: ServerMsg[] = [];
    let namedOut, realOut;
    const spy = failCopyOn(
      (src) =>
        src.endsWith(`${path.sep}token.ts`) ||
        src.endsWith(`${path.sep}token.js`) ||
        src.endsWith(`${path.sep}.mcp.json`),
    );
    try {
      namedOut = await runManagedCopy(namedId, (m) => sent.push(m));
      realOut = await runManagedCopy(realId, (m) => sent.push(m));
    } finally {
      spy.mockRestore();
    }

    expect(namedOut.registered).toBe(true);
    expect(managedDirs()).toContain('named');
    const namedResult = resultFor(sent, namedId);
    expect(namedResult?.result.ok).toBe(true);
    if (namedResult && namedResult.result.ok) {
      // Still REPORTED — not refusing is not the same as staying quiet.
      expect(namedResult.result.skips.some((s) => s.rel.endsWith('token.ts'))).toBe(true);
    }

    // The discriminating half: real agent config still refuses.
    expect(realOut.registered).toBe(false);
    expect(managedDirs()).not.toContain('real-config');
    const realResult = resultFor(sent, realId);
    expect(realResult?.result.ok).toBe(false);
    if (realResult && !realResult.result.ok) {
      expect(realResult.result.error).toContain('.mcp.json');
    }
  });

  test('[security] the ratio clause refuses on its own, with more failures than arrivals', async () => {
    // The systemic predicate has two clauses and the `doomed` fixture above
    // satisfies BOTH, so neither is discriminated by it — measured: deleting
    // either clause leaves that test green. This case isolates the ratio half:
    // one file arrives, two do not, so `survey.files > 0 && copied.files === 0`
    // is FALSE and only `missing.length > copied.files` can refuse.
    const lopsided = path.join(tmp.root(), 'lopsided');
    write(path.join(lopsided, 'keep.txt'), 'kept\n');
    write(path.join(lopsided, 'lose-1.txt'), 'x\n');
    write(path.join(lopsided, 'lose-2.txt'), 'y\n');
    const lopsidedId = upsertProject('lopsided', lopsided).id;

    // The control for the other direction: two arrive, one does not, so the
    // ratio does NOT trip and the copy registers with its skip reported. A
    // refusal rule that fired on any failure would redden here.
    const majority = path.join(tmp.root(), 'majority');
    write(path.join(majority, 'keep-1.txt'), 'a\n');
    write(path.join(majority, 'keep-2.txt'), 'b\n');
    write(path.join(majority, 'lose-1.txt'), 'c\n');
    const majorityId = upsertProject('majority', majority).id;

    const sent: ServerMsg[] = [];
    let lopsidedOut, majorityOut;
    const spy = failCopyOn((src) => src.includes(`${path.sep}lose-`));
    try {
      lopsidedOut = await runManagedCopy(lopsidedId, (m) => sent.push(m));
      majorityOut = await runManagedCopy(majorityId, (m) => sent.push(m));
    } finally {
      spy.mockRestore();
    }

    expect(lopsidedOut.registered).toBe(false);
    expect(managedDirs()).not.toContain('lopsided');
    const lopsidedResult = resultFor(sent, lopsidedId);
    expect(lopsidedResult?.result.ok).toBe(false);
    if (lopsidedResult && !lopsidedResult.result.ok) {
      expect(lopsidedResult.result.error).toContain('most of the tree');
    }

    expect(majorityOut.registered).toBe(true);
    expect(managedDirs()).toContain('majority');
  });
});

describe('[security] runManagedCopy re-enforces the cap through copyTree (Cebab-6fax.43.4)', () => {
  const tmp = withTempDataDir('managed-copy-cap-passthrough');

  test('[security] a tree that grew past the survey is refused mid-copy, and nothing is registered', async () => {
    // The survey runs before `claimManagedDir` creates the target, so it cannot
    // see a tree that grows before the copy reaches it. Here the growth is
    // simulated by making the survey UNDER-report (overCap:false, a tiny count)
    // while the real tree on disk exceeds the caps `runManagedCopy` forwards to
    // `copyTree`. If those caps were NOT passed through, the copy would run
    // unbounded and register — which is what this reddens against.
    const dir = path.join(tmp.root(), 'grew');
    for (let i = 0; i < 20; i++) write(path.join(dir, `f${i}.txt`), 'x'.repeat(100));
    const id = upsertProject('grew', dir).id;

    const spy = vi.spyOn(managedAgent, 'surveyTree').mockResolvedValue({
      bytes: 100,
      files: 1,
      dirs: 1,
      symlinks: 0,
      skips: [],
      credentialFiles: [],
      largest: [],
      overCap: false,
    });

    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];
    let outcome;
    try {
      // Tight caps the real 2,000-byte tree blows past, but the mocked survey
      // does not — so the survey's own cap check passes and the copy's does not.
      outcome = await runManagedCopy(id, (m) => sent.push(m), { maxBytes: 250, maxFiles: 100_000 });
    } finally {
      spy.mockRestore();
    }

    expect(outcome.registered).toBe(false);
    // The partial tree was removed, so nothing squats on the slug or the disk.
    expect(managedDirs()).toEqual([]);
    expect(listProjects().filter((p) => p.managed_source_path !== null)).toEqual([]);
    const result = sent.find((m) => m.type === 'managed_copy_result');
    expect(result?.result.ok).toBe(false);
    if (result?.type === 'managed_copy_result' && !result.result.ok) {
      expect(result.result.error).toContain('exceeded the cap');
    }

    // The copy got as far as the audit-before-write row (that is by design — the
    // directory has to be NAMEABLE before the copy starts), so exactly the
    // `managed_copy_started` row lands and there is no separate refusal row.
    const rows = auditRowsSince(baseline);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('project.managed_copy_started');
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
    // The assertion the `.git` exclusion buys. With `.git` copied, git run from
    // inside the copy sees a repository carrying the original's remotes, and
    // one that sits outside the reach of the ignore file two levels up.
    //
    // `--show-prefix`, not `--show-toplevel`. It reports where we are RELATIVE
    // to the top of the enclosing worktree: empty at the top, non-empty in a
    // subdirectory. So it states the claim directly — "this is inside some
    // repo, not the top of one" — with no path to normalise. The first version
    // compared `--show-toplevel` against the repo path and went red on Windows
    // only, where `os.tmpdir()` hands back the 8.3 short name (`RUNNER~1`) and
    // git returns the long one; `realpathSync` does not reconcile those, and
    // the trap is already documented two files over.
    const { managed } = await copiedInsideARepo();
    expect(git(managed, ['rev-parse', '--show-prefix']).trim()).not.toBe('');
    expect(fs.existsSync(path.join(managed, '.git'))).toBe(false);
  });

  test('control: the enclosing repo IS at the top of itself', async () => {
    // Anti-vacuity for the assertion above — if `--show-prefix` returned
    // something non-empty everywhere, it would pass without meaning anything.
    const { repo } = await copiedInsideARepo();
    expect(git(repo, ['rev-parse', '--show-prefix']).trim()).toBe('');
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
