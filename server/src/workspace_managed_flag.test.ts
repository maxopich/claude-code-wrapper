/**
 * Cebab-ws0.10: `Project.isManaged` answers from the PATH, and `Project.managed`
 * does not answer the same question.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The first version of the config-editor
 * affordance gated on `managed`, which reads as the obvious field and is
 * `non-null` only when the structural predicate holds AND the provenance
 * columns are populated. The server's own gate is the predicate alone. The two
 * therefore disagree in both directions that matter — an affordance hidden from
 * a project that would accept a write, and (through the copy row's inverse
 * test) "copy into Cebab" offered for an agent already inside Cebab.
 *
 * It survived a passing jsdom suite because those fixtures CONSTRUCT `managed`,
 * and was caught in a browser against a seeded agent. This pins the property
 * that made the browser disagree with the tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getDb } from './db.js';
import { managedAgentsRoot } from './managed_agent.js';
import { upsertProject } from './repo/projects.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { rowToProject, setWorkspaceRoot, syncWorkspaceProjects } from './workspace.js';

describe('isManaged is structural', () => {
  const tmp = withTempDataDir('workspace-managed-flag');

  /** A workspace root is required before `syncWorkspaceProjects` returns
   *  anything — the sweep is driven by it, and managed rows ride along via
   *  their exemption from it. */
  function useWorkspace(): string {
    const ws = path.join(tmp.root(), 'ws');
    fs.mkdirSync(ws, { recursive: true });
    setWorkspaceRoot(ws);
    return ws;
  }

  async function listed(): Promise<{ name: string; isManaged: boolean; managed: unknown }[]> {
    // Through `rowToProject`, which is what `sendProjects` puts on the wire —
    // asserting on the DB rows wouldmeasure  the columns and not the answer.
    const projects = (await syncWorkspaceProjects()).map(rowToProject);
    return projects.map((p) => ({ name: p.name, isManaged: p.isManaged, managed: p.managed }));
  }

  test('a managed agent with NO provenance is still isManaged', () => {
    // The exact divergence. `managed` is null here — no source path, no copied
    // timestamp — and the server would accept a config write, so the UI must
    // offer one.
    useWorkspace();
    const dir = path.join(managedAgentsRoot(), 'no-provenance');
    fs.mkdirSync(dir, { recursive: true });
    upsertProject('no-provenance', dir);

    return listed().then((rows) => {
      const row = rows.find((r) => r.name === 'no-provenance')!;
      expect(row.isManaged).toBe(true);
      expect(row.managed).toBe(null);
    });
  });

  test('an ordinary project with hand-written provenance columns is NOT isManaged', () => {
    // The other direction, and the one migration 037's own comment warns about:
    // a row cannot be edited into claiming Cebab owns it.
    const dir = path.join(useWorkspace(), 'pretender');
    fs.mkdirSync(dir, { recursive: true });
    const id = upsertProject('pretender', dir).id;
    getDb()
      .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = ? WHERE id = ?')
      .run('/somewhere/else', 1, id);

    return listed().then((rows) => {
      const row = rows.find((r) => r.name === 'pretender')!;
      expect(row.isManaged).toBe(false);
      // And the provenance is withheld too, which is the ws0.9 behaviour this
      // must not have disturbed.
      expect(row.managed).toBe(null);
    });
  });

  test('a fully-registered managed agent has both', () => {
    useWorkspace();
    const dir = path.join(managedAgentsRoot(), 'complete');
    fs.mkdirSync(dir, { recursive: true });
    const id = upsertProject('complete', dir).id;
    getDb()
      .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = ? WHERE id = ?')
      .run('/work/complete', 42, id);

    return listed().then((rows) => {
      const row = rows.find((r) => r.name === 'complete')!;
      expect(row.isManaged).toBe(true);
      expect(row.managed).toEqual({ sourcePath: '/work/complete', copiedAt: 42 });
    });
  });
});
