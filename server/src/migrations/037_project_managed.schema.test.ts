// Schema pin for 037 (Cebab-ws0.9). Every migration since 023 ships one.
//
// These columns are PROVENANCE, not the managed flag, and the tests below are
// written to keep that true. `isManagedProjectPath` answers "is this managed?"
// from where the directory sits; if a later edit ever routes that question
// through `managed_source_path` instead, the last case here goes red — a
// project sitting in the operator's workspace with a hand-written source path
// must not be treated as managed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { isManagedProjectPath, managedAgentsRoot } from '../managed_agent.js';
import { getProject, registerManagedProject, upsertProject } from '../repo/projects.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

describe('037_project_managed', () => {
  const tmp = withTempDataDir('project-managed');

  test('both columns are nullable with no default', () => {
    // A `NOT NULL DEFAULT` on either would apply cleanly and then claim every
    // project on the machine was copied by Cebab at the epoch.
    const cols = getDb().prepare<[], ColumnInfo>('PRAGMA table_info(projects)').all();
    for (const [name, type] of [
      ['managed_source_path', 'TEXT'],
      ['managed_copied_at', 'INTEGER'],
    ] as const) {
      const col = cols.find((c) => c.name === name);
      expect({ name, found: col !== undefined }).toEqual({ name, found: true });
      expect({ name, type: col?.type }).toEqual({ name, type });
      expect({ name, notnull: col?.notnull }).toEqual({ name, notnull: 0 });
      expect({ name, dflt: col?.dflt_value }).toEqual({ name, dflt: null });
    }
  });

  test('an ordinary project has neither', () => {
    const row = upsertProject('plain', path.join(tmp.root(), 'plain'));
    expect(row.managed_source_path).toBe(null);
    expect(row.managed_copied_at).toBe(null);
  });

  test('registerManagedProject stores provenance and returns the fresh row', () => {
    const target = path.join(managedAgentsRoot(), 'copied');
    fs.mkdirSync(target, { recursive: true });
    const row = registerManagedProject('copied', target, '/somewhere/source', 1_700_000_000_000);
    expect(row.managed_source_path).toBe('/somewhere/source');
    expect(row.managed_copied_at).toBe(1_700_000_000_000);
    expect(getProject(row.id)?.managed_source_path).toBe('/somewhere/source');
  });

  test('the managed predicate reads the PATH, not the columns', () => {
    // Both directions, because each failure looks like the feature working.
    const managedDir = path.join(managedAgentsRoot(), 'real');
    fs.mkdirSync(managedDir, { recursive: true });
    const managed = registerManagedProject('real', managedDir, '/src', 1);
    expect(isManagedProjectPath(managed.path)).toBe(true);

    // Clearing the provenance does NOT make a managed agent stop being managed
    // — it still lives in the data dir, and the missing-sweep exemption still
    // has to apply or the row is soft-deleted out from under a live directory.
    getDb().prepare('UPDATE projects SET managed_source_path = NULL WHERE id = ?').run(managed.id);
    expect(isManagedProjectPath(getProject(managed.id)!.path)).toBe(true);

    // And a workspace project cannot buy itself the exemption by claiming to
    // have been copied.
    const workspaceDir = path.join(tmp.root(), 'not-managed');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const plain = upsertProject('not-managed', workspaceDir);
    getDb()
      .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = 1 WHERE id = ?')
      .run('/anything', plain.id);
    expect(isManagedProjectPath(getProject(plain.id)!.path)).toBe(false);
  });

  test('a sibling directory sharing the root prefix is not managed', () => {
    // `<dataDir>/agents-old` shares a string prefix with `<dataDir>/agents`.
    // `isInside` is `path.relative`-based precisely so this is not inside it.
    const sibling = path.join(config.dataDir, 'agents-old', 'x');
    fs.mkdirSync(sibling, { recursive: true });
    expect(isManagedProjectPath(sibling)).toBe(false);
  });

  test('the managed root itself is not a managed agent', () => {
    // Strictness matters here: treating the root as managed would exempt it
    // from the sweep as a project, and it is a container, not an agent.
    fs.mkdirSync(managedAgentsRoot(), { recursive: true });
    expect(isManagedProjectPath(managedAgentsRoot())).toBe(false);
  });

  test('control: os.tmpdir is not inside the data dir', () => {
    // Anti-vacuity for the negatives above — if `isManagedProjectPath` simply
    // returned false always, every negative here would pass and the positive
    // at the top is the only thing standing.
    expect(isManagedProjectPath(os.tmpdir())).toBe(false);
  });
});
