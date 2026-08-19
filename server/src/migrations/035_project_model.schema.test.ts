// Schema pin for 035 (Cebab-ws0.3). Every migration since 023 ships one.
//
// The assertion that carries weight is the NULLABILITY one: `notnull = 0` and
// `dflt_value = null` together are what guarantee an upgraded database spawns
// exactly as it did before. A migration that shipped `NOT NULL DEFAULT
// 'default'` would apply cleanly, pass a round-trip test, and silently start
// sending every existing project a model it never asked for.
import { describe, expect, test } from 'vitest';
import { getDb } from '../db.js';
import { getProject, setProjectModel, upsertProject } from '../repo/projects.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

describe('035_project_model', () => {
  withTempDataDir('project-model');

  test('projects.model exists, is TEXT, nullable, with no default', () => {
    const cols = getDb().prepare<[], ColumnInfo>('PRAGMA table_info(projects)').all();
    const col = cols.find((c) => c.name === 'model');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBe(null);
  });

  test('a newly created project has no model', () => {
    const row = upsertProject('proj-a', '/tmp/proj-a');
    expect(row.model).toBe(null);
    expect(getProject(row.id)?.model).toBe(null);
  });

  test('round-trips a value and clears back to null', () => {
    const id = upsertProject('proj-b', '/tmp/proj-b').id;
    setProjectModel(id, 'opus[1m]');
    expect(getProject(id)?.model).toBe('opus[1m]');
    setProjectModel(id, null);
    expect(getProject(id)?.model).toBe(null);
  });

  test('the value is stored verbatim — no normalising, no case folding', () => {
    const id = upsertProject('proj-c', '/tmp/proj-c').id;
    for (const m of ['sonnet', 'claude-Fable-5[1m]', 'claude-opus-5[1m]']) {
      setProjectModel(id, m);
      expect(getProject(id)?.model).toBe(m);
    }
  });
});
