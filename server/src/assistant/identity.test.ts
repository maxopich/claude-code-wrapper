import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getDb } from '../db.js';
import { getProject, upsertProject, type ProjectRow } from '../repo/projects.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import {
  ASSISTANT_MAX_TURNS,
  ASSISTANT_PROJECT_NAME,
  assistantKbRoot,
  ensureAssistantProject,
  isAssistantProject,
} from './identity.js';

function countAssistantRows(): number {
  return (
    getDb()
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE kind = 'assistant'`)
      .get()?.n ?? -1
  );
}

describe('assistant identity', () => {
  const tmp = withTempDataDir('assistant-identity');
  // A stable, arbitrary KB path. `ensureAssistantProject` uses it as the row's
  // `path`; it never stats it (existence is `assistantKbRoot`'s job), so it
  // need not exist on disk.
  const KB = '/tmp/cebab-assistant-kb';

  test('constants are fixed and structurally safe', () => {
    // The `/` is what makes the UNIQUE(name) collision with a scanned directory
    // impossible — a basename cannot contain one.
    expect(ASSISTANT_PROJECT_NAME).toBe('cebab/assistant');
    expect(ASSISTANT_PROJECT_NAME).toContain('/');
    expect(ASSISTANT_MAX_TURNS).toBe(12);
  });

  test('KB absent returns null and inserts nothing', () => {
    const before = getDb().prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM projects').get();
    expect(ensureAssistantProject(null)).toBe(null);
    const after = getDb().prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM projects').get();
    expect(after?.n).toBe(before?.n);
    expect(countAssistantRows()).toBe(0);
  });

  test('three calls yield exactly one row with a stable id', () => {
    const a = ensureAssistantProject(KB);
    const b = ensureAssistantProject(KB);
    const c = ensureAssistantProject(KB);
    expect(a).not.toBe(null);
    expect(a!.id).toBe(b!.id);
    expect(b!.id).toBe(c!.id);
    expect(countAssistantRows()).toBe(1);
    expect(a!.kind).toBe('assistant');
    expect(a!.name).toBe(ASSISTANT_PROJECT_NAME);
    expect(a!.path).toBe(KB);
    expect(isAssistantProject(a!)).toBe(true);
  });

  test('a drifted row is repaired in place with the SAME id', () => {
    const first = ensureAssistantProject(KB)!;
    // Simulate every kind of drift the row can suffer: a scan flips missing, an
    // operator toggles Trust, a bus install stamps its columns, the path moves.
    getDb()
      .prepare(
        `UPDATE projects
            SET trusted = 1, missing = 1, bus_installed = 1, bus_agent_name = 'agent-x', path = '/gone'
          WHERE id = ?`,
      )
      .run(first.id);

    const repaired = ensureAssistantProject(KB)!;
    expect(repaired.id).toBe(first.id);
    expect(repaired.trusted).toBe(0);
    expect(repaired.missing).toBe(0);
    expect(repaired.bus_installed).toBe(0);
    expect(repaired.bus_agent_name).toBe(null);
    expect(repaired.path).toBe(KB);
    expect(repaired.kind).toBe('assistant');
    expect(countAssistantRows()).toBe(1);
  });

  test('a pre-existing row at the KB path is repaired, never blind-inserted', () => {
    // The hazard: WORKSPACE_ROOT (or a scan) resolves such that an ordinary row
    // already sits at the KB path. A blind INSERT would raise UNIQUE(path)
    // inside the synchronous emitSettings. `ensureAssistantProject` must adopt
    // that row instead.
    const squatter = upsertProject('squatter', KB);
    expect(squatter.kind).toBe('workspace');

    const adopted = ensureAssistantProject(KB)!;
    expect(adopted.id).toBe(squatter.id);
    expect(adopted.kind).toBe('assistant');
    expect(adopted.name).toBe(ASSISTANT_PROJECT_NAME);
    expect(countAssistantRows()).toBe(1);
    // And nothing new was minted.
    expect(getProject(squatter.id)?.kind).toBe('assistant');
  });

  test('the kind lookup wins even when the path has moved', () => {
    const first = ensureAssistantProject(KB)!;
    // Path drifts, but the row is still kind='assistant'. A second call with a
    // DIFFERENT kbRoot must find it by kind (not path) and re-point it, not
    // insert a second assistant (which projects_kind_singleton would refuse).
    const KB2 = '/tmp/cebab-assistant-kb-moved';
    const again = ensureAssistantProject(KB2)!;
    expect(again.id).toBe(first.id);
    expect(again.path).toBe(KB2);
    expect(countAssistantRows()).toBe(1);
  });

  test('isAssistantProject reads only the kind', () => {
    expect(isAssistantProject({ kind: 'assistant' } as ProjectRow)).toBe(true);
    expect(isAssistantProject({ kind: 'workspace' } as ProjectRow)).toBe(false);
  });

  test('assistantKbRoot resolves to an existing kb directory or null', () => {
    void tmp; // the data dir isolation is unrelated to KB resolution
    const root = assistantKbRoot();
    if (root !== null) {
      expect(fs.existsSync(root)).toBe(true);
      expect(path.basename(root)).toBe('kb');
    }
  });
});
