import { describe, expect, test } from 'vitest';
import { ensureAssistantProject } from '../assistant/identity.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { getProject, listProjectPaths, listProjects, upsertProject } from './projects.js';

/**
 * Cebab-8x8.1.3: the scope filters that keep the Cebab-owned help assistant
 * (`kind = 'assistant'`) out of every sidebar list AND out of the missing
 * sweep, while `getProject(id)` still reaches it for the run path.
 */
describe('project kind scope filters', () => {
  withTempDataDir('project-kind-scope');
  const KB = '/tmp/cebab-kind-scope-kb';

  test('listProjects excludes the assistant but keeps workspace rows', () => {
    const workspace = upsertProject('ordinary', '/tmp/cebab-kind-scope-ordinary');
    const assistant = ensureAssistantProject(KB)!;

    const ids = listProjects().map((r) => r.id);
    expect(ids).toContain(workspace.id);
    expect(ids).not.toContain(assistant.id);
  });

  test('listProjectPaths excludes the assistant — so the sweep never marks it missing', () => {
    const workspace = upsertProject('ordinary', '/tmp/cebab-kind-scope-ordinary');
    const assistant = ensureAssistantProject(KB)!;

    const paths = listProjectPaths();
    expect(paths).toContain(workspace.path);
    // The assistant's path is never produced by the workspace scan, so if it
    // appeared here the sweep would flip it to missing = 1 on the next refresh.
    expect(paths).not.toContain(assistant.path);
  });

  test('getProject still reaches the assistant by id', () => {
    const assistant = ensureAssistantProject(KB)!;
    // Deliberately kept working: the run path, replay and interrupt resolve the
    // assistant by id even though every list hides it.
    expect(getProject(assistant.id)?.kind).toBe('assistant');
  });
});
