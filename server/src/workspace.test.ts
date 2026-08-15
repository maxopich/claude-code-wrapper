/**
 * Register H12 — what may become a workspace root.
 *
 * `setWorkspaceRoot` had no coverage at all, which is how it kept accepting
 * `/`. The stored root drives `syncWorkspaceProjects`, and that `upsertProject`s
 * every non-dot subdirectory — so the accepted value decides which directories
 * become agent projects, each one a `cwd` a session can be pointed at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { findProjectByPath, listProjects, upsertProject } from './repo/projects.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { resolveWorkspaceRoot, setWorkspaceRoot, syncWorkspaceProjects } from './workspace.js';

withTempDataDir('cebab-workspace-');

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ws-root-'));
});

describe('setWorkspaceRoot accepts a real directory', () => {
  test('an existing directory is resolved and stored', () => {
    const nested = path.join(scratch, 'agents');
    fs.mkdirSync(nested);
    expect(setWorkspaceRoot(nested)).toBe(path.resolve(nested));
    expect(resolveWorkspaceRoot()).toBe(path.resolve(nested));
  });

  test('a deep path under home is fine — only the bare home directory is refused', () => {
    // The guard must not turn into "nothing under ~", which would reject the
    // documented `~/agents` shape it exists to protect.
    const under = path.join(scratch, 'code', 'agents');
    fs.mkdirSync(under, { recursive: true });
    expect(() => setWorkspaceRoot(under)).not.toThrow();
  });
});

describe('setWorkspaceRoot refuses what it cannot mean', () => {
  test('a missing path and a file are both refused', () => {
    expect(() => setWorkspaceRoot(path.join(scratch, 'nope'))).toThrow(/directory not found/);
    const file = path.join(scratch, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => setWorkspaceRoot(file)).toThrow(/not a directory/);
  });

  test('[security] a non-string is refused by type, not by a TypeError deep inside', () => {
    // This used to reach `expandHome`, where `p.startsWith('~')` threw — and
    // the WS handler reported that to the operator as the claude process
    // having crashed.
    for (const bad of [123, null, undefined, {}, [], true]) {
      expect(() => setWorkspaceRoot(bad as unknown as string), String(bad)).toThrow(
        /must be a string/,
      );
    }
    expect(() => setWorkspaceRoot('   ')).toThrow(/must not be empty/);
  });

  test('[security] the filesystem root is refused', () => {
    const root = path.parse(process.cwd()).root;
    expect(() => setWorkspaceRoot(root)).toThrow(/filesystem root/);
  });

  test('[security] the home directory itself is refused', () => {
    expect(() => setWorkspaceRoot(os.homedir())).toThrow(/home directory/);
    // `~` expands to the same place, and must be refused by the same rule
    // rather than sneaking past because the string differs.
    expect(() => setWorkspaceRoot('~')).toThrow(/home directory/);
  });

  test('[security] a refused root is not persisted', () => {
    const ok = path.join(scratch, 'agents');
    fs.mkdirSync(ok);
    setWorkspaceRoot(ok);
    expect(() => setWorkspaceRoot(os.homedir())).toThrow();
    // The throw must leave the previous good value in place — a half-applied
    // change here would silently repoint every future session's project scan.
    expect(resolveWorkspaceRoot()).toBe(path.resolve(ok));
  });

  test('[security] a symlink to home is refused as home', () => {
    // The refusals compare canonical paths, so an indirection cannot walk
    // past them. Skipped where symlink creation needs privileges (Windows
    // without Developer Mode).
    const link = path.join(scratch, 'home-link');
    try {
      fs.symlinkSync(os.homedir(), link, 'dir');
    } catch {
      return;
    }
    expect(() => setWorkspaceRoot(link)).toThrow(/home directory/);
  });
});

/**
 * Register D16 — a duplicate basename must not take the scan down with it.
 *
 * `upsertProject` looks up by `path` but `projects.name` is UNIQUE, so two
 * directories sharing a basename under DIFFERENT roots collided on INSERT.
 * The throw was not a one-time abort: `syncWorkspaceProjects` runs on every
 * `list_projects`, so it re-hit the same row on every sidebar refresh and the
 * operator got a permanently empty sidebar. The trigger is a supported action
 * — repointing the workspace root, whose old rows keep their names.
 */
describe('syncWorkspaceProjects survives a colliding basename', () => {
  test('a repointed root with a colliding basename still registers the project', async () => {
    const oldPath = path.join(scratch, 'old-root', 'Cebab');
    upsertProject('Cebab', oldPath); // the row the previous root left behind

    const newRoot = path.join(scratch, 'new-root');
    fs.mkdirSync(path.join(newRoot, 'Cebab'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();

    const fresh = findProjectByPath(path.join(newRoot, 'Cebab'));
    expect(fresh, 'the colliding directory must still become a project').toBeDefined();
    expect(fresh!.name).toBe('Cebab (2)');
    expect(listProjects().map((p) => p.name)).toContain('Cebab (2)');
  });

  test('the disambiguated name is stable across rescans', async () => {
    const oldPath = path.join(scratch, 'old-root', 'Cebab');
    upsertProject('Cebab', oldPath);

    const newRoot = path.join(scratch, 'new-root');
    fs.mkdirSync(path.join(newRoot, 'Cebab'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();
    await syncWorkspaceProjects();
    await syncWorkspaceProjects();

    // Path lookup runs before the insert, so a rescan finds the row and never
    // re-derives its name — no `Cebab (3)`, no second row.
    expect(findProjectByPath(path.join(newRoot, 'Cebab'))!.name).toBe('Cebab (2)');
    expect(listProjects().filter((p) => p.name.startsWith('Cebab'))).toHaveLength(1);
  });

  test('the collision does not stop the rest of the scan', async () => {
    const goneRoot = path.join(scratch, 'old-root');
    upsertProject('Cebab', path.join(goneRoot, 'Cebab'));
    upsertProject('Vanished', path.join(goneRoot, 'Vanished'));

    const newRoot = path.join(scratch, 'new-root');
    // `Alpha` sorts before `Cebab`, `Zulu` after — so a scan that aborts on
    // the collision is distinguishable from one that never started.
    for (const d of ['Alpha', 'Cebab', 'Zulu']) {
      fs.mkdirSync(path.join(newRoot, d), { recursive: true });
    }
    setWorkspaceRoot(newRoot);

    const rows = await syncWorkspaceProjects();

    const names = rows.map((p) => p.name).sort();
    expect(names).toEqual(['Alpha', 'Cebab (2)', 'Zulu']);
    // `markProjectsMissingByPaths` runs AFTER the loop, so this also proves
    // the loop completed rather than throwing partway.
    expect(findProjectByPath(path.join(goneRoot, 'Vanished'))!.missing).toBe(1);
  });

  test('a non-colliding basename is untouched by the disambiguation path', async () => {
    const newRoot = path.join(scratch, 'plain-root');
    fs.mkdirSync(path.join(newRoot, 'Solo'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();

    // Control: the fix must not append a suffix to every project.
    expect(findProjectByPath(path.join(newRoot, 'Solo'))!.name).toBe('Solo');
  });
});
