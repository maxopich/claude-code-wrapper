// Schema pin for 036 (Cebab-ws0.4). Every migration since 023 ships one.
//
// The NULLABILITY assertion is the one carrying weight. A migration that
// shipped `NOT NULL DEFAULT 'default'` would apply cleanly, pass a round-trip
// test, and silently make every project on the machine start raising a
// permission card on its first tool call; `DEFAULT 'acceptEdits'` would
// silently make every UNTRUSTED project start auto-allowing file edits. NULL
// is the only value that means "nothing changed".
import { describe, expect, test } from 'vitest';
import { getDb } from '../db.js';
import {
  getProject,
  resolveStartPermissionMode,
  setProjectStartPermissionMode,
  upsertProject,
} from '../repo/projects.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

describe('036_project_start_permission_mode', () => {
  withTempDataDir('start-permission-mode');

  test('projects.start_permission_mode is TEXT, nullable, with no default', () => {
    const cols = getDb().prepare<[], ColumnInfo>('PRAGMA table_info(projects)').all();
    const col = cols.find((c) => c.name === 'start_permission_mode');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBe(null);
  });

  test('a newly created project has no starting mode', () => {
    const row = upsertProject('sp-a', '/tmp/sp-a');
    expect(row.start_permission_mode).toBe(null);
    expect(getProject(row.id)?.start_permission_mode).toBe(null);
  });

  test('round-trips both modes and clears back to null', () => {
    const id = upsertProject('sp-b', '/tmp/sp-b').id;
    setProjectStartPermissionMode(id, 'acceptEdits');
    expect(getProject(id)?.start_permission_mode).toBe('acceptEdits');
    setProjectStartPermissionMode(id, 'default');
    expect(getProject(id)?.start_permission_mode).toBe('default');
    setProjectStartPermissionMode(id, null);
    expect(getProject(id)?.start_permission_mode).toBe(null);
  });

  test('[security] a hand-edited row cannot smuggle a wider SDK mode into a spawn', () => {
    // The column is plain TEXT with no CHECK, matching 004's. `bypassPermissions`
    // and `plan` are real SDK modes that Cebab deliberately never exposes; the
    // read-side guard is what keeps one out of `Options.permissionMode` if it
    // ever appears in the database.
    const id = upsertProject('sp-c', '/tmp/sp-c').id;
    for (const smuggled of ['bypassPermissions', 'plan', 'dontAsk', 'auto', '', 'ACCEPTEDITS']) {
      getDb()
        .prepare('UPDATE projects SET start_permission_mode = ? WHERE id = ?')
        .run(smuggled, id);
      expect({
        smuggled,
        resolved: resolveStartPermissionMode(getProject(id)?.start_permission_mode),
      }).toEqual({ smuggled, resolved: undefined });
    }
  });

  test('the two legal values still resolve — the guard is not simply rejecting everything', () => {
    // Positive control for the test above: a filter that returned undefined
    // unconditionally would pass every assertion there and break the feature.
    expect(resolveStartPermissionMode('default')).toBe('default');
    expect(resolveStartPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(resolveStartPermissionMode(null)).toBe(undefined);
    expect(resolveStartPermissionMode(undefined)).toBe(undefined);
  });
});
